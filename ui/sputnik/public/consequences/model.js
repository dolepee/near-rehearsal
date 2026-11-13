/* Shared, dependency-free validation and interaction helpers for the recorded workbench. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ConsequenceModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const integer = (value) => typeof value === 'string' || typeof value === 'number' ? /^-?[0-9]+$/.test(String(value)) : false;
  const requiredStageIds = ['deploy', 'init', 'addProposal', 'update', 'approve', 'replay', 'finalizeRetry'];

  function validateRepairCandidate(candidate) {
    if (!isObject(candidate)) return {ok: false, reason: 'candidate is missing'};
    if (!['ACCEPTED', 'REJECTED'].includes(candidate.status)) return {ok: false, reason: `unknown decision status: ${String(candidate.status)}`};
    if (!Array.isArray(candidate.errors)) return {ok: false, reason: 'candidate errors are missing'};
    if (!isObject(candidate.outcomes)) return {ok: false, reason: 'candidate outcomes are missing'};
    if (!isObject(candidate.cash)) return {ok: false, reason: 'candidate cash fields are missing'};
    for (const field of ['aliceBondGross', 'aliceBondNet', 'aliceGas', 'bobTransfer', 'bobBondReturned', 'bobContractDelta']) {
      if (!integer(candidate.cash[field])) return {ok: false, reason: `candidate cash.${field} is missing or non-integer`};
    }
    if (!Array.isArray(candidate.stages) || candidate.stages.length !== 7) return {ok: false, reason: 'candidate must contain seven recorded stages'};
    const locked = [];
    for (const stage of candidate.stages) {
      if (!integer(stage?.locked)) return {ok: false, reason: 'recorded stage is missing an integer locked liability'};
      locked.push(BigInt(stage.locked));
    }
    const expected = candidate.status === 'ACCEPTED'
      ? [2n, 2n, 1n, 1n, 0n, 0n, 0n]
      : [2n, 2n, 0n, 0n, 0n, 0n, 0n];
    if (!locked.every((value, index) => value === expected[index] * 1000000000000000000000000n)) {
      return {ok: false, reason: 'recorded ledger does not match the decision'};
    }
    if (candidate.status === 'ACCEPTED' && (candidate.errors.length > 0 || candidate.outcomes.alicePaid !== true || candidate.outcomes.bobPaidExactlyOnce !== true)) {
      return {ok: false, reason: 'accepted status contradicts its errors or outcomes'};
    }
    if (candidate.status === 'REJECTED' && (candidate.errors.length === 0 || candidate.outcomes.bobPaidExactlyOnce === true)) {
      return {ok: false, reason: 'rejected status contradicts its errors or outcomes'};
    }
    return {ok: true};
  }

  function validateUpgrade(record) {
    if (!isObject(record)) return {ok: false, reason: 'upgrade record is missing'};
    if (record.status !== 'PASS') return {ok: false, reason: `unknown upgrade status: ${String(record.status)}`};
    if (!isObject(record.result)) return {ok: false, reason: 'upgrade result is missing'};
    if (String(record.result.firstPaymentNear) !== '1' || String(record.result.totalDeltaNear) !== '1') return {ok: false, reason: 'upgrade payment amounts are not the recorded 1 NEAR'};
    if (!Array.isArray(record.result.retries) || record.result.retries.length !== 2 || record.result.retries.some((retry) => retry?.status !== 'rejected')) return {ok: false, reason: 'both retry routes are not recorded as rejected'};
    if (!Array.isArray(record.stages) || record.stages.length !== 7) return {ok: false, reason: 'upgrade must contain seven recorded stages'};
    const ids = record.stages.map((stage) => stage?.id);
    if (!requiredStageIds.every((id, index) => ids[index] === id)) return {ok: false, reason: 'upgrade stage order is incomplete'};
    if (!isObject(record.checks) || record.checks.nodePassed !== true || record.checks.nativePassed !== true) return {ok: false, reason: 'upgrade checks are not both recorded as passed'};
    return {ok: true};
  }

  function bindCandidateSwitch(root, onSelect) {
    if (!root || typeof root.addEventListener !== 'function') return false;
    if (root.__consequenceCandidateBound) return true;
    root.__consequenceCandidateBound = true;
    root.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-candidate]');
      if (!button || (typeof root.contains === 'function' && !root.contains(button))) return;
      onSelect(button.dataset.candidate, button);
    });
    return true;
  }

  return {validateRepairCandidate, validateUpgrade, bindCandidateSwitch};
});
