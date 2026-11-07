'use strict';
/*
 * Local, tool-free Codex producer for the issue #238 repair.
 *
 * The model receives only the pinned allowlisted source in a disposable
 * workspace and is asked to return a unified diff as text. It has no tools.
 * The controller extracts the raw agent message, applies it in a separate
 * single-file tree with --recount --unidiff-zero, enumerates the real changed
 * paths, derives a canonical contextual diff, and only then invokes the
 * verified build/replay/acceptance pipeline.
 *
 * Authentication is a transient read-only symlink into a private provider
 * runtime. Token values are never copied, read or logged, and the original
 * ~/.codex directory is never made writable.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {hashOwned, probeSandbox, producerEnv, sandboxArgv} = require('./model-producer.cjs');
const {verifyPatch, verifyPatchInTree} = require('./repair-controller.cjs');
const {runPipeline} = require('./repair-pipeline.cjs');

const HERE = __dirname;
const MANIFEST = path.join(HERE, 'controller-manifest.json');
const TOOL_DISABLES = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'code_mode_host'];

function usage() {
  return [
    'usage: node codex-producer.cjs --source <pinned-tree> --out <dir> --profile <name>',
    '                                   --private-runtime <dir> [--auth-source <auth.json>]',
    '                                   [--codex-bin <codex>] [--model <model>] [--no-pipeline]',
    '                                   [--manifest <controller-manifest>] [--base-report <report>]',
    '                                   [--sandbox-dir <verified-sandbox-wrapper>]',
    '',
    'The producer is tool-free. It emits a unified diff as the agent message; the',
    'inner model CLI never receives --profile; --profile must match the enforced',
    'outer --permission-profile in MODEL_PRODUCER_SANDBOX_CMD.',
    'controller normalizes it in a disposable single-file tree, checks the source',
    'allowlist and actual changed paths, then builds, replays and accepts a',
    'controller-bound candidate.',
    '',
    'MODEL_PRODUCER_SANDBOX_CMD is required. It is a JSON argv prefix containing',
    '{workspace}; the Codex command is appended after it. Use the verified outer',
    'OS policy, not the older Codex --sandbox flag.',
    '',
    'Auth is a transient read-only symlink at <private-runtime>/auth.json to',
    '--auth-source. The original auth directory is never modified, and the private',
    'runtime is removed in finally. Set CODEX_NO_DAEMON=0 only if the local CLI',
    'build does not accept --no-daemon.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    source: process.env.REPAIR_SOURCE_DIR || null,
    out: null,
    profile: process.env.CODEX_PERMISSION_PROFILE || null,
    privateRuntime: process.env.CODEX_PRIVATE_RUNTIME || null,
    authSource: process.env.CODEX_AUTH_SOURCE || null,
    codexBin: process.env.CODEX_BIN || 'codex',
    model: process.env.CODEX_MODEL || null,
    timeoutMs: 20 * 60 * 1000,
    noPipeline: false,
    noDaemon: process.env.CODEX_NO_DAEMON !== '0',
    manifest: MANIFEST,
    baseReport: null,
    sandboxDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--source') opts.source = path.resolve(argv[++i]);
    else if (arg === '--out') opts.out = path.resolve(argv[++i]);
    else if (arg === '--profile') opts.profile = argv[++i];
    else if (arg === '--private-runtime') opts.privateRuntime = path.resolve(argv[++i]);
    else if (arg === '--auth-source') opts.authSource = path.resolve(argv[++i]);
    else if (arg === '--codex-bin') opts.codexBin = path.resolve(argv[++i]);
    else if (arg === '--model') opts.model = argv[++i];
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(argv[++i]);
    else if (arg === '--no-pipeline') opts.noPipeline = true;
    else if (arg === '--manifest') opts.manifest = path.resolve(argv[++i]);
    else if (arg === '--base-report') opts.baseReport = path.resolve(argv[++i]);
    else if (arg === '--sandbox-dir') opts.sandboxDir = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');
  return opts;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function gitShow(sourceDir, file) {
  const result = spawnSync('git', ['-C', sourceDir, 'show', `HEAD:${file}`], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024, env: {...process.env, GIT_CONFIG_NOSYSTEM: '1'},
  });
  if (result.status !== 0) throw new Error(`cannot read pinned source ${file}: ${(result.stderr || '').trim()}`);
  return result.stdout;
}

function sourceCommit(sourceDir) {
  const result = spawnSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], {encoding: 'utf8', timeout: 30000});
  if (result.status !== 0) throw new Error(`cannot read pinned source head: ${(result.stderr || '').trim()}`);
  return result.stdout.trim();
}

function controllerHashes() {
  const out = {};
  for (const entry of fs.readdirSync(HERE, {withFileTypes: true})) {
    if (!entry.isFile()) continue;
    const file = path.join(HERE, entry.name);
    out[entry.name] = sha256File(file);
  }
  return out;
}


function verifiedOuterProfile(prefix, profile) {
  if (!profile) throw new Error('--profile is required: it names the enforced outer permission profile');
  let found = null;
  for (let i = 0; i < prefix.length; i += 1) {
    const part = prefix[i];
    if (part === '--permission-profile' || part === '-P') {
      found = {flag: part, name: prefix[i + 1], index: i};
      break;
    }
    if (part.startsWith('--permission-profile=')) {
      found = {flag: '--permission-profile=', name: part.slice(part.indexOf('=') + 1), index: i};
      break;
    }
  }
  if (!found || !found.name) throw new Error('MODEL_PRODUCER_SANDBOX_CMD must include an outer --permission-profile <name>');
  if (found.name !== profile) throw new Error(`outer permission profile ${found.name} does not match --profile ${profile}`);
  return {flag: found.flag, name: found.name, index: found.index, verifiedBy: 'outer-prefix+confinement-probe'};
}

function assertFreshOut(out) {
  if (!fs.existsSync(out)) return;
  if (!fs.statSync(out).isDirectory()) throw new Error(`--out is not a directory: ${out}`);
  if (fs.readdirSync(out).length) throw new Error(`--out must be fresh; refusing to reuse ${out}`);
}

function prepareRuntime({privateRuntime, authSource}) {
  if (!privateRuntime) throw new Error('--private-runtime is required');
  if (fs.existsSync(privateRuntime)) {
    if (!fs.statSync(privateRuntime).isDirectory()) throw new Error(`private runtime is not a directory: ${privateRuntime}`);
    if (fs.readdirSync(privateRuntime).length) throw new Error(`private runtime must be empty: ${privateRuntime}`);
  } else {
    fs.mkdirSync(privateRuntime, {recursive: true, mode: 0o700});
  }
  fs.chmodSync(privateRuntime, 0o700);
  const link = path.join(privateRuntime, 'auth.json');
  if (fs.existsSync(link) || fs.lstatSync(link, {throwIfNoEntry: false})) throw new Error(`private runtime already contains ${link}`);
  let linked = false;
  if (authSource) {
    if (!fs.existsSync(authSource)) throw new Error(`auth source not found: ${authSource}`);
    const source = fs.realpathSync(authSource);
    const stat = fs.statSync(source);
    if (!stat.isFile()) throw new Error(`auth source is not a regular file: ${authSource}`);
    if (source === link || source.startsWith(`${privateRuntime}${path.sep}`)) throw new Error('auth source must not be inside the private runtime');
    fs.symlinkSync(source, link);
    linked = true;
  }
  return {
    root: privateRuntime,
    authLink: linked ? link : null,
    env: {
      HOME: privateRuntime,
      CODEX_HOME: privateRuntime,
      XDG_CONFIG_HOME: privateRuntime,
      XDG_CACHE_HOME: privateRuntime,
    },
  };
}

function cleanupRuntime(runtime) {
  if (!runtime?.root) return;
  try { fs.rmSync(runtime.root, {recursive: true, force: true}); } catch {/* best effort */}
}

