'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verify, verifyCandidateFiles} = require('./acceptance.cjs');
const crypto = require('node:crypto');
const os = require('node:os');
const here = __dirname;
const base = JSON.parse(fs.readFileSync(path.join(here, 'out/issue238-local.json'), 'utf8'));
const repaired = JSON.parse(fs.readFileSync(path.join(here, 'out/issue238-repaired.json'), 'utf8'));
const partial = JSON.parse(fs.readFileSync(path.join(here, 'out/issue238-partial.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const expectFail = (label, mutate) => {
  const b = clone(base);
  const r = clone(repaired);
  mutate(b, r);
  const errors = verify(b, r);
  assert.ok(errors.length > 0, label);
  console.log(`rejected: ${label}`);
};
assert.deepEqual(verify(base, repaired), []);
console.log('accepted: base reproduction plus repaired control');

const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-candidate-'));
const candidatePatch = path.join(candidateDir, 'candidate.patch');
const candidateSource = path.join(candidateDir, 'proposals.rs');
const candidateWasm = path.join(candidateDir, 'sputnikdao2.wasm');
fs.writeFileSync(candidatePatch, 'diff --git a/sputnikdao2/src/proposals.rs b/sputnikdao2/src/proposals.rs\n');
fs.writeFileSync(candidateSource, 'controller-applied-source\n');
fs.writeFileSync(candidateWasm, Buffer.from([0x00, 0x61, 0x73, 0x6d]));
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const identity = {
  schema: 'near-rehearsal/repair-candidate-identity/v1',
  source: {commit: repaired.source.commit, path: 'sputnikdao2/src/proposals.rs', sha256: hashFile(candidateSource)},
  patch: {sha256: hashFile(candidatePatch)},
  wasm: {sha256: hashFile(candidateWasm), bytes: fs.statSync(candidateWasm).size},
};
const independent = clone(repaired);
independent.source.wasmSha256 = identity.wasm.sha256;
assert.deepEqual(verify(base, independent, {candidateIdentity: identity, candidateFiles: {patch: candidatePatch, source: candidateSource, wasm: candidateWasm}}), []);
console.log('accepted: controller-owned candidate identity with independent wasm hash');

const changedReport = clone(independent);
changedReport.source.wasmSha256 = '0'.repeat(64);
assert.ok(verify(base, changedReport, {candidateIdentity: identity}).some((e) => /controller-built candidate/.test(e)));
console.log('rejected: candidate report does not match controller-built wasm');

fs.writeFileSync(candidateWasm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01]));
assert.ok(verifyCandidateFiles(identity, {patch: candidatePatch, source: candidateSource, wasm: candidateWasm}).some((e) => /wasm hash/.test(e)));
console.log('rejected: built wasm changed after identity binding');
fs.writeFileSync(candidateWasm, Buffer.from([0x00, 0x61, 0x73, 0x6d]));
fs.rmSync(candidateDir, {recursive: true, force: true});
const partialErrors = verify(base, partial);
assert.ok(partialErrors.some((e) => /bond exactly once|artifact identity/.test(e)), 'partial source repair must reject');
console.log('rejected: partial source repair (Transfer-only bond return)');
expectFail('base failed branch hides the stranded bond', (b) => { b.failed.deltas.contract = '0'; });
expectFail('repair double-returns the bond', (b, r) => { r.failed.deltas.contract = '-1000000000000000000000000'; });
expectFail('healthy payout missing', (b, r) => { r.healthy.deltas.recipient = '0'; });
expectFail('failed proposal marked approved', (b, r) => { r.failed.after.proposal.status = 'Approved'; });
expectFail('repaired artifact identity changed', (b, r) => { r.source.wasmSha256 = '0'.repeat(64); });
expectFail('unauthorized callback recorded as accepted', (b, r) => { r.healthy.unauthorizedCallback.receipts[0].status = { SuccessValue: '' }; });
expectFail('unauthorized callback failed for an unrelated reason', (b, r) => {
  const receipt = r.healthy.unauthorizedCallback.receipts[0];
  receipt.status = {Failure: {ActionError: {kind: {FunctionCallError: {ExecutionError: 'Smart contract panicked: ERR_UNEXPECTED_CALLBACK_PROMISES'}}}}};
});
expectFail('unauthorized callback failed at the wrong executor', (b, r) => {
  const receipt = r.healthy.unauthorizedCallback.receipts[0];
  receipt.executorId = 'attacker.test.near';
});
expectFail('healthy beneficiary changed', (b, r) => { r.healthy.kind.Transfer.receiver_id = 'attacker.test.near'; });
expectFail('retry not executed but zero deltas', (b, r) => {
  r.failed.retry.final = null;
  r.failed.retry.summary = {error: 'Finalize was never executed'};
  r.failed.retry.after.proposal.status = 'Approved';
  r.failed.retry.deltas = {contract: '0', proposer: '0', recipient: '0'};
});
console.log(JSON.stringify({
  schema: 'near-rehearsal/repair-acceptance-tests/v1',
  positiveControl: true,
  cases: ['base-stranded-bond', 'double-refund', 'missing-payout', 'false-failed-status', 'artifact-identity', 'unauthorized-callback', 'beneficiary-immutability', 'retry-not-executed', 'partial-source-repair', 'candidate-identity-independent-wasm', 'candidate-identity-changed-report', 'candidate-identity-changed-wasm'],
  passed: true,
}, null, 2));
