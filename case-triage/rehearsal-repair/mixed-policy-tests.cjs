'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verifyMixedReport} = require('./mixed-policy.cjs');
const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'out', name), 'utf8'));
const expected = {
  'mixed-obligation-old.json': false,
  'mixed-obligation-future-only.json': false,
  'mixed-obligation-clear-all.json': false,
  'mixed-obligation-intended.json': true,
};
for (const [name, ok] of Object.entries(expected)) {
  const checked = verifyMixedReport(read(name));
  assert.equal(checked.ok, ok, `${name}: ${checked.errors.join('; ')}`);
  if (!ok) assert.ok(checked.errors.length > 0, `${name} rejecting candidate must explain why`);
}
const clear = verifyMixedReport(read('mixed-obligation-clear-all.json'));
assert.equal(clear.outcomes.bobLiabilityAfterAlice, false);
assert.equal(clear.outcomes.bobPaidExactlyOnce, false);
const pinnedIntended = verifyMixedReport(read('mixed-obligation-intended.json'), {requireBlockPinned: true});
assert.equal(pinnedIntended.ok, true, `pinned intended: ${pinnedIntended.errors.join('; ')}`);
const pinnedClear = verifyMixedReport(read('mixed-obligation-clear-all.json'), {requireBlockPinned: true});
assert.equal(pinnedClear.ok, false);
assert.ok(pinnedClear.errors.some((error) => /Bob liability disappeared/.test(error)));
const intended = verifyMixedReport(read('mixed-obligation-intended.json'));
assert.equal(intended.outcomes.alicePaid, true);
assert.equal(intended.outcomes.bobLiabilityAfterAlice, true);
assert.equal(intended.outcomes.bobPaidExactlyOnce, true);

const clone = (value) => JSON.parse(JSON.stringify(value));
const mutationMustFail = (name, mutate, label) => {
  const value = clone(read('mixed-obligation-intended.json'));
  mutate(value);
  const result = verifyMixedReport(value);
  assert.equal(result.ok, false, `${label} mutation was accepted`);
};
mutationMustFail('finality', (value) => { value.aliceRecovery.attempt.value.finalExecutionStatus = 'EXECUTED'; }, 'finality');
mutationMustFail('signer', (value) => { value.bobPayout.attempt.value.transaction.signerId = value.accounts.bob; }, 'signer');
mutationMustFail('receipt-root', (value) => { value.bobPayout.attempt.value.transactionOutcome.rootReceiptIds = []; delete value.bobPayout.attempt.value.transactionOutcome.receiptIds; }, 'receipt root');
mutationMustFail('action-args', (value) => {
  const call = value.bobPayout.attempt.value.transaction.actions[0].FunctionCall;
  call.args = Buffer.from(JSON.stringify({id: 999, action: 'Finalize', proposal: {Vote: {}}})).toString('base64');
}, 'action arguments');
mutationMustFail('policy', (value) => { value.afterUpgrade.policy.proposal_bond = '2'; }, 'policy');
mutationMustFail('non-target', (value) => { value.afterUpgrade.proposals.carol.description = 'relabelled'; }, 'non-target proposal');
mutationMustFail('unlinked-receipt', (value) => {
  value.bobPayout.attempt.value.receipts.push({id: 'unlinked-zero-gas', tokensBurntYocto: '0', receiptIds: [], status: {SuccessValue: ''}});
}, 'unlinked receipt');
mutationMustFail('conflicting-roots', (value) => {
  value.bobPayout.attempt.value.transactionOutcome.receiptIds = [];
}, 'conflicting receipt roots');
mutationMustFail('null-action-args', (value) => {
  value.bobPayout.attempt.value.transaction.actions[0].FunctionCall.args = Buffer.from('null').toString('base64');
}, 'null action args');
mutationMustFail('extra-action', (value) => {
  value.bobPayout.attempt.value.transaction.actions.push({Transfer: {deposit: '1'}});
}, 'extra transaction action');
mutationMustFail('before-recovery-policy', (value) => { value.beforeRecovery.policy.proposal_bond = '2'; }, 'beforeRecovery policy');
mutationMustFail('before-recovery-locked', (value) => { value.beforeRecovery.lockedAmount = '0'; }, 'beforeRecovery locked');
mutationMustFail('seed-missing', (value) => { delete value.seed.alice; }, 'missing seed');
mutationMustFail('seed-args', (value) => {
  const call = value.seed.bob.transaction.actions[0].FunctionCall;
  call.args = Buffer.from(JSON.stringify({proposal_id: 999, proposer: value.accounts.bob, amount: '1', funding_tx_hash: 'x'})).toString('base64');
}, 'seed args');
console.log('mixed-policy: null args, conflicting roots and extra actions reject');
console.log('mixed-policy: finality, signer, root, action-args, policy, non-target and unlinked-receipt mutations reject');
console.log('mixed-policy: primary policy rejects old/future-only/clear-all and accepts intended');
