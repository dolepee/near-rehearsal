'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {validateCase, validateCapture} = require('./refund-three-way.cjs');
const {verifyRefundReport} = require('./verify-refund-report.cjs');

const ROOT = path.join(__dirname, '..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const baseCase = validateCase(path.join(ROOT, 'cases/refund-v1/case.json'));
const halfCase = validateCase(path.join(ROOT, 'cases/refund-v1/half-case.json'));
const capture = read('out/refund-capture.json');
validateCapture(capture, baseCase);

const base = read('out/refund-report.json');
assert.deepEqual(verifyRefundReport(base, baseCase, capture), []);
assert.equal(base.result.status, 'complete');
for (const name of ['baseline', 'bad', 'corrected']) {
  const branch = base.branches[name];
  if (name === 'bad') continue;
  assert.equal(branch.transfer.amount, capture.entitlement, `${name} full transfer amount`);
  assert.equal(branch.transfer.amountMatches, true, `${name} amount proof`);
}

const unverified = JSON.parse(JSON.stringify(base));
unverified.branches.baseline.claim.transfers = [];
const unverifiedErrors = verifyRefundReport(unverified, baseCase, capture);
assert(unverifiedErrors.includes('baseline gross transfer amount does not equal the inherited obligation'));

const half = read('out/refund-half-report.json');
assert.equal(half.result.status, 'incomplete');
assert.equal(half.result.candidateOutcome, 'amount-regression');
assert.equal(half.result.claimTransferToBeneficiary, false);
assert.equal(half.branches.bad.status, 'amount-regression');
assert.equal(half.branches.bad.transfer.amount, '50000000000000000000000');
assert.equal(half.branches.bad.transfer.amountMatches, false);
assert.equal(half.branches.bad.transfer.linked, true);
assert.equal(half.branches.bad.claim.transfers[0].amount, '50000000000000000000000');
const halfErrors = verifyRefundReport(half, halfCase, capture);
assert(halfErrors.includes('report is not complete'));
assert(halfErrors.some((error) => error.includes('bad gross transfer amount does not equal the inherited obligation')));
assert.throws(() => execFileSync(process.execPath, [
  'scripts/export-refund-replay.cjs',
  '--case', 'cases/refund-v1/half-case.json',
  '--report', 'out/refund-half-report.json',
  '--out', 'out/half-export-must-reject',
], {cwd: ROOT, stdio: 'pipe'}), /Command failed/);
assert.equal(fs.existsSync(path.join(ROOT, 'out/half-export-must-reject')), false, 'half export must not create a bundle');

const app = fs.readFileSync(path.join(ROOT, 'ui/public/app.js'), 'utf8');
assert.match(app, /AMOUNT REGRESSION/);
assert.match(app, /UNDERPAID/);
assert.match(app, /amountMatches/);
assert.match(app, /Gross transfer/);
assert.match(app, /not exportable as release evidence/);
console.log(JSON.stringify({
  ok: true,
  fullAmount: base.branches.baseline.transfer.amount,
  halfAmount: half.branches.bad.transfer.amount,
  halfOutcome: half.result.candidateOutcome,
  halfVerifierErrors: halfErrors,
}, null, 2));
