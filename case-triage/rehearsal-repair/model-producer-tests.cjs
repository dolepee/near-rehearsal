'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {extractDiff, materialize, produce, producerArgv, runProducer} = require('./model-producer.cjs');

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

console.log(JSON.stringify({
  schema: 'near-rehearsal/model-producer-tests/v1',
  cases: ['empty-output', 'prose-output', 'markdown-fence', 'prompt-placeholder', 'prompt-stdin', 'empty-argument', 'missing-command', 'invalid-command-json', 'producer-failure-propagation', 'preflight-blocked-report'],
  passed: true,
}, null, 2));
