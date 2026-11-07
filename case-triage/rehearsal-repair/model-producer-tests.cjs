'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {extractDiff, materialize, produce, producerArgv, runProducer} = require('./model-producer.cjs');
const {buildPrompt} = require('./model-input.cjs');

assert.throws(() => extractDiff(''), /empty/);
assert.throws(() => extractDiff('Here is the patch'), /unified git diff/);
assert.throws(() => extractDiff('```diff\ndiff --git a/x b/x\n```'), /markdown fence/);
assert.equal(materialize(['cli', '{prompt}'], 'hello').stdin, undefined);
assert.equal(materialize(['cli'], 'hello').stdin, 'hello');
assert.deepEqual(producerArgv({MODEL_PRODUCER_CMD: '["cli",""]'}), ['cli', '']);
assert.throws(() => producerArgv({}), /MODEL_PRODUCER_CMD is required/);
assert.throws(() => producerArgv({MODEL_PRODUCER_CMD: 'not-json'}), /valid JSON/);

const failure = runProducer(
  [process.execPath, '-e', "process.stderr.write('Failed to authenticate. API Error: 403 blocked'); process.exit(1)"],
  'ignored',
  {timeoutMs: 10000},
);
assert.equal(failure.exitCode, 1);
assert.match(failure.error, /Failed to authenticate.*403 blocked/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-producer-test-'));
const prompt = path.join(temp, 'prompt.md');
fs.writeFileSync(prompt, 'repair prompt\n');
const result = produce({
  preflight: true,
  promptPath: prompt,
  outDir: temp,
  timeoutMs: 10000,
  env: {
    MODEL_PRODUCER_CMD: JSON.stringify([
      process.execPath,
      '-e',
      "process.stderr.write('Failed to authenticate. API Error: 403 blocked'); process.exit(1)",
    ]),
  },
});
assert.equal(result.ok, false);
assert.equal(result.report.status, 'blocked');
assert.match(result.report.error, /403 blocked/);
assert.ok(fs.existsSync(path.join(temp, 'preflight.json')));
assert.equal(fs.existsSync(path.join(temp, 'preflight.patch')), false);

const ok = produce({
  preflight: true,
  promptPath: prompt,
  sourceDir: null,
  outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'model-producer-ok-')),
  timeoutMs: 10000,
  env: {
    MODEL_PRODUCER_CMD: JSON.stringify([process.execPath, '-e', "process.stdout.write(process.argv[1].match(/NONCE [0-9a-f]+/)[0])", '{prompt}']),
  },
});
assert.equal(ok.ok, true);
assert.equal(ok.report.status, 'ok');
assert.ok(ok.report.nonceSha256);

const wrong = produce({
  preflight: true,
  promptPath: prompt,
  sourceDir: null,
  outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'model-producer-wrong-')),
  timeoutMs: 10000,
  env: {
    MODEL_PRODUCER_CMD: JSON.stringify([process.execPath, '-e', "process.stdout.write('OK')"]),
  },
});
assert.equal(wrong.ok, false);
assert.equal(wrong.report.status, 'rejected');
assert.match(wrong.report.error, /fresh nonce/);

const source = fs.mkdtempSync(path.join(os.tmpdir(), 'model-input-test-'));
fs.mkdirSync(path.join(source, 'sputnikdao2', 'src'), {recursive: true});
fs.writeFileSync(path.join(source, 'sputnikdao2', 'src', 'proposals.rs'), 'PINNED_MARKER\n');
fs.writeFileSync(path.join(source, 'Cargo.toml'), 'SECRET_CARGO\n');
execFileSync('git', ['init', '-q'], {cwd: source});
execFileSync('git', ['add', '-A'], {cwd: source});
execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'base'], {cwd: source});
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: source, encoding: 'utf8'}).trim();
const inputManifest = path.join(source, 'manifest.json');
fs.writeFileSync(inputManifest, JSON.stringify({
  source: {commit: sourceHead},
  allowedPaths: ['sputnikdao2/src/proposals.rs'],
}));
const modelInput = buildPrompt({sourceDir: source, promptPath: prompt, manifestPath: inputManifest});
assert.match(modelInput, /PINNED_MARKER/);
assert.doesNotMatch(modelInput, /SECRET_CARGO/);
assert.doesNotMatch(modelInput, /repair\.patch/);
fs.rmSync(source, {recursive: true, force: true});

// --- P1: producer isolation and integrity ---------------------------------

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, text);
}

function makePinnedRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-pinned-'));
  const file = 'sputnikdao2/src/proposals.rs';
  writeFile(path.join(repo, file), 'pub fn value() -> u64 { 1 }\n');
  writeFile(path.join(repo, 'Cargo.toml'), '[package]\nname = "pinned"\n');
  execFileSync('git', ['init', '-q'], {cwd: repo});
  execFileSync('git', ['add', '-A'], {cwd: repo});
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'base'], {cwd: repo});
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8'}).trim();
  writeFile(path.join(repo, file), 'pub fn value() -> u64 { 2 }\n');
  const diff = execFileSync('git', ['diff'], {cwd: repo, encoding: 'utf8'});
  execFileSync('git', ['checkout', '--', '.'], {cwd: repo});
  return {repo, head, diff, file};
}

const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-sandbox-'));
const wrapper = path.join(wrapperDir, 'sandbox.cjs');
fs.writeFileSync(wrapper, [
  "'use strict';",
  "const {spawnSync} = require('node:child_process');",
  "const path = require('node:path');",
  "const sentinel = process.argv[2];",
  "const ownedDir = process.argv[3];",
  "const workspace = process.argv[4];",
  "const cmd = process.argv.slice(5);",
  "const readAllowed = process.env.SANDBOX_ALLOW_CONTROLLER_READ === '1';",
  "const writeAllowed = process.env.SANDBOX_ALLOW_CONTROLLER_WRITE === '1';",
  "const denyWorkspace = process.env.SANDBOX_DENY_WORKSPACE_WRITE === '1';",
  "const denied = '/nonexistent/sandbox-denied';",
  "const under = (base, value) => value === base || value.startsWith(base + path.sep);",
  "const map = (arg) => {",
  "  if (arg === sentinel) return readAllowed ? arg : denied;",
  "  if (!writeAllowed && under(ownedDir, arg)) return denied;",
  "  if (denyWorkspace && under(workspace, arg)) return denied;",
  "  return arg;",
  "};",
  "const result = spawnSync(cmd[0], cmd.slice(1).map(map), {cwd: process.cwd(), env: process.env, encoding: 'utf8'});",
  "process.stdout.write(result.stdout || '');",
  "process.stderr.write(result.stderr || '');",
  "process.exit(typeof result.status === 'number' ? result.status : 1);",
  '',
].join('\n'));

