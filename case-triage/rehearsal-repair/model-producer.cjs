'use strict';
/*
 * Generic model-producer adapter for the source-only repair controller.
 *
 * The producer command is supplied by MODEL_PRODUCER_CMD as a JSON argv
 * array. Use {prompt} as the argument placeholder, for example:
 *
 *   MODEL_PRODUCER_CMD='["some-cli","-p","{prompt}"]' \
 *     node model-producer.cjs --prompt model-prompt.md --out out/model
 *
 * Repair generation additionally requires MODEL_PRODUCER_SANDBOX_CMD: a JSON
 * argv prefix that confines the producer (for example a bubblewrap or
 * sandbox-exec invocation). It must contain {workspace}, which is replaced by
 * a disposable working directory outside the repository, and the producer
 * command is appended after the prefix. Before any generation the adapter
 * proves the confinement: it must deny reading the authored patch, deny
 * writing beside controller-owned files, and allow writing in {workspace}.
 * Without a passing sandbox the run is blocked and no patch is accepted.
 *
 * The adapter never builds or accepts a patch. It captures the producer
 * result, requires a unified git diff, re-checks controller-owned files for
 * modification, runs the controller allowlist, and applies only in a
 * disposable copy to enumerate actual changed paths before writing the
 * candidate.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {verifyPatch, verifyPatchInTree, patchPaths} = require('./repair-controller.cjs');
const {buildPrompt} = require('./model-input.cjs');

const here = __dirname;
const SCHEMA = 'near-rehearsal/model-producer/v1';
const DEFAULT_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'];

// Controller-owned files whose contents must not change while a producer runs.
const OWNED_FILES = [
  'repair-controller.cjs',
  'controller-manifest.json',
  'model-input.cjs',
  'model-producer.cjs',
  'model-producer-tests.cjs',
  'acceptance.cjs',
  'acceptance-tests.cjs',
  'candidate-identity.cjs',
  'repair-pipeline.cjs',
  'model-prompt.md',
  'repair.patch',
  'README.md',
];

function usage() {
  return [
    'usage: node model-producer.cjs [options]',
    '',
    '  --preflight          check authentication/model availability only',
    '  --prompt <file>      task prompt file (default: model-prompt.md)',
    '  --source <dir>       pinned source tree (required except preflight)',
    '  --out <dir>          output directory (default: out/model-producer)',
    '  --timeout-ms <n>     command timeout (default: 120000)',
    '',
    'MODEL_PRODUCER_CMD must be a JSON argv array; use {prompt} where the',
    'prompt text should be inserted.',
    '',
    'MODEL_PRODUCER_SANDBOX_CMD is required for repair generation: a JSON argv',
    'prefix containing {workspace} that confines reads of controller files and',
    'writes outside the disposable workspace. The prefix is probed before use',
    'and the run is blocked if the probe fails.',
    '',
    'MODEL_PRODUCER_ENV optionally lists extra environment variable names to',
    'pass to the producer; only PATH, LANG, LC_ALL, TMPDIR and that explicit',
    'list are inherited.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {preflight: false, prompt: path.join(here, 'model-prompt.md'), source: process.env.REPAIR_SOURCE_DIR || null, out: path.join(here, 'out', 'model-producer'), timeoutMs: 120000};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--preflight') opts.preflight = true;
    else if (arg === '--prompt') opts.prompt = path.resolve(argv[++i]);
    else if (arg === '--source') opts.source = path.resolve(argv[++i]);
    else if (arg === '--out') opts.out = path.resolve(argv[++i]);
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');
  return opts;
}

function parseArgvJson(raw, name) {
  let argv;
  try {
    argv = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(argv) || !argv.length || argv.some((part) => typeof part !== 'string') || !argv[0]) {
    throw new Error(`${name} must be a non-empty JSON string array with an executable`);
  }
  return argv;
}

function producerArgv(env = process.env) {
  const raw = env.MODEL_PRODUCER_CMD;
  if (!raw) throw new Error('MODEL_PRODUCER_CMD is required');
  return parseArgvJson(raw, 'MODEL_PRODUCER_CMD');
}

function sandboxArgv(env = process.env) {
  const raw = env.MODEL_PRODUCER_SANDBOX_CMD;
  if (!raw) return null;
  const argv = parseArgvJson(raw, 'MODEL_PRODUCER_SANDBOX_CMD');
  if (!argv.some((part) => part.includes('{workspace}'))) {
    throw new Error('MODEL_PRODUCER_SANDBOX_CMD must reference {workspace}');
  }
  return argv;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashOwned(root) {
  const hashes = {};
  for (const name of OWNED_FILES) {
    const file = path.join(root, name);
    hashes[name] = fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
  }
  return hashes;
}

function changedOwned(before, after) {
  return Object.keys(before).filter((name) => before[name] !== after[name]);
}

function producerEnv(env = process.env) {
  let extra = [];
  try {
    extra = env.MODEL_PRODUCER_ENV ? JSON.parse(env.MODEL_PRODUCER_ENV) : [];
  } catch (error) {
    throw new Error(`MODEL_PRODUCER_ENV is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(extra) || extra.some((key) => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
    throw new Error('MODEL_PRODUCER_ENV must be a JSON array of environment variable names');
  }
  const keys = new Set([...DEFAULT_ENV_KEYS, ...extra]);
  const out = {};
  for (const key of keys) if (env[key] !== undefined) out[key] = env[key];
  return out;
}

function materialize(argv, prompt) {
  const placeholder = argv.includes('{prompt}');
  const args = argv.map((part) => part === '{prompt}' ? prompt : part);
  return {argv: args, stdin: placeholder ? undefined : prompt};
}

function runCommand(argv, {cwd, timeoutMs = 120000, input, env = process.env} = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  const error = timedOut ? `command timed out after ${timeoutMs}ms` : (result.error ? result.error.message : '');
  return {
    argv,
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal || null,
    timedOut,
    stdout,
    stderr,
    error: error || (result.status === 0 ? '' : (stderr.trim() || stdout.trim() || `producer exited ${result.status}`)),
  };
}

function runProducer(argv, prompt, {cwd = process.cwd(), timeoutMs = 120000, env = process.env} = {}) {
  const call = materialize(argv, prompt);
  return runCommand(call.argv, {cwd, timeoutMs, input: call.stdin, env: producerEnv(env)});
}

function makeWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'near-rehearsal-producer-'));
  const relative = path.relative(path.resolve(here, '..', '..'), workspace);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    fs.rmSync(workspace, {recursive: true, force: true});
    throw new Error('producer workspace must be outside the repository');
  }
  return workspace;
}

/*
 * Prove the sandbox confines the producer before trusting it:
 *  - reading the authored patch must fail
 *  - creating a file beside controller-owned files must fail
 *  - writing inside the disposable workspace must succeed
 */
