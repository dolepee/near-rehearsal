'use strict';
// Fast guard tests for the operator handoff. The end-to-end source build is
// exercised by `npm run repair:review`; these tests catch a bad export before
// anything is written or run.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { checkBundle, formatYocto, yoctoNear, preflight } = require('./repair-review.cjs');

const fixture = path.join(__dirname, '..', 'test-fixtures', 'repair-browser-export-1de7b8c5.json');
const original = JSON.parse(fs.readFileSync(fixture, 'utf8'));
const copy = () => JSON.parse(JSON.stringify(original));
const rejects = (label, mutate) => {
  const bundle = copy();
  mutate(bundle);
  assert.throws(() => checkBundle(bundle), undefined, label);
};

const accepted = checkBundle(copy());
assert.equal(accepted.sourceIdentity.path, 'sputnikdao2/src/proposals.rs');
assert.equal(accepted.sourceIdentity.sha256, original.candidate.identity.source.sha256);
assert.equal(accepted.wasm.length, original.candidate.wasm.bytes);
assert.equal(yoctoNear('1000000000000000000000000'), '1 NEAR');
assert.equal(yoctoNear('1'), '0.000000000000000000000001 NEAR');
assert.equal(yoctoNear('0'), '0 NEAR');
assert.equal(formatYocto('-640685704355800000000'), '-0.0006406857043558 NEAR');
assert.equal(formatYocto('-1'), '-0.000000000000000000000001 NEAR');

rejects('schema', (b) => { b.schema = 'near-rehearsal/other/v1'; });
rejects('run id', (b) => { b.runId = ''; });
rejects('case id', (b) => { b.caseId = 'other-case'; });
rejects('source commit', (b) => { b.source.commit = ''; });
rejects('build toolchain', (b) => { b.build.rust = '1.99.1'; });
rejects('patch text hash', (b) => { b.candidate.patch.text += '\n'; });
rejects('wasm bytes hash', (b) => { b.candidate.wasm.base64 = Buffer.from('not the candidate').toString('base64'); });
rejects('wasm byte count', (b) => { b.candidate.wasm.bytes += 1; });
rejects('baseline report hash', (b) => { b.baseline.reportText += ' '; });
rejects('recovery report hash', (b) => { b.recovery.reportText += ' '; });
rejects('failed recovery acceptance', (b) => { b.recovery.acceptance.ok = false; });
rejects('acceptance candidate mismatch', (b) => { b.recovery.acceptance.candidateWasmSha256 = '0'.repeat(64); });
rejects('artifact patch mismatch', (b) => { b.recovery.artifacts.patch.sha256 = '0'.repeat(64); });
rejects('artifact wasm mismatch', (b) => { b.recovery.artifacts.wasm.sha256 = '0'.repeat(64); });
rejects('identity patch mismatch', (b) => { b.candidate.identity.patch.sha256 = '0'.repeat(64); });
rejects('identity source mismatch', (b) => { b.candidate.identity.source.sha256 = '0'.repeat(64); });
rejects('missing source identity', (b) => { delete b.candidate.identity.source; delete b.recovery.artifacts.source; });

// The documented normal setup uses REPAIR_SANDBOX_DIR without --sandbox-dir.
// Preflight must resolve it and must not reserve/write the output directory.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-review-preflight-'));
const sandbox = path.join(scratch, 'sandbox');
const out = path.join(scratch, 'out');
fs.mkdirSync(sandbox);
fs.writeFileSync(path.join(sandbox, 'near-sandbox'), '');
try {
  process.env.REPAIR_SANDBOX_DIR = sandbox;
  const base = path.join(__dirname, '..', 'case-triage', 'rehearsal-repair', 'bundle', 'artifacts', 'base.wasm');
  const plan = preflight(copy(), { mode: 'recorded-wasm', baseWasm: base }, out);
  assert.equal(plan.sandboxDir, sandbox);
  assert.equal(fs.existsSync(out), false, 'preflight must not reserve the output directory');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'evidence.json'), '{}');
  assert.throws(() => preflight(copy(), { mode: 'recorded-wasm', baseWasm: base }, out), /not empty/);
} finally {
  delete process.env.REPAIR_SANDBOX_DIR;
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(JSON.stringify({
  schema: 'near-rehearsal/repair-review-guards/v1',
  ok: true,
  checks: 21,
  fixture: path.relative(path.join(__dirname, '..'), fixture),
  fixtureSha256: crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'),
}, null, 2));
