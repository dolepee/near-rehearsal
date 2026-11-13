'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verifySettlementReport} = require('./settlement-policy.cjs');

const HERE = __dirname;
const read = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'audit-intended', name, 'settlement-refund.json'), 'utf8'));

const oldReport = read('settlement-old');
const correctedReport = read('settlement');
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

const swapped = JSON.parse(JSON.stringify(correctedReport));
swapped.candidate.wasmSha256 = oldReport.candidate.wasmSha256;
assert.equal(verifySettlementReport(swapped, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false, 'a report bound to a different candidate must fail');

console.log(JSON.stringify({
  schema: 'near-rehearsal/settlement-policy-tests/v1',
  passed: true,
  cases: ['old-premature-fails', 'corrected-passes', 'candidate-binding-fails'],
}, null, 2));