function probeSandbox(prefix, {workspace, sentinel, ownedDir, timeoutMs = 30000, env = process.env}) {
  const writeMarker = path.join(workspace, 'sandbox-write-probe.txt');
  const intruder = path.join(ownedDir, '.sandbox-write-probe');
  fs.rmSync(writeMarker, {force: true});
  fs.rmSync(intruder, {force: true});

  const writeProbe = runCommand([...prefix, 'sh', '-c', 'printf ok > "$1"', 'sh', writeMarker], {cwd: workspace, timeoutMs, env});
  const readProbe = runCommand([...prefix, 'sh', '-c', 'cat "$1" >/dev/null 2>&1', 'sh', sentinel], {cwd: workspace, timeoutMs, env});
  const intrudeProbe = runCommand([...prefix, 'sh', '-c', 'printf ok > "$1"', 'sh', intruder], {cwd: workspace, timeoutMs, env});

  const workspaceWriteOk = writeProbe.exitCode === 0 && fs.existsSync(writeMarker);
  const controllerReadDenied = readProbe.exitCode !== 0;
  const controllerWriteDenied = intrudeProbe.exitCode !== 0 && !fs.existsSync(intruder);
  fs.rmSync(writeMarker, {force: true});
  fs.rmSync(intruder, {force: true});

  const errors = [];
  if (!workspaceWriteOk) errors.push('sandbox probe could not write inside the disposable workspace');
  if (!controllerReadDenied) errors.push('sandbox probe could read the authored patch');
  if (!controllerWriteDenied) errors.push('sandbox probe could write beside controller-owned files');
  return {
    ok: errors.length === 0,
    errors,
    workspaceWriteOk,
    controllerReadDenied,
    controllerWriteDenied,
    exitCodes: {write: writeProbe.exitCode, read: readProbe.exitCode, intrude: intrudeProbe.exitCode},
  };
}

