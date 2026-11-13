'use strict';
/*
 * Recompute the same-DAO policy from the recorded snapshots. The runner's
 * checks field is evidence, not authority: this function must fail a candidate
 * whose aggregate locked amount is zeroed while Bob's obligation remains.
 */
const BOND = 10n ** 24n;
const TRANSFER = 10n ** 23n;
const SOURCE = '5434a59dec23ee0c49df8c8c4350c208a7e75b0b';
const BASE_WASM = '5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578';
const big = (value) => {
  try { return BigInt(value ?? 0); } catch { return 0n; }
};
const delta = (after, before, key) => big(after?.[key]) - big(before?.[key]);
const balanceDelta = (after, before, name) => big(after?.balances?.[name]) - big(before?.balances?.[name]);

function verifyMixedReport(report, opts = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (report?.schema !== 'near-rehearsal/mixed-obligation/v1') fail('schema');
  if (report?.source?.commit !== SOURCE) fail('source commit');
  if (report?.source?.baseWasmSha256 !== BASE_WASM) fail('base artifact');
  if (opts.requireBlockPinned) {
    for (const name of ['beforeUpgrade', 'afterUpgrade']) {
      const snap = report?.[name];
      if (!snap?.blockHash || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(snap.blockHash) || !/^[0-9]+$/.test(String(snap.blockHeight ?? ''))) fail(`${name} is not pinned to a final block`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(report?.candidate?.wasmSha256 || '')) fail('candidate hash missing');
  if (report?.candidate?.wasmHash !== report?.afterUpgrade?.codeHash) fail('candidate code was not applied');

  const before = report?.beforeUpgrade;
  const afterUpgrade = report?.afterUpgrade;
  if (big(before?.lockedAmount) !== BOND * 2n) fail('two pre-upgrade bond liabilities were not locked');
  if (before?.proposals?.alice?.status !== 'Failed') fail('Alice was not Failed before upgrade');
  if (before?.proposals?.bob?.status !== 'InProgress') fail('Bob was not pending before upgrade');
  if (before?.proposals?.carol?.status !== 'Approved') fail('Carol was not already paid');
  if (big(afterUpgrade?.lockedAmount) !== BOND * 2n) fail('upgrade changed the two locked liabilities');
  for (const name of ['alice', 'bob', 'carol']) {
    if (JSON.stringify(afterUpgrade?.proposals?.[name]) !== JSON.stringify(before?.proposals?.[name])) fail(`${name} proposal changed across upgrade`);
  }

  const ar = report?.aliceRecovery?.after;
  const alice = report?.aliceRecovery;
  const aliceContract = delta(ar, afterUpgrade, 'contractBalance');
  const aliceLocked = delta(ar, afterUpgrade, 'lockedAmount');
  const aliceRecipient = balanceDelta(ar, afterUpgrade, 'aliceRecipient');
  const alicePaid = alice?.attempt?.ok === true && alice?.attempt?.value?.receiptFailure === true
    && ar?.proposals?.alice?.status === 'Failed' && aliceContract === -BOND && aliceRecipient === 0n;
  const aliceProposer = balanceDelta(ar, afterUpgrade, 'alice');
  if (!alicePaid) fail('Alice recovery did not return exactly one bond while preserving Failed status');
  if (aliceProposer < 0n) fail('Alice proposer delta is invalid');
  if (alice?.deltas?.proposer && big(alice.deltas.proposer) !== aliceProposer) fail('Alice proposer delta does not match snapshot balances');
  if (big(ar?.lockedAmount) < BOND) fail('Bob liability disappeared after Alice recovery');

  const retryAfter = report?.aliceRetry?.after;
  if (!alice?.attempt?.ok || alice.attempt.value?.finalExecutionStatus !== 'FINAL') fail('Alice recovery was not an executed FINAL transaction');
  if (!report?.aliceRetry?.attempt?.ok || report.aliceRetry.attempt.value?.receiptFailure !== true) fail('Alice retry did not produce the expected failed execution');
  if (delta(retryAfter, ar, 'contractBalance') !== 0n || delta(retryAfter, ar, 'lockedAmount') !== 0n || balanceDelta(retryAfter, ar, 'aliceRecipient') !== 0n) fail('Alice retry moved principal');

  const bobAfter = report?.bobPayout?.after;
  const bob = report?.bobPayout;
  const bobContract = delta(bobAfter, retryAfter, 'contractBalance');
  const bobLocked = delta(bobAfter, retryAfter, 'lockedAmount');
  const bobRecipient = balanceDelta(bobAfter, retryAfter, 'bobRecipient');
  const bobTransferPaid = bob?.attempt?.ok === true && bob.attempt.value?.receiptFailure === false
    && bobAfter?.proposals?.bob?.status === 'Approved' && bobRecipient === TRANSFER;
  const bobPaidExactlyOnce = bobTransferPaid && bobContract === -(BOND + TRANSFER) && bobLocked === -BOND;
  const bobProposer = balanceDelta(bobAfter, retryAfter, 'bob');
  if (!bobPaidExactlyOnce) fail('Bob did not receive exactly one transfer and one bond return');
  if (bobProposer !== BOND) fail('Bob proposer bond return is not exactly one bond');
  if (bob?.deltas?.proposer && big(bob.deltas.proposer) !== bobProposer) fail('Bob proposer delta does not match snapshot balances');
  if (!bobTransferPaid) fail('Bob transfer was not paid');

  const bobRetryAfter = report?.bobRetry?.after;
  if (!report?.bobRetry?.attempt?.ok || report.bobRetry.attempt.value?.receiptFailure !== true) fail('Bob retry did not fail in a terminal state');
  if (delta(bobRetryAfter, bobAfter, 'contractBalance') !== 0n || delta(bobRetryAfter, bobAfter, 'lockedAmount') !== 0n || balanceDelta(bobRetryAfter, bobAfter, 'bobRecipient') !== 0n) fail('Bob retry moved principal');

  const carolAfter = report?.carolRetry?.after;
  if (!report?.carolRetry?.attempt?.ok || report.carolRetry.attempt.value?.receiptFailure !== true) fail('Carol retry did not fail in a terminal state');
  if (delta(carolAfter, bobRetryAfter, 'contractBalance') !== 0n || delta(carolAfter, bobRetryAfter, 'lockedAmount') !== 0n || balanceDelta(carolAfter, bobRetryAfter, 'carolRecipient') !== 0n) fail('Carol retry moved principal');

  return {
    ok: errors.length === 0,
    errors,
    outcomes: {
      alicePaid,
      aliceProposerDelta: aliceProposer.toString(),
      aliceLockedDelta: aliceLocked.toString(),
      bobLiabilityAfterAlice: big(ar?.lockedAmount) >= BOND,
      bobTransferPaid,
      bobPaidExactlyOnce,
      bobProposerDelta: bobProposer.toString(),
      bobLockedDelta: bobLocked.toString(),
      bobRecipientDelta: bobRecipient.toString(),
    },
  };
}

module.exports = {verifyMixedReport, BOND, TRANSFER};
