'use strict';
const assert = require('node:assert/strict');
const {classifyBranch} = require('./classification.cjs');
const base = {
  upgradeSucceeded: true, codeMatches: true,
  operationSucceeded: true, operationRegressed: false,
  payoutExactlyBond: true, retryFailed: true, retryDidNotPay: true,
};
assert.equal(classifyBranch(base, 'candidate'), 'preserved');
assert.equal(classifyBranch({...base, payoutExactlyBond: false}, 'candidate'), 'inconclusive', 'nonpaying candidate must not be green');
assert.equal(classifyBranch({...base, payoutExactlyBond: false}, 'corrected'), 'inconclusive', 'nonpaying correction must not be green');
assert.equal(classifyBranch({...base, upgradeSucceeded: false}, 'candidate'), 'inconclusive');
assert.equal(classifyBranch({...base, operationRegressed: true, operationSucceeded: false, payoutExactlyBond: false}, 'candidate'), 'regressed');
assert.equal(classifyBranch({...base, operationRegressed: true, operationSucceeded: false, payoutExactlyBond: false}, 'baseline'), 'regressed');
console.log(JSON.stringify({
  schema: 'near-rehearsal/sputnik-runner-classification/v1',
  cases: ['paid-preserved', 'candidate-no-payout', 'correction-no-payout', 'failed-upgrade', 'candidate-regressed', 'baseline-regressed'],
  passed: true,
}, null, 2));
