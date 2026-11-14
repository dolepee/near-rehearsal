'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verifyMixedReport} = require('./mixed-policy.cjs');
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/mixed-obligation-intended.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(base));
const opts = {requireBlockPinned: true};
const expectFail = (label, mutate, pattern) => {
  const report = clone();
  mutate(report);
  const checked = verifyMixedReport(report, opts);
  assert.equal(checked.ok, false, `${label} unexpectedly passed`);
  if (pattern) assert.ok(checked.errors.some((error) => pattern.test(error)), `${label}: ${checked.errors.join('; ')}`);
  return checked;
};

const good = verifyMixedReport(base, opts);
assert.equal(good.ok, true, good.errors.join('; '));

const noAliceRefund = clone();
noAliceRefund.aliceRecovery.after.balances.alice = noAliceRefund.afterUpgrade.balances.alice;
noAliceRefund.aliceRecovery.deltas.proposer = '0';
const noRefundCheck = verifyMixedReport(noAliceRefund, opts);
assert.equal(noRefundCheck.ok, false);
assert.ok(noRefundCheck.errors.some((error) => /Alice proposer delta|bond minus/.test(error)));

const extraBobCredit = clone();
extraBobCredit.bobRetry.after.balances.bob = (BigInt(extraBobCredit.bobRetry.after.balances.bob) + 10n ** 24n).toString();
const extraCreditCheck = verifyMixedReport(extraBobCredit, opts);
assert.equal(extraCreditCheck.ok, false);
assert.ok(extraCreditCheck.errors.some((error) => /Bob retry changed bob balance/.test(error)));

expectFail('missing Carol balance', (r) => { delete r.beforeUpgrade.balances.carol; }, /beforeUpgrade carol balance is missing/);
expectFail('malformed Carol balance', (r) => { r.beforeUpgrade.balances.carol = '12x'; }, /beforeUpgrade carol balance is not an integer/);
expectFail('missing receipt gas', (r) => { delete r.bobRetry.attempt.value.receipts[0].tokensBurntYocto; }, /Bob retry receipt 0 gas is missing/);
expectFail('malformed receipt gas', (r) => { r.bobRetry.attempt.value.receipts[0].tokensBurntYocto = 'gas'; }, /Bob retry receipt 0 gas is not an integer/);
expectFail('Alice retry became nonterminal', (r) => { r.aliceRetry.after.proposals.alice.status = 'InProgress'; }, /Alice retry did not leave Alice Failed/);
expectFail('Bob retry became nonterminal', (r) => { r.bobRetry.after.proposals.bob.status = 'InProgress'; }, /Bob retry did not leave Bob Approved/);
expectFail('Carol retry became nonterminal', (r) => { r.carolRetry.after.proposals.carol.status = 'InProgress'; }, /Carol retry did not leave Carol Approved/);

const unpinned = clone();
delete unpinned.beforeUpgrade.blockHash;
assert.equal(verifyMixedReport(unpinned, opts).ok, false);


expectFail('missing Bob payout finality', (r) => { r.bobPayout.attempt.value.finalExecutionStatus = 'EXECUTED_OPTIMISTIC'; }, /Bob payout is not FINAL/);
expectFail('changed Bob payout signer', (r) => { r.bobPayout.attempt.value.transaction.signerId = 'attacker.test.near'; }, /Bob payout signer/);
expectFail('missing Bob receipt root', (r) => { delete r.bobPayout.attempt.value.transactionOutcome.receiptIds; delete r.bobPayout.attempt.value.transactionOutcome.rootReceiptIds; }, /Bob payout has no transaction receipt root/);
expectFail('empty Bob action list', (r) => { r.bobPayout.attempt.value.transaction.actions = []; }, /Bob payout has no expected act_proposal action/);
expectFail('governance changed after recovery', (r) => { r.aliceRecovery.after.policy.roles[1].permissions.push('*:*'); }, /Alice recovery changed governance policy/);
expectFail('non-target proposer changed after recovery', (r) => { r.aliceRecovery.after.proposals.bob.proposer = 'attacker.test.near'; }, /Alice recovery changed bob proposal identity/);

console.log('mixed-policy negatives: missing/malformed balances and receipt gas, changed actor credits, unpinned snapshots and nonterminal retries are rejected');
