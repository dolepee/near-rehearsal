'use strict';
/*
 * Pure classification used by local-three-branch.cjs. Keeping this separate
 * makes the primary runner's green/red decision testable without a Sandbox.
 */
function classifyBranch(checks, role) {
  if (role !== 'baseline' && (!checks?.upgradeSucceeded || !checks?.codeMatches)) return 'inconclusive';
  if (checks?.operationRegressed) return 'regressed';
  if (checks?.operationSucceeded === true
    && checks?.payoutExactlyBond === true
    && checks?.retryFailed === true
    && checks?.retryDidNotPay === true) return 'preserved';
  return 'inconclusive';
}
module.exports = {classifyBranch};
