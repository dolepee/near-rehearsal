'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateCaseConfig,
  validateCapture,
  transferEvidence,
} = require('./refund-three-way.cjs');

const ROOT = path.join(__dirname, '..');
const casePath = path.join(ROOT, 'cases/refund-v1/case.json');
const capturePath = path.join(ROOT, 'out/refund-capture.json');
const baseCase = JSON.parse(fs.readFileSync(casePath, 'utf8'));
const baseCapture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const expectThrow = (fn, label) => {
  assert.throws(fn, undefined, label);
  console.log(`rejected: ${label}`);
};

validateCaseConfig(baseCase);
validateCapture(baseCapture, baseCase);
console.log('accepted: original case and capture');

expectThrow(() => validateCaseConfig({...clone(baseCase), unsupportedField: true}), 'unknown case field');
expectThrow(() => {
  const config = clone(baseCase);
  config.candidates.bad.unsupportedField = true;
  validateCaseConfig(config);
}, 'unknown candidate field');
expectThrow(() => {
  const capture = clone(baseCapture);
  capture.codeSha256 = '0'.repeat(64);
  validateCapture(capture, baseCase);
}, 'capture codeSha256 mismatch');
expectThrow(() => {
  const capture = clone(baseCapture);
  capture.beneficiary = 'attacker.test.near';
  validateCapture(capture, baseCase);
}, 'capture beneficiary mismatch');
expectThrow(() => {
  const capture = clone(baseCapture);
  capture.entitlement = '1';
  validateCapture(capture, baseCase);
}, 'capture entitlement mismatch');
expectThrow(() => {
  const capture = clone(baseCapture);
  capture.runtime.commit = '0'.repeat(40);
  validateCapture(capture, baseCase);
}, 'capture runtime mismatch');
expectThrow(() => validateCapture(baseCapture, baseCase, {...baseCapture.runtime, protocolVersion: 1}), 'actual runtime mismatch');

const linked = transferEvidence({
  receipts: [
    {id: 'contract', executorId: 'refund.test.near', status: {SuccessReceiptId: 'beneficiary'}},
    {id: 'beneficiary', executorId: 'refunduser.test.near', status: {SuccessValue: ''}},
    {id: 'gas-refund', executorId: 'refunduser.test.near', status: {SuccessValue: ''}},
  ],
}, 'refunduser.test.near');
assert.equal(linked.linked, true);
assert.equal(linked.links[0].contractReceiptId, 'contract');
assert.equal(linked.links[0].beneficiaryReceiptId, 'beneficiary');
console.log('accepted: contract SuccessReceiptId -> beneficiary SuccessValue link');

const gasOnly = transferEvidence({
  receipts: [
    {id: 'contract', executorId: 'refund.test.near', status: {SuccessValue: ''}},
    {id: 'gas-refund', executorId: 'refunduser.test.near', status: {SuccessValue: ''}},
  ],
}, 'refunduser.test.near');
assert.equal(gasOnly.linked, false);
console.log('rejected: unrelated beneficiary gas-refund receipt is not a transfer link');