const pinned = makePinnedRepo();
const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-prompt-'));
const repairPrompt = path.join(promptDir, 'prompt.md');
fs.writeFileSync(repairPrompt, 'repair this source\n');
const repairManifest = path.join(promptDir, 'manifest.json');
fs.writeFileSync(repairManifest, JSON.stringify({
  source: {commit: pinned.head},
  allowedPaths: [pinned.file],
  forbiddenPaths: ['Cargo.toml'],
}));
const ownedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-owned-'));
fs.writeFileSync(path.join(ownedDir, 'repair.patch'), 'authored repair patch\n');
fs.writeFileSync(path.join(ownedDir, 'acceptance.cjs'), 'authored acceptance\n');
const diffFile = path.join(promptDir, 'model.diff');
fs.writeFileSync(diffFile, pinned.diff);
const producer = JSON.stringify([process.execPath, '-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", diffFile]);
const sandboxPrefix = JSON.stringify([process.execPath, wrapper, path.join(ownedDir, 'repair.patch'), ownedDir, '{workspace}']);
const repairEnv = (sandbox, extra = {}) => ({
  ...process.env,
  MODEL_PRODUCER_CMD: producer,
  ...(sandbox ? {MODEL_PRODUCER_SANDBOX_CMD: sandboxPrefix} : {}),
  ...extra,
});
const repairOut = () => fs.mkdtempSync(path.join(os.tmpdir(), 'producer-out-'));
const baseRepair = (outDir, env) => produce({
  promptPath: repairPrompt,
  sourceDir: pinned.repo,
  outDir,
  manifestPath: repairManifest,
  ownedDir,
  timeoutMs: 20000,
  env,
});

// Fail closed without confinement.
const noSandbox = baseRepair(repairOut(), repairEnv(null));
assert.equal(noSandbox.report.status, 'blocked');
assert.match(noSandbox.report.error, /MODEL_PRODUCER_SANDBOX_CMD is required/);

// A sandbox that still allows reading the authored patch is refused.
const readLeak = baseRepair(repairOut(), repairEnv(sandboxPrefix, {SANDBOX_ALLOW_CONTROLLER_READ: '1'}));
assert.equal(readLeak.report.status, 'blocked');
assert.match(readLeak.report.error, /read the authored patch/);

// Writes beside controller-owned files must be denied too.
const writeLeak = baseRepair(repairOut(), repairEnv(sandboxPrefix, {SANDBOX_ALLOW_CONTROLLER_WRITE: '1'}));
assert.equal(writeLeak.report.status, 'blocked');
assert.match(writeLeak.report.error, /write beside controller-owned/);

// A sandbox that cannot write in the disposable workspace cannot generate.
const noWorkspace = baseRepair(repairOut(), repairEnv(sandboxPrefix, {SANDBOX_DENY_WORKSPACE_WRITE: '1'}));
assert.equal(noWorkspace.report.status, 'blocked');
assert.match(noWorkspace.report.error, /write inside the disposable workspace/);

// A passing sandbox produces a captured candidate with probe and integrity evidence.
const captured = baseRepair(repairOut(), repairEnv(sandboxPrefix));
assert.equal(captured.ok, true, JSON.stringify(captured.report));
assert.equal(captured.report.status, 'captured');
assert.equal(captured.report.modelGenerated, true);
assert.equal(captured.report.isolation.probes.ok, true);
assert.equal(captured.report.ownedFilesUnchanged, true);
assert.ok(captured.report.patchSha256);
assert.deepEqual(captured.report.appliedPaths, [pinned.file]);
assert.ok(fs.existsSync(captured.file));
assert.ok(fs.existsSync(path.join(path.dirname(captured.file), 'result.patch')));

// A captured candidate is evidence: a second run must not overwrite it.
const capturedDir = path.dirname(captured.file);
const reportBefore = fs.readFileSync(captured.file, 'utf8');
const patchBefore = fs.readFileSync(path.join(capturedDir, 'result.patch'), 'utf8');
const overwrite = baseRepair(capturedDir, repairEnv(sandboxPrefix));
assert.equal(overwrite.ok, false);
assert.match(overwrite.report.error, /captured candidate/);
assert.equal(fs.readFileSync(captured.file, 'utf8'), reportBefore);
assert.equal(fs.readFileSync(path.join(capturedDir, 'result.patch'), 'utf8'), patchBefore);

// A failure is persisted even when validation throws before the producer runs.
const failedDir = repairOut();
const failedRun = produce({
  promptPath: repairPrompt,
  sourceDir: path.join(failedDir, 'missing-source'),
  outDir: failedDir,
  manifestPath: repairManifest,
  ownedDir,
  timeoutMs: 20000,
  env: repairEnv(sandboxPrefix),
});
assert.equal(failedRun.ok, false);
assert.equal(failedRun.report.status, 'failed');
assert.match(failedRun.report.error, /pinned source/);
assert.ok(fs.existsSync(path.join(failedDir, 'result.json')));
assert.equal(fs.existsSync(path.join(failedDir, 'result.patch')), false);
assert.equal(JSON.parse(fs.readFileSync(path.join(failedDir, 'result.json'), 'utf8')).status, 'failed');

// A stale preflight patch is removed by a failing preflight.
const stalePreflight = repairOut();
fs.writeFileSync(path.join(stalePreflight, 'preflight.patch'), 'stale\n');
const preflightFail = produce({
  preflight: true,
  promptPath: repairPrompt,
  outDir: stalePreflight,
  timeoutMs: 10000,
  env: {...process.env, MODEL_PRODUCER_CMD: JSON.stringify([process.execPath, '-e', "process.stderr.write('403 blocked'); process.exit(1)"])},
});
assert.equal(preflightFail.report.status, 'blocked');
assert.equal(fs.existsSync(path.join(stalePreflight, 'preflight.patch')), false);

for (const dir of [wrapperDir, pinned.repo, promptDir, ownedDir, failedDir, stalePreflight, capturedDir]) {
  fs.rmSync(dir, {recursive: true, force: true});
}

console.log(JSON.stringify({
  schema: 'near-rehearsal/model-producer-tests/v1',
  cases: ['empty-output', 'prose-output', 'markdown-fence', 'prompt-placeholder', 'prompt-stdin', 'empty-argument', 'missing-command', 'invalid-command-json', 'producer-failure-propagation', 'preflight-blocked-report', 'preflight-nonce-success', 'preflight-nonce-mismatch', 'pinned-source-only-input', 'repair-requires-sandbox', 'sandbox-read-probe', 'sandbox-controller-write-probe', 'sandbox-workspace-write-probe', 'captured-candidate-and-evidence', 'captured-candidate-not-overwritten', 'failure-persisted-without-stale-candidate', 'stale-preflight-patch-removed'],
  passed: true,
}, null, 2));
