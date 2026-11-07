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
 * The adapter never applies, builds or accepts a patch. It only captures the
 * producer result, requires a unified git diff, and runs the existing
 * controller allowlist before writing the candidate.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {verifyPatch} = require('./repair-controller.cjs');

const here = __dirname;

function usage() {
  return [
    'usage: node model-producer.cjs [options]',
    '',
    '  --preflight          check authentication/model availability only',
    '  --prompt <file>      prompt file (default: model-prompt.md)',
    '  --out <dir>          output directory (default: out/model-producer)',
    '  --timeout-ms <n>     command timeout (default: 120000)',
    '',
    'MODEL_PRODUCER_CMD must be a JSON argv array; use {prompt} where the',
    'prompt text should be inserted.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {preflight: false, prompt: path.join(here, 'model-prompt.md'), out: path.join(here, 'out', 'model-producer'), timeoutMs: 120000};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--preflight') opts.preflight = true;
    else if (arg === '--prompt') opts.prompt = path.resolve(argv[++i]);
    else if (arg === '--out') opts.out = path.resolve(argv[++i]);
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');
  return opts;
}

function producerArgv(env = process.env) {
  const raw = env.MODEL_PRODUCER_CMD;
  if (!raw) throw new Error('MODEL_PRODUCER_CMD is required');
  let argv;
  try {
    argv = JSON.parse(raw);
  } catch (error) {
    throw new Error(`MODEL_PRODUCER_CMD is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(argv) || !argv.length || argv.some((part) => typeof part !== 'string') || !argv[0]) {
    throw new Error('MODEL_PRODUCER_CMD must be a non-empty JSON string array with an executable');
  }
  return argv;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function materialize(argv, prompt) {
  const placeholder = argv.includes('{prompt}');
  const args = argv.map((part) => part === '{prompt}' ? prompt : part);
  return {argv: args, stdin: placeholder ? undefined : prompt};
}

function runProducer(argv, prompt, {cwd = process.cwd(), timeoutMs = 120000} = {}) {
  const call = materialize(argv, prompt);
  const result = spawnSync(call.argv[0], call.argv.slice(1), {
    cwd,
    input: call.stdin,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  const error = timedOut ? `command timed out after ${timeoutMs}ms` : (result.error ? result.error.message : '');
  return {
    argv: call.argv,
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal || null,
    timedOut,
    stdout,
    stderr,
    error: error || (result.status === 0 ? '' : (stderr.trim() || stdout.trim() || `producer exited ${result.status}`)),
  };
}

function extractDiff(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('producer output is empty');
  if (text.includes('```')) throw new Error('producer output contains a markdown fence');
  if (!text.startsWith('diff --git ')) throw new Error('producer output is not a unified git diff');
  return `${text}\n`;
}

function writeReport(outDir, report, patch) {
  fs.mkdirSync(outDir, {recursive: true});
  const stem = report.mode === 'preflight' ? 'preflight' : 'result';
  if (patch) fs.writeFileSync(path.join(outDir, `${stem}.patch`), patch);
  const file = path.join(outDir, `${stem}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

function baseReport({mode, argv, result}) {
  return {
    schema: 'near-rehearsal/model-producer/v1',
    mode,
    command: argv,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    error: result.error || null,
    modelGenerated: false,
    claimBoundary: 'Adapter output only. Applying, building and independent acceptance remain controller-owned and are not claimed here.',
  };
}

function produce({preflight = false, promptPath, outDir, timeoutMs = 120000, env = process.env, cwd = process.cwd()} = {}) {
  const prompt = fs.readFileSync(promptPath, 'utf8');
  const argv = producerArgv(env);
  const actualPrompt = preflight ? 'Reply with exactly OK.' : prompt;
  const result = runProducer(argv, actualPrompt, {cwd, timeoutMs});
  const report = baseReport({mode: preflight ? 'preflight' : 'repair', argv, result});
  let patch = null;

  if (result.exitCode !== 0 || result.error) {
    report.status = preflight ? 'blocked' : 'failed';
    writeReport(outDir, report, null);
    return {ok: false, report};
  }

  if (preflight) {
    report.status = 'ok';
    writeReport(outDir, report, null);
    return {ok: true, report};
  }

  try {
    patch = extractDiff(result.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(here, 'controller-manifest.json'), 'utf8'));
    const errors = verifyPatch(patch, manifest);
    report.patchSha256 = sha256(patch);
    report.paths = [...new Set([...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].flatMap((m) => [m[1], m[2]]))];
    report.controllerErrors = errors;
    if (errors.length) {
      report.status = 'rejected';
      writeReport(outDir, report, null);
      return {ok: false, report};
    }
    report.status = 'captured';
    report.modelGenerated = true;
    const file = writeReport(outDir, report, patch);
    return {ok: true, report, patch, file};
  } catch (error) {
    report.status = 'rejected';
    report.error = error.message;
    writeReport(outDir, report, null);
    return {ok: false, report};
  }
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(usage());
    } else {
      const result = produce({preflight: opts.preflight, promptPath: opts.prompt, outDir: opts.out, timeoutMs: opts.timeoutMs});
      console.log(JSON.stringify(result.report, null, 2));
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({schema: 'near-rehearsal/model-producer/v1', status: 'error', error: error.message}, null, 2));
    process.exitCode = 2;
  }
}

module.exports = {extractDiff, materialize, parseArgs, produce, producerArgv, runProducer};
