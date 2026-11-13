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
    const cash = Object.fromEntries(Object.entries(candidate.cash).map(([key, value]) => [key, BigInt(value)]));
    if (cash.aliceBondGross !== 1000000000000000000000000n) return {ok: false, reason: 'Alice bond gross is not 1 NEAR'};
    if (cash.aliceGas <= 0n) return {ok: false, reason: 'measured gas must be positive'};
    if (cash.aliceBondGross - cash.aliceGas !== cash.aliceBondNet) return {ok: false, reason: 'Alice gross minus gas does not equal net'};
    if (cash.bobTransfer !== 100000000000000000000000n) return {ok: false, reason: 'Bob transfer is not the recorded 0.1 NEAR'};
    if (cash.bobBondReturned !== 1000000000000000000000000n) return {ok: false, reason: 'Bob bond return is not 1 NEAR'};
    if (cash.bobContractDelta !== -(cash.bobTransfer + cash.bobBondReturned)) return {ok: false, reason: 'Bob contract debit does not equal transfer plus bond'};
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
    const expectedResults = ['success', 'success', 'success', 'success', 'success', 'failure', 'failure'];
    if (!record.stages.every((stage, index) => stage?.result === expectedResults[index])) return {ok: false, reason: 'upgrade stage results do not match the recorded prerequisites and rejected retries'};
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