function buildCodexArgv({workspace, lastMessage, model, noDaemon}) {
  const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check'];
  if (noDaemon) args.push('--no-daemon');
  args.push('--cd', workspace, '--output-last-message', lastMessage);
  for (const feature of TOOL_DISABLES) args.push('--disable', feature);
  if (model) args.push('--model', model);
  args.push('-');
  return args;
}

function extractPatch(text) {
  if (!text) throw new Error('agent produced no message');
  const candidates = [];
  const fences = [...text.matchAll(/```(?:diff|patch)?\s*\r?\n([\s\S]*?)```/gi)];
  for (const match of fences) candidates.push(match[1]);
  const trimmed = text.trim();
  if (/^(?:diff --git |--- a\/)/.test(trimmed)) candidates.unshift(trimmed);
  const start = text.search(/^(?:diff --git |--- a\/)/m);
  if (start >= 0) candidates.push(text.slice(start));
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\r\n/g, '\n').trim();
    if (/^(?:diff --git |--- a\/)/m.test(normalized)) return `${normalized}\n`;
  }
  throw new Error('agent message contains no unified diff');
}

function lastAgentText(transcript, lastMessagePath) {
  if (fs.existsSync(lastMessagePath)) {
    const text = fs.readFileSync(lastMessagePath, 'utf8').trim();
    if (text) return text;
  }
  let found = '';
  for (const line of String(transcript || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const item = event?.item || event?.message || event?.data;
      const text = typeof item === 'string' ? item : item?.text || item?.content || item?.message;
      if (typeof text === 'string' && /diff --git |--- a\//.test(text)) found = text;
    } catch {/* non-JSON output is still preserved raw */}
  }
  return found;
}

function git(temp, args, options = {}) {
  return spawnSync('git', args, {cwd: temp, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024, ...options});
}


function assertNoSymlinkPath(target, root) {
  let current = path.resolve(target);
  const boundary = path.resolve(root);
  while (current.startsWith(`${boundary}${path.sep}`) || current === boundary) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink path component: ${current}`);
    if (current === boundary) break;
    current = path.dirname(current);
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`allowlisted path is not a regular file: ${target}`);
}

function assertRawPatchSafety(rawPatch, file) {
  const lines = String(rawPatch).split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to|Binary files|GIT binary patch)\b/.test(trimmed)) {
      throw new Error(`unsafe patch metadata: ${trimmed}`);
    }
    const diff = trimmed.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diff && (diff[1] !== file || diff[2] !== file)) throw new Error(`diff targets unexpected path: ${diff[1]} -> ${diff[2]}`);
    const marker = trimmed.match(/^(---|\+\+\+) (.+)$/);
    if (marker) {
      const rawPath = marker[2].split(/\s+/)[0];
      if (rawPath === '/dev/null') throw new Error('new or deleted files are not allowed');
      const candidate = rawPath.replace(/^[ab]\//, '');
      if (candidate !== file) throw new Error(`diff marker targets unexpected path: ${rawPath}`);
    }
    const index = trimmed.match(/^index [0-9a-f]+\.\.[0-9a-f]+(?: (\d+))?$/);
    if (index && index[1] && index[1] !== '100644') throw new Error(`unsafe file mode: ${index[1]}`);
  }
}

function canonicalDiff(original, changed, file) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-canonical-'));
  try {
    const target = path.join(temp, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, original);
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=repair-controller', '-c', 'user.email=repair-controller@localhost', 'commit', '-qm', 'base']]) {
      const result = git(temp, args);
      if (result.status !== 0) throw new Error(`cannot prepare canonical diff: ${(result.stderr || '').trim()}`);
    }
    fs.writeFileSync(target, changed);
    const result = git(temp, ['diff', '--src-prefix=a/', '--dst-prefix=b/', '--', file]);
    if (result.status !== 0 || !result.stdout.trim()) throw new Error(`model did not produce a changed canonical source: ${(result.stderr || '').trim()}`);
    return `${result.stdout.trim()}\n`;
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
}

function normalizePatch(rawPatch, original, file) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-normalize-'));
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-raw-patch-'));
  try {
    const target = path.join(temp, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, original);
    assertNoSymlinkPath(target, temp);
    assertRawPatchSafety(rawPatch, file);
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=repair-controller', '-c', 'user.email=repair-controller@localhost', 'commit', '-qm', 'base']]) {
      const result = git(temp, args);
      if (result.status !== 0) throw new Error(`cannot prepare normalization tree: ${(result.stderr || '').trim()}`);
    }
    const rawPath = path.join(rawDir, 'candidate.raw.patch');
    fs.writeFileSync(rawPath, rawPatch);
    const check = git(temp, ['apply', '--recount', '--unidiff-zero', '--whitespace=nowarn', '--check', rawPath]);
    if (check.status !== 0) throw new Error(`git apply rejected the agent diff: ${(check.stderr || '').trim()}`);
    const applied = git(temp, ['apply', '--recount', '--unidiff-zero', '--whitespace=nowarn', rawPath]);
    if (applied.status !== 0) throw new Error(`git apply failed: ${(applied.stderr || '').trim()}`);
    const status = git(temp, ['status', '--porcelain']);
    if (status.status !== 0) throw new Error(`cannot enumerate changed paths: ${(status.stderr || '').trim()}`);
    const changedPaths = status.stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/^..\s?/, ''));
    if (JSON.stringify(changedPaths) !== JSON.stringify([file])) throw new Error(`agent diff changed unexpected paths: ${changedPaths.join(', ') || '(none)'}`);
    assertNoSymlinkPath(target, temp);
    const changed = fs.readFileSync(target, 'utf8');
    if (changed === original) throw new Error('agent diff did not change the allowlisted source');
    return {patch: canonicalDiff(original, changed, file), changedPaths, changedSource: changed};
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
    fs.rmSync(rawDir, {recursive: true, force: true});
  }
}

function run(command, args, {cwd, timeoutMs, env, input} = {}) {
  return spawnSync(command, args, {cwd, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env});
}

function expandPrefix(prefix, values) {
  return prefix.map((part) => part.replace(/\{(workspace|privateRuntime|authSource|profile)\}/g, (_, key) => values[key] || `{${key}}`));
}

function main() {
  let opts;
  let runtime;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) { console.log(usage()); return; }
    if (!opts.source || !opts.out || !opts.privateRuntime || !opts.profile) throw new Error('--source, --out, --private-runtime and --profile are required');
    if (!opts.authSource) throw new Error('--auth-source is required; link the existing local auth.json read-only, do not copy it');
    if (!process.env.MODEL_PRODUCER_SANDBOX_CMD) throw new Error('MODEL_PRODUCER_SANDBOX_CMD is required; unsupported confinement fails closed');
    const manifest = JSON.parse(fs.readFileSync(opts.manifest, 'utf8'));
    const allowed = manifest.allowedPaths || [];
    if (allowed.length !== 1) throw new Error('producer requires exactly one allowlisted source file');
    const file = allowed[0];
    const original = gitShow(opts.source, file);
    const commit = sourceCommit(opts.source);
    if (manifest?.source?.commit && commit !== manifest.source.commit) throw new Error(`source tree head ${commit} does not match pinned ${manifest.source.commit}`);
    assertFreshOut(opts.out);
    fs.mkdirSync(opts.out, {recursive: true});
    const attempt = path.join(opts.out, 'attempt');
    fs.mkdirSync(attempt, {recursive: true});
    runtime = prepareRuntime({privateRuntime: opts.privateRuntime, authSource: opts.authSource});

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'near-repair-codex-'));
    if (workspace.startsWith(runtime.root) || runtime.root.startsWith(workspace)) throw new Error('provider runtime and source workspace must be separate');
    const target = path.join(workspace, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, original);
    const prompt = [
      'You are repairing the pinned Sputnik DAO v2 source.',
      `The only allowed source file is ${file}. Do not ask for tools, read other files, run commands, or edit anything.`,
      'Return ONLY a unified Git diff in your final message. The diff must change only the allowed file.',
      'The defect: when a proposal execution callback fails, the proposal is marked Failed but its bond remains in the contract. A failed async action must return the bond to the proposer exactly once; a later authorized Finalize retry must not return it again. It must not create a payout or change the beneficiary/amount.',
      '',
      `Pinned source (${file}):`,
      '```rust',
      original,
      '```',
    ].join('\n');
    const env = {...producerEnv(process.env), ...runtime.env, CODEX_NO_DAEMON: opts.noDaemon ? '1' : '0'};
    const prefix = sandboxArgv(process.env);
    if (!prefix) throw new Error('MODEL_PRODUCER_SANDBOX_CMD is required for generation');
    if (prefix.some((part) => part === '--sandbox' || part === '-s')) throw new Error('do not pass --sandbox with a named Codex permission profile');
    const outerProfile = verifiedOuterProfile(expandPrefix(prefix, {profile: opts.profile}), opts.profile);
    const expandedPrefix = expandPrefix(prefix, {workspace, privateRuntime: runtime.root, authSource: opts.authSource || '', profile: opts.profile});
    const before = controllerHashes();
    const probes = probeSandbox(expandedPrefix, {workspace, sentinel: path.join(HERE, 'repair.patch'), ownedDir: HERE, timeoutMs: Math.min(opts.timeoutMs, 30000), env});
    if (!probes.ok) throw new Error(`producer sandbox probe failed: ${probes.errors.join('; ')}`);

    const workspaceLastMessage = path.join(workspace, 'last-message.txt');
    const lastMessage = path.join(attempt, 'last-message.txt');
    const args = buildCodexArgv({workspace, lastMessage: workspaceLastMessage, model: opts.model, noDaemon: opts.noDaemon});
    const command = opts.codexBin;
    const result = run(expandedPrefix[0], [...expandedPrefix.slice(1), command, ...args], {cwd: workspace, timeoutMs: opts.timeoutMs, env, input: prompt});
    if (fs.existsSync(workspaceLastMessage)) fs.copyFileSync(workspaceLastMessage, lastMessage);
    const transcript = result.stdout || '';
    const stderr = result.stderr || '';
    fs.writeFileSync(path.join(attempt, 'transcript.jsonl'), transcript);
    fs.writeFileSync(path.join(attempt, 'stderr.log'), stderr);
    const after = controllerHashes();
    const changedOwned = Object.keys(before).filter((name) => before[name] !== after[name]);
    const agentText = lastAgentText(transcript, lastMessage);
    const rawPatch = agentText ? extractPatch(agentText) : null;
    const provenance = {
      schema: 'near-rehearsal/codex-tool-free-producer/v1',
      source: {repository: manifest?.source?.repository || null, commit, path: file, sha256: sha256(original)},
      workspace,
      privateRuntime: {root: runtime.root, authLinked: Boolean(runtime.authLink), mode: 0o700},
      outerPermissionProfile: outerProfile,
      innerProfileFlag: false,
      command: [command, ...args.map((part) => part === workspace ? '<workspace>' : part === opts.model ? '<model>' : part === workspaceLastMessage || part === lastMessage ? '<last-message>' : part)],
      sandboxCommand: prefix.map((part) => part.replace(/\{(workspace|privateRuntime|authSource)\}/g, '<$1>')),
      envKeys: Object.keys(env).sort(),
      isolation: probes,
      exitCode: result.status,
      signal: result.signal || null,
      timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
      stdoutSha256: sha256(transcript),
      stderrSha256: sha256(stderr),
      lastMessageSha256: fs.existsSync(lastMessage) ? sha256File(lastMessage) : null,
      rawPatchSha256: rawPatch ? sha256(rawPatch) : null,
      changedOwned,
      compiled: false,
      accepted: false,
    };
    fs.writeFileSync(path.join(attempt, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
    if (result.status !== 0 || !rawPatch) throw new Error(`Codex generation failed with exit ${result.status}: ${stderr.slice(0, 300)}`);
    if (changedOwned.length) throw new Error(`controller-owned files changed during producer run: ${changedOwned.join(', ')}`);
    fs.writeFileSync(path.join(attempt, 'raw.patch'), rawPatch);
    const normalized = normalizePatch(rawPatch, original, file);
    const staticErrors = verifyPatch(normalized.patch, manifest);
    if (staticErrors.length) throw new Error(`canonical patch rejected: ${staticErrors.join('; ')}`);
    const applied = verifyPatchInTree(normalized.patch, manifest, opts.source);
    if (applied.errors.length) throw new Error(`canonical apply rejected: ${applied.errors.join('; ')}`);
    if (JSON.stringify(applied.changedPaths) !== JSON.stringify([file])) throw new Error(`source changed paths differ from allowlist: ${applied.changedPaths.join(', ')}`);
    const patchPath = path.join(opts.out, 'canonical.patch');
    fs.writeFileSync(patchPath, normalized.patch);
    const report = {...provenance, canonicalPatchSha256: sha256(normalized.patch), changedPaths: applied.changedPaths, changedSourceSha256: sha256(normalized.changedSource)};
    fs.writeFileSync(path.join(opts.out, 'producer.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (opts.noPipeline) { console.log(JSON.stringify(report, null, 2)); return; }
    const pipeline = runPipeline({patch: patchPath, source: opts.source, out: path.join(opts.out, 'pipeline'), provenance: path.join(attempt, 'provenance.json'), sandboxDir: opts.sandboxDir, baseReport: opts.baseReport || undefined});
    console.log(JSON.stringify({...report, pipeline}, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    cleanupRuntime(runtime);
  }
}

if (require.main === module) main();

module.exports = {assertFreshOut, assertNoSymlinkPath, assertRawPatchSafety, buildCodexArgv, canonicalDiff, extractPatch, normalizePatch, prepareRuntime, cleanupRuntime, verifiedOuterProfile, main};
