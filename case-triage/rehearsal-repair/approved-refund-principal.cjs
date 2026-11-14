'use strict';
// Principal reconciliation for the approved-action refund branch. The payer's
// balance delta is negative gas for a zero-principal retry, so the gas must be
// added back before comparing against the recorded bond.
function reconcilePrincipal({before, after, gas}) {
  return BigInt(after) - BigInt(before) + BigInt(gas);
}

module.exports = {reconcilePrincipal};
