'use strict';
/*
 * Recompute the same-DAO policy from recorded snapshots. The runner's checks
 * and deltas are evidence, not authority: every actor credit, action-payer
 * charge, receipt-derived gas amount and terminal proposal state is checked.
 */
const fs = require('node:fs');
const path = require('node:path');
const BOND = 10n ** 24n;
const TRANSFER = 10n ** 23n;
const FIXTURE = path.join(__dirname, 'out', 'issue238-local.json');
const fixture = (() => { try { return JSON.parse(fs.readFileSync(FIXTURE, 'utf8')); } catch { return null; } })();
const fixtureBond = (() => { try { return BigInt(fixture.failed.bondDeclaredYocto); } catch { return null; } })();
const fixtureTransfer = (() => { try { return BigInt(fixture.healthy.transferDeclaredYocto); } catch { return TRANSFER; } })();
const SOURCE = '5434a59dec23ee0c49df8c8c4350c208a7e75b0b';
const BASE_WASM = '5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578';

const strictAmount = (value, label, fail, {nonNegative = false} = {}) => {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    fail(`${label} is missing`);
    return null;
  }
  const text = String(value);
  if (!/^-?[0-9]+$/.test(text)) {
    fail(`${label} is not an integer`);
    return null;
  }
  let parsed;
  try { parsed = BigInt(text); } catch { fail(`${label} is not an integer`); return null; }
  if (nonNegative && parsed < 0n) {
    fail(`${label} is negative`);
    return null;
  }
  return parsed;
};

