'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verifySettlementReport, REQUIRED_SCHEMA, DEFAULT_BASE_WASM_SHA256} = require('./settlement-policy.cjs');

const HERE = __dirname;
const read = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'audit-intended', name, 'settlement-refund.json'), 'utf8'));

const oldReport = read('settlement-old');
const correctedReport = read('settlement');
assert.equal(oldReport.schema, REQUIRED_SCHEMA);
assert.equal(correctedReport.schema, REQUIRED_SCHEMA);
assert.equal(oldReport.candidate.wasmSha256, '49a5120cee5f4e453a37e40b18231ce9b0fef95c08dca4fdbf23f102937eb923');
assert.equal(correctedReport.candidate.wasmSha256, 'fe4401bcc33aedb7992ffa5163570355fc1757e123bd588aa4f9a84302967a0c');

const oldCheck = verifySettlementReport(oldReport, {candidateWasmSha256: oldReport.candidate.wasmSha256});
const correctedCheck = verifySettlementReport(correctedReport, {candidateWasmSha256: correctedReport.candidate.wasmSha256});
assert.equal(oldCheck.ok, false, 'the premature-settlement candidate must fail the shared policy');
assert.equal(correctedCheck.ok, true, correctedCheck.errors.join('; '));
assert.ok(oldCheck.errors.some((error) => /locked debt/.test(error)));
assert.ok(oldCheck.errors.some((error) => /retry proposer delta/.test(error)));
assert.equal(correctedCheck.outcomes.failedRefundLocked, '1000000000000000000000000');
assert.equal(correctedCheck.outcomes.retryDelta, '1000000000000000000000000');
assert.equal(correctedCheck.outcomes.overlapDelta, '1000000000000000000000000');
assert.equal(correctedCheck.outcomes.fresh.failedRefundLocked, '1000000000000000000000000', 'the fresh candidate scenario must also retain the debt');
assert.equal(correctedCheck.outcomes.inherited.failedRefundLocked, '1000000000000000000000000', 'the inherited scenario must retain the debt');

const swapped = JSON.parse(JSON.stringify(correctedReport));
swapped.candidate.wasmSha256 = oldReport.candidate.wasmSha256;
assert.equal(verifySettlementReport(swapped, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false, 'a report bound to a different candidate must fail');

const candidateOnly = JSON.parse(JSON.stringify(correctedReport));
candidateOnly.baseWasmSha256 = null;
candidateOnly.inherited.legacy = null;
delete candidateOnly.inherited.transactions.upgrade;
const candidateOnlyCheck = verifySettlementReport(candidateOnly, {candidateWasmSha256: correctedReport.candidate.wasmSha256});
assert.equal(candidateOnlyCheck.ok, false, 'settlement that never entered the pinned old-code upgrade path must fail');
assert.ok(candidateOnlyCheck.errors.some((error) => /legacy upgrade proof is missing/.test(error)));

const missingFresh = JSON.parse(JSON.stringify(correctedReport));
delete missingFresh.fresh;
const missingFreshCheck = verifySettlementReport(missingFresh, {candidateWasmSha256: correctedReport.candidate.wasmSha256});
assert.equal(missingFreshCheck.ok, false, 'a report without the fresh candidate scenario must fail');
assert.ok(missingFreshCheck.errors.some((error) => /settlement scenario is missing/.test(error)));

const wrongBase = JSON.parse(JSON.stringify(correctedReport));
wrongBase.baseWasmSha256 = oldReport.candidate.wasmSha256;
assert.equal(verifySettlementReport(wrongBase, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a report for a different base artifact must fail');
assert.equal(verifySettlementReport(correctedReport, {candidateWasmSha256: correctedReport.candidate.wasmSha256, baseWasmSha256: oldReport.candidate.wasmSha256}).ok, false,
  'a pinned base identity that does not match the report must fail');
assert.equal(DEFAULT_BASE_WASM_SHA256, correctedReport.baseWasmSha256);

const oneObservableTx = JSON.parse(JSON.stringify(correctedReport));
oneObservableTx.inherited.overlap.attempts[1].transactionHash = oneObservableTx.inherited.overlap.attempts[0].transactionHash;
const oneTxCheck = verifySettlementReport(oneObservableTx, {candidateWasmSha256: correctedReport.candidate.wasmSha256});
assert.equal(oneTxCheck.ok, false, 'one transaction observed twice is not overlap evidence');
assert.ok(oneTxCheck.errors.some((error) => /two distinct transactions/.test(error)));

const oneSigner = JSON.parse(JSON.stringify(correctedReport));
oneSigner.inherited.overlap.attempts[1].signerId = oneSigner.inherited.overlap.attempts[0].signerId;
assert.equal(verifySettlementReport(oneSigner, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'overlap attempts from one signer are not independently submitted');

const noReceipts = JSON.parse(JSON.stringify(correctedReport));
noReceipts.fresh.overlap.attempts[0].receiptIds = [];
assert.equal(verifySettlementReport(noReceipts, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'an overlap attempt without executed receipts cannot count');

const freshLeak = JSON.parse(JSON.stringify(correctedReport));
freshLeak.fresh.legacy = correctedReport.inherited.legacy;
assert.equal(verifySettlementReport(freshLeak, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the fresh scenario cannot claim inherited-upgrade evidence');

console.log(JSON.stringify({
  schema: 'near-rehearsal/settlement-policy-tests/v2',
  passed: true,
  cases: [
    'old-premature-fails',
    'corrected-passes',
    'candidate-binding-fails',
    'candidate-only-fails',
    'missing-fresh-fails',
    'wrong-base-fails',
    'repeated-hash-fails',
    'single-signer-fails',
    'receiptless-fails',
    'fresh-legacy-leak-fails',
  ],
}, null, 2));
