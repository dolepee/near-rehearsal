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

console.log(JSON.stringify({
  schema: 'near-rehearsal/model-producer-tests/v1',
  cases: ['empty-output', 'prose-output', 'markdown-fence', 'prompt-placeholder', 'prompt-stdin', 'empty-argument', 'missing-command', 'invalid-command-json', 'producer-failure-propagation', 'preflight-blocked-report', 'preflight-nonce-success', 'preflight-nonce-mismatch', 'pinned-source-only-input'],
  passed: true,
}, null, 2));