function extractDiff(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('producer output is empty');
  if (text.includes('```')) throw new Error('producer output contains a markdown fence');
  if (!text.startsWith('diff --git ')) throw new Error('producer output is not a unified git diff');
  return `${text}\n`;
}

function reportStem(mode) {
  return mode === 'preflight' ? 'preflight' : 'result';
}

function writeReport(outDir, report, patch) {
  fs.mkdirSync(outDir, {recursive: true});
  const stem = reportStem(report.mode);
  const patchFile = path.join(outDir, `${stem}.patch`);
  if (patch) fs.writeFileSync(patchFile, patch);
  else fs.rmSync(patchFile, {force: true});
  const file = path.join(outDir, `${stem}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

function baseReport({mode, argv = [], result = null}) {
  return {
    schema: SCHEMA,
    mode,
    command: argv,
    exitCode: result ? result.exitCode : null,
    signal: result ? result.signal : null,
    timedOut: result ? result.timedOut : null,
    stdoutSha256: result ? sha256(result.stdout) : null,
    stderrSha256: result ? sha256(result.stderr) : null,
    error: result ? (result.error || null) : null,
    modelGenerated: false,
    claimBoundary: 'Adapter output only. Applying, building and independent acceptance remain controller-owned and are not claimed here.',
  };
}

function previousReport(outDir, mode) {
  const file = path.join(outDir, `${reportStem(mode)}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {status: 'invalid'};
  }
}

