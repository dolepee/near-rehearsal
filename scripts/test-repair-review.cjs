'use strict';
// Fast guard tests for the operator handoff. The end-to-end source build is
// exercised by `npm run repair:review`; these tests catch a bad export before
// anything is written or run.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { checkBundle, compareMixed, formatYocto, yoctoNear, preflight } = require('./repair-review.cjs');
const { buildReviewBundle } = require('../case-triage/rehearsal-repair/review-bundle.cjs');

const fixture = path.join(__dirname, '..', 'test-fixtures', 'repair-browser-export-1de7b8c5.json');
const original = JSON.parse(fs.readFileSync(fixture, 'utf8'));
const copy = () => JSON.parse(JSON.stringify(original));
const rejects = (label, mutate) => {
  const bundle = copy();
  mutate(bundle);
  assert.throws(() => checkBundle(bundle), undefined, label);
};

const mixedOriginal = buildReviewBundle({
  runId: 'mixed-policy-guard',
  patchPath: path.join(__dirname, '..', 'case-triage', 'rehearsal-repair', 'generated/e8262f5a/repair.patch'),
  wasmPath: path.join(__dirname, '..', 'case-triage', 'rehearsal-repair', 'generated/e8262f5a/candidate.wasm'),
  candidateIdentityPath: path.join(__dirname, '..', 'case-triage', 'rehearsal-repair', 'generated/e8262f5a/candidate-identity.json'),
  baseReportPath: path.join(__dirname, '..', 'case-triage', 'rehearsal-repair', 'out/issue238-local.json'),
  candidateReportPath: path.join(__dirname, '..', 'case-triage', 'rehearsal-repair', 'out/issue238-repaired.json'),
  recoveryPath: path.join(__dirname, '..', 'case-triage', 'rehearsal-repair', 'out/persisted-recovery.json'),
  acceptancePath: path.join(__dirname, '..', 'case-triage', 'rehearsal-repair', 'out/persisted-recovery-acceptance.json'),
  mixedPath: path.join(__dirname, '..', 'case-triage', 'rehearsal-repair', 'out/mixed-obligation-intended.json'),
});
assert.doesNotThrow(() => checkBundle(mixedOriginal));
for (const [label, mutate] of [
  ['fake mixed report', (b) => { b.mixed.reportText = 'not a real mixed report'; b.mixed.reportSha256 = '0'.repeat(64); }],
  ['zero mixed policy', (b) => { b.mixed.policySha256 = '0'.repeat(64); }],
  ['mixed different candidate', (b) => { b.mixed.candidateWasmSha256 = '0'.repeat(64); }],
]) {
  const b = JSON.parse(JSON.stringify(mixedOriginal));
  mutate(b);
  assert.throws(() => checkBundle(b), undefined, label);
}

const outcomes = {alicePaid: true, bobLiabilityAfterAlice: true, bobTransferPaid: true, bobPaidExactlyOnce: true, aliceLockedDelta: '-1000000000000000000000000', bobLockedDelta: '-1000000000000000000000000', bobRecipientDelta: '100000000000000000000000', bobProposerDelta: '1000000000000000000000000'};
const sameBytes = compareMixed({outcomes, candidate: {wasmSha256: 'a'.repeat(64)}}, {outcomes}, 'a'.repeat(64), 'a'.repeat(64));
assert.equal(sameBytes.candidateMatches, true);
const legacy = compareMixed(null, {ok: true, outcomes}, 'a'.repeat(64), 'a'.repeat(64));
assert.equal(legacy.legacy, true);
assert.equal(legacy.candidateMatches, null);
assert.deepEqual(legacy.reviewer, sameBytes.reviewer, 'both comparison branches expose reviewer outcomes directly');
const rebuiltDifferent = compareMixed({outcomes, candidate: {wasmSha256: 'a'.repeat(64)}}, {outcomes}, 'b'.repeat(64), 'b'.repeat(64));
assert.equal(rebuiltDifferent.candidateMatches, false, 'rebuilt artifact bytes must not be called equivalent to the producer');
assert.equal(rebuiltDifferent.artifactMismatch, false);
const reviewerArtifactMismatch = compareMixed({outcomes, candidate: {wasmSha256: 'a'.repeat(64)}}, {outcomes}, 'a'.repeat(64), 'c'.repeat(64));
assert.equal(reviewerArtifactMismatch.artifactMismatch, true);
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
rejects('candidate report text', (b) => { b.candidate.reportText += ' '; });
rejects('candidate report digest', (b) => { b.candidate.reportSha256 = '0'.repeat(64); });
rejects('missing candidate report', (b) => { delete b.candidate.reportText; });
rejects('recovery report hash', (b) => { b.recovery.reportText += ' '; });
rejects('failed recovery acceptance', (b) => { b.recovery.acceptance.ok = false; });
rejects('acceptance candidate mismatch', (b) => { b.recovery.acceptance.candidateWasmSha256 = '0'.repeat(64); });
rejects('artifact patch mismatch', (b) => { b.recovery.artifacts.patch.sha256 = '0'.repeat(64); });
rejects('artifact wasm mismatch', (b) => { b.recovery.artifacts.wasm.sha256 = '0'.repeat(64); });
rejects('identity patch mismatch', (b) => { b.candidate.identity.patch.sha256 = '0'.repeat(64); });
rejects('identity source mismatch', (b) => { b.candidate.identity.source.sha256 = '0'.repeat(64); });
rejects('missing candidate identity text', (b) => { delete b.candidate.identityText; });
rejects('missing recovery identity text', (b) => { delete b.recovery.identityText; });
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
  checks: 26,
  fixture: path.relative(path.join(__dirname, '..'), fixture),
  fixtureSha256: crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'),
}, null, 2));
