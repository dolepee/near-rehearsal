'use strict';
/*
 * Offline checks for the same-DAO mixed-obligation evidence reports.
 * These recompute the accounting from the before/after snapshots rather than
 * trusting the runner's cached booleans.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HERE = __dirname;
const BOND = 10n ** 24n;
const TRANSFER = 10n ** 23n;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const read = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'out', name), 'utf8'));
const delta = (after, before, key) => BigInt(after?.[key] ?? 0) - BigInt(before?.[key] ?? 0);

function verify(report) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (report?.schema !== 'near-rehearsal/mixed-obligation/v1') fail('schema');
  if (report?.source?.commit !== '5434a59dec23ee0c49df8c8c4350c208a7e75b0b') fail('source commit');
  if (report?.source?.baseWasmSha256 !== '5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578') fail('base artifact');
  if (!/^[0-9a-f]{64}$/.test(report?.candidate?.wasmSha256 || '')) fail('candidate hash missing');
  if (report?.candidate?.wasmHash !== report?.afterUpgrade?.codeHash) fail('candidate code was not applied');

  const before = report?.beforeUpgrade;
  const afterUpgrade = report?.afterUpgrade;
  if (BigInt(before?.lockedAmount ?? -1) !== BOND * 2n) fail('two pre-upgrade bond liabilities were not locked');
  if (before?.proposals?.alice?.status !== 'Failed') fail('Alice was not Failed before upgrade');
  if (before?.proposals?.bob?.status !== 'InProgress') fail('Bob was not pending before upgrade');
  if (before?.proposals?.carol?.status !== 'Approved') fail('Carol was not already paid');
  if (BigInt(afterUpgrade?.lockedAmount ?? -1) !== BOND * 2n) fail('upgrade changed the two locked liabilities');
  for (const name of ['alice', 'bob', 'carol']) {
    if (JSON.stringify(afterUpgrade?.proposals?.[name]) !== JSON.stringify(before?.proposals?.[name])) fail(`${name} proposal changed across upgrade`);
  }

  const ar = report?.aliceRecovery?.after;
  const alice = report?.aliceRecovery;
  const aliceContract = delta(ar, afterUpgrade, 'contractBalance');
  const aliceLocked = delta(ar, afterUpgrade, 'lockedAmount');
  const aliceRecipient = BigInt(ar?.balances?.aliceRecipient ?? 0) - BigInt(afterUpgrade?.balances?.aliceRecipient ?? 0);
  const alicePaid = alice?.attempt?.ok === true &&
    alice?.attempt?.value?.receiptFailure === true &&
    ar?.proposals?.alice?.status === 'Failed' &&
    aliceContract === -BOND &&
    aliceRecipient === 0n;
  const bobLiabilityAfterAlice = BigInt(ar?.lockedAmount ?? 0) >= BOND;

  const retryAfter = report?.aliceRetry?.after;
  if (!alice?.attempt?.ok || alice.attempt.value?.finalExecutionStatus !== 'FINAL') fail('Alice recovery was not an executed FINAL transaction');
  if (!report?.aliceRetry?.attempt?.ok || report.aliceRetry.attempt.value?.receiptFailure !== true) fail('Alice retry did not produce the expected failed execution');
  if (delta(retryAfter, ar, 'contractBalance') !== 0n || delta(retryAfter, ar, 'lockedAmount') !== 0n ||
      (BigInt(retryAfter?.balances?.aliceRecipient ?? 0) - BigInt(ar?.balances?.aliceRecipient ?? 0)) !== 0n) {
    fail('Alice retry moved principal');
  }

  const bobAfter = report?.bobPayout?.after;
  const bobContract = delta(bobAfter, retryAfter, 'contractBalance');
  const bobLocked = delta(bobAfter, retryAfter, 'lockedAmount');
  const bobRecipient = BigInt(bobAfter?.balances?.bobRecipient ?? 0) - BigInt(retryAfter?.balances?.bobRecipient ?? 0);
  const bobTransferPaid = report?.bobPayout?.attempt?.ok === true &&
    report.bobPayout.attempt.value?.receiptFailure === false &&
    bobAfter?.proposals?.bob?.status === 'Approved' &&
    bobRecipient === TRANSFER;
  const bobPaidExactlyOnce = bobTransferPaid && bobContract === -(BOND + TRANSFER) && bobLocked === -BOND;

  const bobRetryAfter = report?.bobRetry?.after;
  if (!report?.bobRetry?.attempt?.ok || report.bobRetry.attempt.value?.receiptFailure !== true) fail('Bob retry did not fail in a terminal state');
  if (delta(bobRetryAfter, bobAfter, 'contractBalance') !== 0n || delta(bobRetryAfter, bobAfter, 'lockedAmount') !== 0n ||
      (BigInt(bobRetryAfter?.balances?.bobRecipient ?? 0) - BigInt(bobAfter?.balances?.bobRecipient ?? 0)) !== 0n) {
    fail('Bob retry moved principal');
  }

  const carolAfter = report?.carolRetry?.after;
  if (!report?.carolRetry?.attempt?.ok || report.carolRetry.attempt.value?.receiptFailure !== true) fail('Carol retry did not fail in a terminal state');
  if (delta(carolAfter, bobRetryAfter, 'contractBalance') !== 0n || delta(carolAfter, bobRetryAfter, 'lockedAmount') !== 0n ||
      (BigInt(carolAfter?.balances?.carolRecipient ?? 0) - BigInt(bobRetryAfter?.balances?.carolRecipient ?? 0)) !== 0n) {
    fail('Carol retry moved principal');
  }

  return {
    errors,
    outcomes: {
      alicePaid,
      aliceLockedDelta: aliceLocked.toString(),
      bobLiabilityAfterAlice,
      bobTransferPaid,
      bobPaidExactlyOnce,
      bobLockedDelta: bobLocked.toString(),
      bobRecipientDelta: bobRecipient.toString(),
    },
  };
}

const reports = {
  old: read('mixed-obligation-old.json'),
  intended: read('mixed-obligation-intended.json'),
  'future-only': read('mixed-obligation-future-only.json'),
  'clear-all': read('mixed-obligation-clear-all.json'),
};
const expected = {
  old: {alicePaid: false, bobLiabilityAfterAlice: true, bobPaidExactlyOnce: true},
  intended: {alicePaid: true, bobLiabilityAfterAlice: true, bobPaidExactlyOnce: true},
  'future-only': {alicePaid: false, bobLiabilityAfterAlice: true, bobPaidExactlyOnce: false},
  'clear-all': {alicePaid: true, bobLiabilityAfterAlice: false, bobPaidExactlyOnce: false},
};
for (const [name, report] of Object.entries(reports)) {
  const checked = verify(report);
  assert.deepEqual(checked.errors, [], `${name}: ${checked.errors.join('; ')}`);
  for (const [key, value] of Object.entries(expected[name])) assert.equal(checked.outcomes[key], value, `${name} ${key}`);
  console.log(`${name}: ${JSON.stringify(checked.outcomes)}`);
}
console.log('mixed-obligation: old/future-only fail recovery; clear-all pays Alice but damages Bob; intended preserves Bob and pays each once');
