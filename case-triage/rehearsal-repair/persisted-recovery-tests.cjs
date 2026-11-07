'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verify} = require('./persisted-recovery-acceptance.cjs');

const here = __dirname;
const report = JSON.parse(fs.readFileSync(path.join(here, 'out/persisted-recovery.json'), 'utf8'));
const opts = {
  wasmPath: path.join(here, 'generated/e8262f5a/candidate.wasm'),
  patchPath: path.join(here, 'generated/e8262f5a/repair.patch'),
  expectedWasmSha256: '49a5120cee5f4e453a37e40b18231ce9b0fef95c08dca4fdbf23f102937eb923',
  expectedPatchSha256: '532741a3f689863844d0af147ec08d278420cd74920f68f817234747e295fedc',
  expectedSourceSha256: '82efc4225e307b97068cd7bd984da78f9a83ecf51e1b21749de344f45aa53b22',
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const reject = (label, mutate) => {
  const copy = clone(report);
  mutate(copy);
  assert.ok(verify(copy, opts).length > 0, label);
  console.log(`rejected: ${label}`);
};

assert.deepEqual(verify(report, opts), []);
console.log('accepted: persisted recovery with recomputed state, authority and accounting');

const cachedFlagsAreIgnored = clone(report);
cachedFlagsAreIgnored.preservation = {
  state: false, policy: false, proposal: false, lockedAmount: false, codeChanged: false, noNew: false,
};
cachedFlagsAreIgnored.authority.unauthorizedUpdateRejected = false;
cachedFlagsAreIgnored.authority.unauthorizedFinalizeRejected = false;
cachedFlagsAreIgnored.healthyPreservation.checks = {
  settledApproved: false, settledPayout: '0', upgradeCode: false, proposalPreserved: false,
  recipientPreserved: false, lockedCleared: false, noFurtherPayout: false,
};
assert.deepEqual(verify(cachedFlagsAreIgnored, opts), []);
console.log('accepted: cached preservation/authority/healthy booleans are not trusted');

reject('state changed across upgrade', (r) => { r.upgraded.state.push({key: '00', value: '00'}); });
reject('policy changed across upgrade', (r) => { r.upgraded.policy.proposal_bond = '1'; });
reject('proposal changed across upgrade', (r) => { r.upgraded.proposal.status = 'Approved'; });
reject('locked amount changed across upgrade', (r) => { r.upgraded.lockedAmount = '0'; });
reject('candidate code not applied', (r) => { r.upgraded.codeHash = '0'.repeat(44); });
reject('candidate bytes mismatch', (r) => { r.candidate.wasmSha256 = '0'.repeat(64); });
reject('first cached gross wrong', (r) => { r.firstRecovery.grossRecoveryYocto = '1'; });
reject('first final not FINAL', (r) => { r.firstRecovery.final.finalExecutionStatus = 'None'; });
reject('first missing downstream failure', (r) => { r.firstRecovery.final.receipts = r.firstRecovery.final.receipts.filter((x) => x.executorId !== r.accounts.failedTarget); });
reject('first root receipt missing', (r) => { r.firstRecovery.final.transactionOutcome.rootReceiptIds = []; });
reject('first transaction gas record mismatch', (r) => { r.firstRecovery.final.transactionOutcome.tokensBurntYocto = (BigInt(r.firstRecovery.final.transactionOutcome.tokensBurntYocto) + 1n).toString(); });
reject('first unrooted receipt', (r) => { r.firstRecovery.final.receipts.push({id: 'unrooted', receiptIds: [], executorId: r.accounts.failedTarget, status: {Failure: {}}, tokensBurntYocto: '0'}); });
reject('first transaction outcome failure', (r) => { r.firstRecovery.final.transactionOutcome.status = {Failure: {}}; });
reject('first proposer credit does not reconcile', (r) => {
  r.firstRecovery.after.proposerBalance = (BigInt(r.firstRecovery.after.proposerBalance) + 1n).toString();
});
reject('first contract delta does not reconcile', (r) => {
  r.firstRecovery.after.contractBalance = (BigInt(r.firstRecovery.after.contractBalance) - 1n).toString();
});
reject('first recipient paid', (r) => {
  r.firstRecovery.after.recipientBalance = (BigInt(r.firstRecovery.after.recipientBalance) + 1n).toString();
});
reject('second cached gross wrong', (r) => { r.secondRetry.grossRecoveryYocto = '1'; });
reject('second final not FINAL', (r) => { r.secondRetry.final.finalExecutionStatus = 'None'; });
reject('second proposer delta does not reconcile', (r) => {
  r.secondRetry.after.proposerBalance = (BigInt(r.secondRetry.after.proposerBalance) + 1n).toString();
});
reject('second locked delta changed', (r) => {
  r.secondRetry.after.lockedAmount = (BigInt(r.secondRetry.after.lockedAmount) + 1n).toString();
});
reject('unauthorized update probe was transport error', (r) => {
  r.authority.unauthorizedUpdateProbe = {label: 'unauthorized update', ok: false, executed: false, error: 'socket hang up'};
});
reject('unauthorized update lost expected failure', (r) => {
  r.authority.unauthorizedUpdateProbe.value.receipts = r.authority.unauthorizedUpdateProbe.value.receipts.filter((x) => x.executorId !== r.accounts.contract);
});
reject('unauthorized finalize probe was transport error', (r) => {
  r.authority.unauthorizedFinalizeProbe = {label: 'unauthorized finalize', ok: false, executed: false, error: 'ECONNRESET'};
});
reject('healthy finalize probe was transport error', (r) => {
  r.healthyPreservation.finalizeAttempt = {label: 'finalize past-settled proposal', ok: false, executed: false, error: 'timeout'};
});
reject('healthy payout wrong', (r) => {
  r.healthyPreservation.settled.recipientBalance = (BigInt(r.healthyPreservation.settled.recipientBalance) - 1n).toString();
});
reject('healthy proposal changed', (r) => { r.healthyPreservation.afterUpgrade.proposal.status = 'Failed'; });
reject('healthy paid again', (r) => {
  r.healthyPreservation.afterAttempt.recipientBalance = (BigInt(r.healthyPreservation.afterAttempt.recipientBalance) + 1n).toString();
});

console.log(JSON.stringify({
  schema: 'near-rehearsal/persisted-bond-recovery-tests/v1',
  accepted: ['actual-positive-control', 'cached-booleans-ignored'],
  rejected: [
    'state-changed', 'policy-changed', 'proposal-changed', 'locked-changed', 'candidate-code',
    'candidate-bytes', 'first-gross', 'first-final-status', 'first-downstream-failure', 'first-root-receipt', 'first-outcome-gas', 'first-unrooted-receipt', 'first-outcome-failure',
    'first-proposer-accounting', 'first-contract-accounting', 'first-recipient',
    'second-gross', 'second-final-status', 'second-proposer-accounting', 'second-locked',
    'unauthorized-update-transport', 'unauthorized-update-evidence',
    'unauthorized-finalize-transport', 'healthy-finalize-transport', 'healthy-payout',
    'healthy-proposal', 'healthy-paid-again',
  ],
  passed: true,
}, null, 2));