function produce({
  preflight = false,
  promptPath,
  sourceDir = process.env.REPAIR_SOURCE_DIR || null,
  outDir,
  timeoutMs = 120000,
  env = process.env,
  manifestPath = path.join(here, 'controller-manifest.json'),
  ownedDir = here,
} = {}) {
  const mode = preflight ? 'preflight' : 'repair';
  const out = outDir || path.join(here, 'out', mode === 'preflight' ? 'preflight' : 'model-producer');
  const report = baseReport({mode});
  report.isolation = {mode: 'none', probes: null};

  // A captured candidate is evidence: never overwrite it implicitly, and never
  // leave a stale candidate behind after a failed retry.
  const prior = previousReport(out, mode);
  const priorPatch = path.join(out, `${reportStem(mode)}.patch`);
  if (!preflight && (prior?.status === 'captured' || fs.existsSync(priorPatch))) {
    report.status = 'blocked';
    report.error = 'output directory already contains a captured candidate; use a fresh --out and do not overwrite evidence';
    return {ok: false, report};
  }

  let workspace = null;
  try {
    // Invalidate the previous report before any validation so a failure cannot
    // leave apparently successful evidence behind.
    writeReport(out, {...report, status: 'running'}, null);

    const argv = producerArgv(env);
    report.command = argv;
    workspace = makeWorkspace();

    const safeEnv = producerEnv(env);
    const before = preflight ? null : hashOwned(ownedDir);
    const actualPrompt = preflight
      ? `Reply with exactly: NONCE ${crypto.randomBytes(16).toString('hex')}`
      : buildPrompt({sourceDir, promptPath, manifestPath});
    const call = materialize(argv, actualPrompt);
    const nonce = preflight ? actualPrompt.replace(/^Reply with exactly: /, '') : null;
    if (nonce) report.nonceSha256 = sha256(nonce);

    let launch = call.argv;
    if (!preflight) {
      const prefix = sandboxArgv(env);
      if (!prefix) {
        report.status = 'blocked';
        report.error = 'MODEL_PRODUCER_SANDBOX_CMD is required for repair generation: confine the producer and prove it before trusting the candidate';
        writeReport(out, report, null);
        return {ok: false, report};
      }
      const sentinel = path.join(ownedDir, 'repair.patch');
      const expanded = prefix.map((part) => part.split('{workspace}').join(workspace));
      report.isolation = {mode: 'sandbox', command: expanded, sentinel};
      const probes = probeSandbox(expanded, {workspace, sentinel, ownedDir, timeoutMs: Math.min(timeoutMs, 30000), env: safeEnv});
      report.isolation.probes = probes;
      if (!probes.ok) {
        report.status = 'blocked';
        report.error = `producer sandbox probe failed: ${probes.errors.join('; ')}`;
        writeReport(out, report, null);
        return {ok: false, report};
      }
      launch = expanded.concat(call.argv);
    }

    const result = runCommand(launch, {cwd: workspace, timeoutMs, input: call.stdin, env: safeEnv});
    Object.assign(report, {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stdoutSha256: sha256(result.stdout),
      stderrSha256: sha256(result.stderr),
      error: result.error || null,
    });

    if (!preflight) {
      const changed = changedOwned(before, hashOwned(ownedDir));
      report.ownedFilesUnchanged = changed.length === 0;
      if (changed.length) {
        report.changedOwnedFiles = changed;
        report.status = 'rejected';
        report.error = `controller-owned files changed during producer run: ${changed.join(', ')}`;
        writeReport(out, report, null);
        return {ok: false, report};
      }
    }

    if (result.exitCode !== 0 || result.error) {
      report.status = preflight ? 'blocked' : 'failed';
      writeReport(out, report, null);
      return {ok: false, report};
    }

    if (preflight) {
      if (String(result.stdout).trim() !== nonce) {
        report.status = 'rejected';
        report.error = 'preflight response did not match the fresh nonce';
        writeReport(out, report, null);
        return {ok: false, report};
      }
      report.status = 'ok';
      writeReport(out, report, null);
      return {ok: true, report};
    }

    try {
      const patch = extractDiff(result.stdout);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const errors = verifyPatch(patch, manifest);
      report.patchSha256 = sha256(patch);
      report.paths = patchPaths(patch);
      report.controllerErrors = errors;
      if (errors.length) {
        report.status = 'rejected';
        writeReport(out, report, null);
        return {ok: false, report};
      }
      const applied = verifyPatchInTree(patch, manifest, sourceDir);
      report.appliedPaths = applied.changedPaths;
      report.applyErrors = applied.errors;
      if (applied.errors.length) {
        report.status = 'rejected';
        writeReport(out, report, null);
        return {ok: false, report};
      }
      report.status = 'captured';
      report.modelGenerated = true;
      const file = writeReport(out, report, patch);
      return {ok: true, report, patch, file};
    } catch (error) {
      report.status = 'rejected';
      report.error = error.message;
      writeReport(out, report, null);
      return {ok: false, report};
    }
  } catch (error) {
    report.status = preflight ? 'error' : 'failed';
    report.error = error.message;
    writeReport(out, report, null);
    return {ok: false, report};
  } finally {
    if (workspace) fs.rmSync(workspace, {recursive: true, force: true});
  }
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(usage());
    } else {
      const result = produce({preflight: opts.preflight, promptPath: opts.prompt, sourceDir: opts.source, outDir: opts.out, timeoutMs: opts.timeoutMs});
      console.log(JSON.stringify(result.report, null, 2));
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({schema: SCHEMA, status: 'error', error: error.message}, null, 2));
    process.exitCode = 2;
  }
}

module.exports = {extractDiff, hashOwned, materialize, parseArgs, probeSandbox, produce, producerArgv, producerEnv, runProducer, sandboxArgv};
