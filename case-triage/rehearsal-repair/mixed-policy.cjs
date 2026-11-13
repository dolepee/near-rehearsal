'use strict';
/*
 * Recompute the same-DAO policy from recorded snapshots. The runner's checks
 * and deltas are evidence, not authority: every actor credit, action-payer
 * charge and receipt-derived gas amount is recomputed here with BigInt.
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
const gasFromAttempt = (attempt) => {
  const value = attempt?.value;
  if (!value || !value.transactionOutcome) return null;
  return big(value.transactionOutcome.tokensBurntYocto)
    + (value.receipts || []).reduce((sum, receipt) => sum + big(receipt?.tokensBurntYocto), 0n);
};

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

  const gas = {
    aliceRecovery: gasFromAttempt(report?.aliceRecovery?.attempt),
    aliceRetry: gasFromAttempt(report?.aliceRetry?.attempt),
    bobPayout: gasFromAttempt(report?.bobPayout?.attempt),
    bobRetry: gasFromAttempt(report?.bobRetry?.attempt),
    carolRetry: gasFromAttempt(report?.carolRetry?.attempt),
  };
  for (const [name, value] of Object.entries(gas)) if (value === null) fail(`${name} has no receipt-derived gas`);

  const unchanged = (after, beforeSnapshot, names, label) => {
    for (const name of names) if (balanceDelta(after, beforeSnapshot, name) !== 0n) fail(`${label} changed ${name} balance`);
  };
  const payer = (after, beforeSnapshot, gasValue, label) => {
    const observed = balanceDelta(after, beforeSnapshot, 'alice');
    if (gasValue === null) return observed;
    if (observed !== -gasValue) fail(`${label} did not charge Alice exactly the receipt-derived gas`);
    return observed;
  };

  const ar = report?.aliceRecovery?.after;
  const alice = report?.aliceRecovery;
  const aliceContract = delta(ar, afterUpgrade, 'contractBalance');
  const aliceLocked = delta(ar, afterUpgrade, 'lockedAmount');
  const aliceRecipient = balanceDelta(ar, afterUpgrade, 'aliceRecipient');
  const aliceProposer = balanceDelta(ar, afterUpgrade, 'alice');
  const alicePaid = alice?.attempt?.ok === true && alice?.attempt?.value?.receiptFailure === true
    && alice?.attempt?.value?.finalExecutionStatus === 'FINAL'
    && ar?.proposals?.alice?.status === 'Failed' && aliceContract === -BOND && aliceRecipient === 0n;
  if (!alicePaid) fail('Alice recovery did not return exactly one bond while preserving Failed status');
  if (gas.aliceRecovery !== null && aliceProposer !== BOND - gas.aliceRecovery) fail('Alice proposer delta is not bond minus receipt-derived gas');
  if (alice?.gasBurntYocto && big(alice.gasBurntYocto) !== gas.aliceRecovery) fail('Alice recovery gas field does not match receipts');
  if (alice?.deltas?.proposer && big(alice.deltas.proposer) !== aliceProposer) fail('Alice proposer delta does not match snapshot balances');
  if (aliceLocked !== -BOND) fail('Alice recovery did not release exactly one locked bond');
  if (big(ar?.lockedAmount) < BOND) fail('Bob liability disappeared after Alice recovery');
  unchanged(ar, afterUpgrade, ['bob', 'carol', 'aliceRecipient', 'bobRecipient', 'carolRecipient'], 'Alice recovery');

  const aliceRetryAfter = report?.aliceRetry?.after;
  const aliceRetry = report?.aliceRetry;
  const aliceRetryPayer = payer(aliceRetryAfter, ar, gas.aliceRetry, 'Alice retry');
  if (!aliceRetry?.attempt?.ok || aliceRetry.attempt.value?.receiptFailure !== true || aliceRetry.attempt.value?.finalExecutionStatus !== 'FINAL') fail('Alice retry did not produce the expected failed FINAL execution');
  if (delta(aliceRetryAfter, ar, 'contractBalance') !== 0n || delta(aliceRetryAfter, ar, 'lockedAmount') !== 0n || balanceDelta(aliceRetryAfter, ar, 'aliceRecipient') !== 0n) fail('Alice retry moved principal');
  if (aliceRetry?.deltas?.proposer && big(aliceRetry.deltas.proposer) !== aliceRetryPayer) fail('Alice retry proposer delta does not match snapshot balances');
  unchanged(aliceRetryAfter, ar, ['bob', 'carol', 'aliceRecipient', 'bobRecipient', 'carolRecipient'], 'Alice retry');

  const bobAfter = report?.bobPayout?.after;
  const bob = report?.bobPayout;
  const bobContract = delta(bobAfter, aliceRetryAfter, 'contractBalance');
  const bobLocked = delta(bobAfter, aliceRetryAfter, 'lockedAmount');
  const bobRecipient = balanceDelta(bobAfter, aliceRetryAfter, 'bobRecipient');
  const bobProposer = balanceDelta(bobAfter, aliceRetryAfter, 'bob');
  const bobPayer = payer(bobAfter, aliceRetryAfter, gas.bobPayout, 'Bob payout');
  const bobTransferPaid = bob?.attempt?.ok === true && bob.attempt.value?.receiptFailure === false
    && bobAfter?.proposals?.bob?.status === 'Approved' && bobRecipient === TRANSFER;
  const bobPaidExactlyOnce = bobTransferPaid && bobContract === -(BOND + TRANSFER) && bobLocked === -BOND;
  if (!bobTransferPaid) fail('Bob transfer was not paid');
  if (!bobPaidExactlyOnce) fail('Bob did not receive exactly one transfer and one bond return');
  if (bobProposer !== BOND) fail('Bob proposer bond return is not exactly one bond');
  if (bob?.deltas?.proposer && big(bob.deltas.proposer) !== bobProposer) fail('Bob proposer delta does not match snapshot balances');
  if (bobPayer >= 0n) fail('Bob payout did not charge Alice as the action payer');
  unchanged(bobAfter, aliceRetryAfter, ['carol', 'aliceRecipient', 'carolRecipient'], 'Bob payout');

  const bobRetryAfter = report?.bobRetry?.after;
  const bobRetry = report?.bobRetry;
  const bobRetryPayer = payer(bobRetryAfter, bobAfter, gas.bobRetry, 'Bob retry');
  if (!bobRetry?.attempt?.ok || bobRetry.attempt.value?.receiptFailure !== true || bobRetry.attempt.value?.finalExecutionStatus !== 'FINAL') fail('Bob retry did not fail in a terminal state');
  if (delta(bobRetryAfter, bobAfter, 'contractBalance') !== 0n || delta(bobRetryAfter, bobAfter, 'lockedAmount') !== 0n || balanceDelta(bobRetryAfter, bobAfter, 'bobRecipient') !== 0n) fail('Bob retry moved principal');
  if (bobRetry?.deltas?.proposer && big(bobRetry.deltas.proposer) !== bobRetryPayer) fail('Bob retry proposer delta does not match snapshot balances');
  unchanged(bobRetryAfter, bobAfter, ['bob', 'carol', 'aliceRecipient', 'bobRecipient', 'carolRecipient'], 'Bob retry');

  const carolAfter = report?.carolRetry?.after;
  const carolRetry = report?.carolRetry;
  const carolRetryPayer = payer(carolAfter, bobRetryAfter, gas.carolRetry, 'Carol retry');
  if (!carolRetry?.attempt?.ok || carolRetry.attempt.value?.receiptFailure !== true || carolRetry.attempt.value?.finalExecutionStatus !== 'FINAL') fail('Carol retry did not fail in a terminal state');
  if (delta(carolAfter, bobRetryAfter, 'contractBalance') !== 0n || delta(carolAfter, bobRetryAfter, 'lockedAmount') !== 0n || balanceDelta(carolAfter, bobRetryAfter, 'carolRecipient') !== 0n) fail('Carol retry moved principal');
  if (carolRetry?.deltas?.proposer && big(carolRetry.deltas.proposer) !== carolRetryPayer) fail('Carol retry proposer delta does not match snapshot balances');
  unchanged(carolAfter, bobRetryAfter, ['bob', 'carol', 'aliceRecipient', 'bobRecipient', 'carolRecipient'], 'Carol retry');

  return {
    ok: errors.length === 0,
    errors,
    outcomes: {
      alicePaid,
      aliceProposerDelta: aliceProposer.toString(),
      aliceRetryPayerDelta: aliceRetryPayer.toString(),
      aliceLockedDelta: aliceLocked.toString(),
      bobLiabilityAfterAlice: big(ar?.lockedAmount) >= BOND,
      bobTransferPaid,
      bobPaidExactlyOnce,
      bobProposerDelta: bobProposer.toString(),
      bobPayerDelta: bobPayer.toString(),
      bobRetryPayerDelta: bobRetryPayer.toString(),
      carolRetryPayerDelta: carolRetryPayer.toString(),
      bobLockedDelta: bobLocked.toString(),
      bobRecipientDelta: bobRecipient.toString(),
      gas: Object.fromEntries(Object.entries(gas).map(([name, value]) => [name, value?.toString() ?? null])),
    },
  };
}

module.exports = {verifyMixedReport, BOND, TRANSFER};
