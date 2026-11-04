'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {validateCase} = require('./refund-three-way.cjs');
const {verifyRefundReport} = require('./verify-refund-report.cjs');
const {verifyBundle} = require('./verify-refund-export.cjs');

const ROOT = path.join(__dirname, '..');
const caseConfig = validateCase(path.join(ROOT, 'cases/refund-v1/case.json'));
const capture = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/refund-capture.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/refund-report.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const expectFail = (fn, label) => {
  const errors = fn();
  assert.ok(errors.length > 0, label);
  console.log(`rejected: ${label}`);
};

assert.deepEqual(verifyRefundReport(report, caseConfig, capture), []);
console.log('accepted: current complete report');

expectFail(() => {
  const bad = clone(report);
  bad.result.status = 'incomplete';
  return verifyRefundReport(bad, caseConfig, capture);
}, 'tampered complete flag');

expectFail(() => {
  const bad = clone(report);
  bad.result.claimTransferToBeneficiary = false;
  return verifyRefundReport(bad, caseConfig, capture);
}, 'tampered payout gate');

expectFail(() => {
  const bad = clone(report);
  bad.branches.corrected.claim.receipts = bad.branches.corrected.claim.receipts.filter((receipt) => receipt.executorId !== 'refunduser.test.near');
  return verifyRefundReport(bad, caseConfig, capture);
}, 'tampered beneficiary receipt link');

expectFail(() => {
  const bad = clone(capture);
  bad.beneficiary = 'outsider.test.near';
  return verifyRefundReport(report, caseConfig, bad);
}, 'tampered capture beneficiary');

const exportsRoot = path.join(ROOT, 'out/exports');
const bundles = fs.existsSync(exportsRoot)
  ? fs.readdirSync(exportsRoot).filter((name) => name.startsWith('refund-v1-')).map((name) => path.join(exportsRoot, name))
  : [];
for (const bundleDir of bundles) {
  assert.deepEqual(verifyBundle(bundleDir), []);
  console.log(`accepted: exported bundle hashes and evidence (${path.basename(bundleDir)})`);
}