function verifyMixedReport(report, opts = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  let expectedBond = opts.expectedBond ? BigInt(opts.expectedBond) : fixtureBond;
  const expectedTransfer = opts.expectedTransfer ? BigInt(opts.expectedTransfer) : fixtureTransfer;
  if (expectedBond === null) {
    fail('no trusted original per-obligation bond; refusing an ambiguous legacy principal');
    expectedBond = 0n;
  }
  const amount = (value, label, nonNegative = false) => strictAmount(value, label, fail, {nonNegative});
  const delta = (after, before, key, label) => {
    const a = amount(after?.[key], `${label} after`);
    const b = amount(before?.[key], `${label} before`);
    return a === null || b === null ? 0n : a - b;
  };
  const balanceDelta = (after, before, name, label) => {
    const a = amount(after?.balances?.[name], `${label} ${name} balance after`, true);
    const b = amount(before?.balances?.[name], `${label} ${name} balance before`, true);
    return a === null || b === null ? 0n : a - b;
  };
  const canonicalPolicy = (policy) => {
    if (!policy || !Array.isArray(policy.roles)) return policy;
    return {
      ...policy,
      roles: policy.roles.map((role) => ({
        ...role,
        permissions: Array.isArray(role.permissions) ? role.permissions.slice().sort() : role.permissions,
      })).sort((left, right) => String(left.name).localeCompare(String(right.name))),
    };
  };
  const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const proposalIdentity = (proposal) => ({
    proposer: proposal?.proposer,
    description: proposal?.description,
    kind: proposal?.kind,
  });
  const checkAttempt = (attempt, label, signerId, receiverId, methodName, expected) => {
    const value = attempt?.value;
    if (!value) {
      fail(`${label} has no execution value`);
      return;
    }
    if (value.finalExecutionStatus !== 'FINAL') fail(`${label} is not FINAL`);
    const transaction = value.transaction;
    if (!transaction) {
      fail(`${label} has no transaction identity`);
      return;
    }
    if (transaction.signerId !== signerId) fail(`${label} signer is not the expected actor`);
    if (transaction.receiverId !== receiverId) fail(`${label} receiver is not the DAO`);
    const actions = Array.isArray(transaction.actions) ? transaction.actions : [];
    if (actions.length !== 1) fail(`${label} has unexpected transaction actions`);
    const call = actions.find((action) => action?.FunctionCall?.method_name === methodName);
    if (!call) {
      fail(`${label} has no expected ${methodName} action`);
    } else if (expected) {
      let args;
      try {
        args = typeof call.FunctionCall.args === 'string'
          ? JSON.parse(Buffer.from(call.FunctionCall.args, 'base64').toString('utf8'))
          : call.FunctionCall.args;
      } catch { fail(`${label} action args are not valid JSON`); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        fail(`${label} action args are missing or not an object`);
      } else {
        const extra = Object.keys(args).filter((key) => !['id', 'action', 'proposal'].includes(key));
        if (extra.length) fail(`${label} action args contain unexpected fields: ${extra.join(', ')}`);
        if (String(args.id) !== String(expected.id)) fail(`${label} action targets proposal ${args.id}, expected ${expected.id}`);
        if (args.action !== expected.action) fail(`${label} action is ${args.action}, expected ${expected.action}`);
        if (JSON.stringify(args.proposal) !== JSON.stringify(expected.kind)) fail(`${label} action proposal kind does not match the pinned proposal`);
      }
    }
    const receiptIds = value.transactionOutcome?.receiptIds;
    const rootReceiptIds = value.transactionOutcome?.rootReceiptIds;
    if (receiptIds !== undefined && rootReceiptIds !== undefined
      && JSON.stringify(receiptIds) !== JSON.stringify(rootReceiptIds)) {
      fail(`${label} receipt root representations disagree`);
    }
    const roots = rootReceiptIds !== undefined ? rootReceiptIds : receiptIds;
    if (!Array.isArray(roots) || roots.length === 0) {
      fail(`${label} has no transaction receipt root`);
    } else {
      const receipts = new Map();
      for (const receipt of value.receipts || []) {
        if (!receipt?.id || receipts.has(receipt.id)) fail(`${label} has a duplicate or missing receipt id`);
        else receipts.set(receipt.id, receipt);
      }
      const seen = new Set();
      const queue = [...roots];
      while (queue.length) {
        const id = queue.shift();
        if (seen.has(id)) continue;
        seen.add(id);
        const receipt = receipts.get(id);
        if (!receipt) { fail(`${label} root references a missing receipt`); continue; }
        for (const child of receipt.receiptIds || []) queue.push(child);
      }
      for (const id of receipts.keys()) if (!seen.has(id)) fail(`${label} has an unlinked receipt ${id}`);
    }
  };
  const checkProposalIdentity = (snapshot, label) => {
    const beforeProposals = before?.proposals;
    for (const name of ['alice', 'bob', 'carol']) {
      const expected = beforeProposals?.[name];
      const actual = snapshot?.proposals?.[name];
      if (!expected || !actual) continue;
      if (!sameJson(proposalIdentity(actual), proposalIdentity(expected))) fail(`${label} changed ${name} proposal identity`);
    }
  };
  const checkSnapshotPreservation = (snapshot, label) => {
    if (!snapshot?.policy) fail(`${label} has no policy`);
    else if (!sameJson(canonicalPolicy(snapshot.policy), canonicalPolicy(before?.policy))) fail(`${label} changed governance policy`);
    checkProposalIdentity(snapshot, label);
  };
  const gasFromAttempt = (attempt, label) => {
    const value = attempt?.value;
    if (!value || !value.transactionOutcome) {
      fail(`${label} has no transaction outcome`);
      return null;
    }
    const tx = amount(value.transactionOutcome.tokensBurntYocto, `${label} transaction gas`, true);
    if (!Array.isArray(value.receipts)) {
      fail(`${label} receipts are missing`);
      return null;
    }
    let receipts = 0n;
    let valid = tx !== null;
    for (const [index, receipt] of value.receipts.entries()) {
      const fee = amount(receipt?.tokensBurntYocto, `${label} receipt ${index} gas`, true);
      if (fee === null) valid = false;
      else receipts += fee;
    }
    return valid ? tx + receipts : null;
  };

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
  if (amount(before?.lockedAmount, 'pre-upgrade locked', true) !== expectedBond * 2n) fail('two pre-upgrade bond liabilities were not locked');
  if (before?.proposals?.alice?.status !== 'Failed') fail('Alice was not Failed before upgrade');
  if (before?.proposals?.bob?.status !== 'InProgress') fail('Bob was not pending before upgrade');
  if (before?.proposals?.carol?.status !== 'Approved') fail('Carol was not already paid');
  const requiredSnapshots = [
    ['beforeUpgrade', before],
    ['afterUpgrade', afterUpgrade],
    ['Alice recovery', report?.aliceRecovery?.after],
    ['Alice retry', report?.aliceRetry?.after],
    ['Bob payout', report?.bobPayout?.after],
    ['Bob retry', report?.bobRetry?.after],
    ['Carol retry', report?.carolRetry?.after],
  ];
  for (const [label, snap] of requiredSnapshots) {
    for (const name of ['alice', 'bob', 'carol', 'aliceRecipient', 'bobRecipient', 'carolRecipient', 'dao']) {
      amount(snap?.balances?.[name], `${label} ${name} balance`, true);
    }
    checkSnapshotPreservation(snap, label);
  }
  if (amount(afterUpgrade?.lockedAmount, 'post-upgrade locked', true) !== expectedBond * 2n) fail('upgrade changed the two locked liabilities');
  for (const name of ['alice', 'bob', 'carol']) {
    if (JSON.stringify(afterUpgrade?.proposals?.[name]) !== JSON.stringify(before?.proposals?.[name])) fail(`${name} proposal changed across upgrade`);
  }

  const signer = report?.accounts?.alice;
  const receiver = report?.accounts?.contract;
  const pinned = before?.proposals || {};
  checkAttempt(report?.aliceRecovery?.attempt, 'Alice recovery', signer, receiver, 'act_proposal', {id: pinned.alice?.id, action: 'Finalize', kind: pinned.alice?.kind});
  checkAttempt(report?.aliceRetry?.attempt, 'Alice retry', signer, receiver, 'act_proposal', {id: pinned.alice?.id, action: 'Finalize', kind: pinned.alice?.kind});
  checkAttempt(report?.bobPayout?.attempt, 'Bob payout', signer, receiver, 'act_proposal', {id: pinned.bob?.id, action: 'VoteApprove', kind: pinned.bob?.kind});
  checkAttempt(report?.bobRetry?.attempt, 'Bob retry', signer, receiver, 'act_proposal', {id: pinned.bob?.id, action: 'Finalize', kind: pinned.bob?.kind});
  checkAttempt(report?.carolRetry?.attempt, 'Carol retry', signer, receiver, 'act_proposal', {id: pinned.carol?.id, action: 'Finalize', kind: pinned.carol?.kind});

  const gas = {
    aliceRecovery: gasFromAttempt(report?.aliceRecovery?.attempt, 'Alice recovery'),
    aliceRetry: gasFromAttempt(report?.aliceRetry?.attempt, 'Alice retry'),
    bobPayout: gasFromAttempt(report?.bobPayout?.attempt, 'Bob payout'),
    bobRetry: gasFromAttempt(report?.bobRetry?.attempt, 'Bob retry'),
    carolRetry: gasFromAttempt(report?.carolRetry?.attempt, 'Carol retry'),
  };
  for (const [name, value] of Object.entries(gas)) if (value === null) fail(`${name} has no receipt-derived gas`);

  const unchanged = (after, beforeSnapshot, names, label) => {
    for (const name of names) if (balanceDelta(after, beforeSnapshot, name, label) !== 0n) fail(`${label} changed ${name} balance`);
  };
  const payer = (after, beforeSnapshot, gasValue, label) => {
    const observed = balanceDelta(after, beforeSnapshot, 'alice', label);
    if (gasValue !== null && observed !== -gasValue) fail(`${label} did not charge Alice exactly the receipt-derived gas`);
    return observed;
  };

  const ar = report?.aliceRecovery?.after;
  const alice = report?.aliceRecovery;
  const recoveryStart = report?.beforeRecovery || afterUpgrade;
  const aliceContract = delta(ar, recoveryStart, 'contractBalance', 'Alice recovery contract');
  const aliceLocked = delta(ar, recoveryStart, 'lockedAmount', 'Alice recovery locked');
  const aliceRecipient = balanceDelta(ar, recoveryStart, 'aliceRecipient', 'Alice recovery');
  const aliceProposer = balanceDelta(ar, recoveryStart, 'alice', 'Alice recovery');
  const alicePaid = alice?.attempt?.ok === true && alice?.attempt?.value?.receiptFailure === true
    && alice?.attempt?.value?.finalExecutionStatus === 'FINAL'
    && ar?.proposals?.alice?.status === 'Failed' && aliceContract === -expectedBond && aliceRecipient === 0n;
  if (!alicePaid) fail('Alice recovery did not return exactly one bond while preserving Failed status');
  if (gas.aliceRecovery !== null && aliceProposer !== expectedBond - gas.aliceRecovery) fail('Alice proposer delta is not bond minus receipt-derived gas');
  if (alice?.gasBurntYocto && amount(alice.gasBurntYocto, 'Alice recovery gas field', true) !== gas.aliceRecovery) fail('Alice recovery gas field does not match receipts');
  if (alice?.deltas?.proposer && amount(alice.deltas.proposer, 'Alice recovery reported proposer') !== aliceProposer) fail('Alice proposer delta does not match snapshot balances');
  if (aliceLocked !== -expectedBond) fail('Alice recovery did not release exactly one locked bond');
  if (amount(ar?.lockedAmount, 'Alice recovery locked balance', true) < expectedBond) fail('Bob liability disappeared after Alice recovery');
  unchanged(ar, recoveryStart, ['bob', 'carol', 'aliceRecipient', 'bobRecipient', 'carolRecipient'], 'Alice recovery');

  const aliceRetryAfter = report?.aliceRetry?.after;
  const aliceRetry = report?.aliceRetry;
  const aliceRetryPayer = payer(aliceRetryAfter, ar, gas.aliceRetry, 'Alice retry');
  if (!aliceRetry?.attempt?.ok || aliceRetry.attempt.value?.receiptFailure !== true || aliceRetry.attempt.value?.finalExecutionStatus !== 'FINAL') fail('Alice retry did not produce the expected failed FINAL execution');
  if (delta(aliceRetryAfter, ar, 'contractBalance', 'Alice retry contract') !== 0n || delta(aliceRetryAfter, ar, 'lockedAmount', 'Alice retry locked') !== 0n || balanceDelta(aliceRetryAfter, ar, 'aliceRecipient', 'Alice retry') !== 0n) fail('Alice retry moved principal');
  if (aliceRetryAfter?.proposals?.alice?.status !== 'Failed') fail('Alice retry did not leave Alice Failed');
  if (aliceRetry?.deltas?.proposer && amount(aliceRetry.deltas.proposer, 'Alice retry reported proposer') !== aliceRetryPayer) fail('Alice retry proposer delta does not match snapshot balances');
  unchanged(aliceRetryAfter, ar, ['bob', 'carol', 'aliceRecipient', 'bobRecipient', 'carolRecipient'], 'Alice retry');

  const bobAfter = report?.bobPayout?.after;
  const bob = report?.bobPayout;
  const bobContract = delta(bobAfter, aliceRetryAfter, 'contractBalance', 'Bob payout contract');
  const bobLocked = delta(bobAfter, aliceRetryAfter, 'lockedAmount', 'Bob payout locked');
  const bobRecipient = balanceDelta(bobAfter, aliceRetryAfter, 'bobRecipient', 'Bob payout');
  const bobProposer = balanceDelta(bobAfter, aliceRetryAfter, 'bob', 'Bob payout');
  const bobPayer = payer(bobAfter, aliceRetryAfter, gas.bobPayout, 'Bob payout');
  const bobTransferPaid = bob?.attempt?.ok === true && bob.attempt.value?.receiptFailure === false
    && bob.attempt.value?.finalExecutionStatus === 'FINAL'
    && bobAfter?.proposals?.bob?.status === 'Approved' && bobRecipient === expectedTransfer;
  const bobPaidExactlyOnce = bobTransferPaid && bobContract === -(expectedBond + expectedTransfer) && bobLocked === -expectedBond;
  if (!bobTransferPaid) fail('Bob transfer was not paid');
  if (!bobPaidExactlyOnce) fail('Bob settlement failed payout or liability-release checks');
  if (bobProposer !== expectedBond) fail('Bob proposer bond return is not exactly one bond');
  if (bob?.deltas?.proposer && amount(bob.deltas.proposer, 'Bob payout reported proposer') !== bobProposer) fail('Bob proposer delta does not match snapshot balances');
  if (bobPayer >= 0n) fail('Bob payout did not charge Alice as the action payer');
  unchanged(bobAfter, aliceRetryAfter, ['carol', 'aliceRecipient', 'carolRecipient'], 'Bob payout');

  const bobRetryAfter = report?.bobRetry?.after;
  const bobRetry = report?.bobRetry;
  const bobRetryPayer = payer(bobRetryAfter, bobAfter, gas.bobRetry, 'Bob retry');
  if (!bobRetry?.attempt?.ok || bobRetry.attempt.value?.receiptFailure !== true || bobRetry.attempt.value?.finalExecutionStatus !== 'FINAL') fail('Bob retry did not fail in a terminal state');
  if (delta(bobRetryAfter, bobAfter, 'contractBalance', 'Bob retry contract') !== 0n || delta(bobRetryAfter, bobAfter, 'lockedAmount', 'Bob retry locked') !== 0n || balanceDelta(bobRetryAfter, bobAfter, 'bobRecipient', 'Bob retry') !== 0n) fail('Bob retry moved principal');
  if (bobRetryAfter?.proposals?.bob?.status !== 'Approved') fail('Bob retry did not leave Bob Approved');
  if (bobRetry?.deltas?.proposer && amount(bobRetry.deltas.proposer, 'Bob retry reported proposer') !== bobRetryPayer) fail('Bob retry proposer delta does not match snapshot balances');
  unchanged(bobRetryAfter, bobAfter, ['bob', 'carol', 'aliceRecipient', 'bobRecipient', 'carolRecipient'], 'Bob retry');

  const carolAfter = report?.carolRetry?.after;
  const carolRetry = report?.carolRetry;
  const carolRetryPayer = payer(carolAfter, bobRetryAfter, gas.carolRetry, 'Carol retry');
  if (!carolRetry?.attempt?.ok || carolRetry.attempt.value?.receiptFailure !== true || carolRetry.attempt.value?.finalExecutionStatus !== 'FINAL') fail('Carol retry did not fail in a terminal state');
  if (delta(carolAfter, bobRetryAfter, 'contractBalance', 'Carol retry contract') !== 0n || delta(carolAfter, bobRetryAfter, 'lockedAmount', 'Carol retry locked') !== 0n || balanceDelta(carolAfter, bobRetryAfter, 'carolRecipient', 'Carol retry') !== 0n) fail('Carol retry moved principal');
  if (carolAfter?.proposals?.carol?.status !== 'Approved') fail('Carol retry did not leave Carol Approved');
  if (carolRetry?.deltas?.proposer && amount(carolRetry.deltas.proposer, 'Carol retry reported proposer') !== carolRetryPayer) fail('Carol retry proposer delta does not match snapshot balances');
  unchanged(carolAfter, bobRetryAfter, ['bob', 'carol', 'aliceRecipient', 'bobRecipient', 'carolRecipient'], 'Carol retry');

  return {
    ok: errors.length === 0,
    errors,
    outcomes: {
      alicePaid,
      aliceProposerDelta: aliceProposer.toString(),
      aliceRetryPayerDelta: aliceRetryPayer.toString(),
      aliceLockedDelta: aliceLocked.toString(),
      bobLiabilityAfterAlice: amount(ar?.lockedAmount, 'Alice recovery locked outcome', true) >= expectedBond,
      bobTransferPaid,
      bobPaidExactlyOnce,
      bobProposerDelta: bobProposer.toString(),
      bobPayerDelta: bobPayer.toString(),
      bobRetryPayerDelta: bobRetryPayer.toString(),
      carolRetryPayerDelta: carolRetryPayer.toString(),
      aliceStatusAfterRetry: aliceRetryAfter?.proposals?.alice?.status ?? null,
      bobStatusAfterRetry: bobRetryAfter?.proposals?.bob?.status ?? null,
      carolStatusAfterRetry: carolAfter?.proposals?.carol?.status ?? null,
      bobLockedDelta: bobLocked.toString(),
      bobRecipientDelta: bobRecipient.toString(),
      gas: Object.fromEntries(Object.entries(gas).map(([name, value]) => [name, value?.toString() ?? null])),
    },
  };
}

module.exports = {verifyMixedReport, BOND, TRANSFER};
