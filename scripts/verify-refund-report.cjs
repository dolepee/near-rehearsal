'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {
  validateCase,
  validateCapture,
  parseCaptureState,
  transferEvidence,
  runtimePinMatches,
} = require('./refund-three-way.cjs');

const ROOT = path.join(__dirname, '..');

function fail(errors, message) {
  errors.push(message);
}

function verifyRefundReport(report, config, capture) {
  const errors = [];
  if (!report || typeof report !== 'object') return ['report is not an object'];
  if (report.schema !== 'near-rehearsal/refund-report/v1') fail(errors, 'unsupported report schema');
  if (report.case !== config.id) fail(errors, 'report case does not match');
  if (report.boundary !== config.boundary) fail(errors, 'report boundary does not match');
  if (JSON.stringify(report.operation) !== JSON.stringify(config.operation)) fail(errors, 'report operation does not match');
  if (JSON.stringify(report.migration) !== JSON.stringify(config.migration)) fail(errors, 'report migration does not match');

  let parsed;
  try {
    parsed = validateCapture(capture, config);
  } catch (error) {
    return [`capture invalid: ${error.message}`];
  }
  if (!report.capture || typeof report.capture !== 'object') return ['report capture is missing'];
  for (const key of ['codeHash', 'codeSha256', 'stateHash', 'stateBytes', 'beneficiary', 'entitlement', 'fundedNear', 'grossEntitlementNear', 'claimBoundary']) {
    if (report.capture[key] !== capture[key]) fail(errors, `report capture.${key} does not match`);
  }
  if (JSON.stringify(report.capture.runtime) !== JSON.stringify(capture.runtime)) fail(errors, 'report capture runtime does not match');
  if (report.capture.beneficiary !== parsed.beneficiary) fail(errors, 'report beneficiary does not match stored bytes');

  if (!report.result || report.result.status !== 'complete') fail(errors, 'report is not complete');
  const result = report.result || {};
  const candidateOutcome = report.result?.candidateOutcome;
  for (const key of ['sameStartingState', 'controls', 'claimTransferToBeneficiary', 'runtimePinned']) {
    if (result[key] !== true) fail(errors, `result.${key} is not true`);
  }
  if (candidateOutcome === 'no-refund' && result.badFailureIsStructured !== true) fail(errors, 'result.badFailureIsStructured is not true for NO_REFUND');
  if (candidateOutcome === 'paid' && result.badFailureIsStructured !== false) fail(errors, 'result.badFailureIsStructured must be false for paid candidate');
  if (JSON.stringify(result.expected) !== JSON.stringify(config.expected)) fail(errors, 'result expected outcomes do not match');

  const names = ['baseline', 'bad', 'corrected'];
  if (!report.branches || Object.keys(report.branches).sort().join(',') !== [...names].sort().join(',')) {
    return [...errors, 'report branches are not exactly baseline, bad, corrected'];
  }
  if (!['paid', 'no-refund'].includes(candidateOutcome)) fail(errors, 'candidate outcome is not classified');
  if (report.result?.candidateClassified !== true) fail(errors, 'candidate was not classified');
  if (config.expected.bad !== 'candidate' && candidateOutcome !== 'no-refund') fail(errors, 'fixed bad case must classify as no-refund');
  const expectedStatus = {baseline: 'completed', bad: config.expected.bad === 'candidate' ? (candidateOutcome === 'paid' ? 'completed' : 'expected-failure') : 'expected-failure', corrected: 'completed'};
  for (const name of names) {
    const branch = report.branches[name];
    if (!branch) { fail(errors, `missing ${name} branch`); continue; }
    if (branch.expected !== config.expected[name]) fail(errors, `${name} expected label mismatch`);
    if (branch.status !== expectedStatus[name]) fail(errors, `${name} status is ${branch.status}`);
    if (branch.runtimePinMatched !== true) fail(errors, `${name} runtime pin did not match`);
    if (branch.importCheck?.matches !== true) fail(errors, `${name} import identity did not match`);
    if (branch.beneficiary !== parsed.beneficiary) fail(errors, `${name} beneficiary does not match`);
    if (!branch.claim || !Array.isArray(branch.claim.receipts)) fail(errors, `${name} receipts are missing`);
    if (!branch.controls || branch.controls.outsiderDenied !== true || branch.controls.secondClaimDenied !== true) {
      fail(errors, `${name} claim controls did not pass`);
    }
    if (name !== 'baseline' && branch.controls?.migrationAuthorityDenied !== true) {
      fail(errors, `${name} migration authority control did not pass`);
    }
    if (!branch.entitlement || branch.entitlement.afterClaim !== '0') fail(errors, `${name} entitlement was not cleared`);
    if (name === 'bad' && candidateOutcome === 'no-refund') {
      if (branch.entitlement?.afterMigration !== '0') fail(errors, 'bad migration did not clear entitlement');
      if (branch.claim?.failed !== true) fail(errors, 'bad claim did not fail');
      if (!JSON.stringify(branch.claim?.receiptFailures || []).includes('NO_REFUND')) fail(errors, 'bad claim failure is not structured NO_REFUND');
      const link = transferEvidence(branch.claim, parsed.beneficiary, parsed.amount, branch.claim?.transfers || []);
      if (link.linked) fail(errors, 'bad claim has a beneficiary transfer link');
      if (branch.balances?.status !== 'interim') fail(errors, 'bad branch balance is not marked interim');
    } else if (name === 'bad' && candidateOutcome === 'paid') {
      if (branch.claim?.succeeded !== true) fail(errors, 'paid candidate claim did not succeed');
      const link = transferEvidence(branch.claim, parsed.beneficiary, parsed.amount, branch.claim?.transfers || []);
      if (!link.linked) fail(errors, 'paid candidate lacks contract -> beneficiary transfer link');
      if (!link.amountMatches) fail(errors, 'paid candidate gross transfer amount does not equal the inherited obligation');
      if (branch.balances?.status !== 'final') fail(errors, 'paid candidate balance is not final');
      if (!branch.balances?.user?.delta || BigInt(branch.balances.user.delta) <= 0n) fail(errors, 'paid candidate user delta is not positive');
      if (!branch.balances?.contract?.delta || BigInt(branch.balances.contract.delta) >= 0n) fail(errors, 'paid candidate contract delta is not negative');
    } else {
      if (branch.claim?.succeeded !== true) fail(errors, `${name} claim did not succeed`);
      const link = transferEvidence(branch.claim, parsed.beneficiary, parsed.amount, branch.claim?.transfers || []);
      if (!link.linked) fail(errors, `${name} lacks contract -> beneficiary transfer link`);
      if (!link.amountMatches) fail(errors, `${name} gross transfer amount does not equal the inherited obligation`);
      if (branch.balances?.status !== 'final') fail(errors, `${name} balance is not final`);
      if (!branch.balances?.user?.delta || BigInt(branch.balances.user.delta) <= 0n) fail(errors, `${name} user delta is not positive`);
      if (!branch.balances?.contract?.delta || BigInt(branch.balances.contract.delta) >= 0n) fail(errors, `${name} contract delta is not negative`);
    }
  }
  if (report.result?.badFailureIsStructured !== (candidateOutcome === 'no-refund')) fail(errors, 'badFailureIsStructured does not match candidate outcome');
  if (report.result?.claimTransferToBeneficiary !== true) fail(errors, 'claimTransferToBeneficiary is not true');
  return errors;
}

if (require.main === module) {
  const reportFile = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'out/refund-report.json');
  const caseFile = process.argv[3] ? path.resolve(process.argv[3]) : path.join(ROOT, 'cases/refund-v1/case.json');
  const captureFile = process.argv[4] ? path.resolve(process.argv[4]) : path.join(ROOT, 'out/refund-capture.json');
  try {
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    const config = validateCase(caseFile);
    const capture = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    const errors = verifyRefundReport(report, config, capture);
    if (errors.length) {
      console.error(JSON.stringify({ok: false, errors}, null, 2));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ok: true, status: 'complete', case: config.id}, null, 2));
    }
  } catch (error) {
    console.error(JSON.stringify({ok: false, errors: [error.message]}, null, 2));
    process.exitCode = 1;
  }
}

module.exports = {verifyRefundReport};
