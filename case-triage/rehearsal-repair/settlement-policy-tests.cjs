'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verifySettlementReport, REQUIRED_SCHEMA, DEFAULT_BASE_WASM_SHA256} = require('./settlement-policy.cjs');

const HERE = __dirname;
const read = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'audit-intended', name, 'settlement-refund.json'), 'utf8'));

const oldReport = read('settlement-old');
const correctedReport = read('settlement');
assert.equal(oldReport.schema, REQUIRED_SCHEMA);
assert.equal(correctedReport.schema, REQUIRED_SCHEMA);
assert.equal(oldReport.candidate.wasmSha256, '49a5120cee5f4e453a37e40b18231ce9b0fef95c08dca4fdbf23f102937eb923');
assert.equal(correctedReport.candidate.wasmSha256, 'fe4401bcc33aedb7992ffa5163570355fc1757e123bd588aa4f9a84302967a0c');

const oldCheck = verifySettlementReport(oldReport, {candidateWasmSha256: oldReport.candidate.wasmSha256});
const correctedCheck = verifySettlementReport(correctedReport, {candidateWasmSha256: correctedReport.candidate.wasmSha256});
assert.equal(oldCheck.ok, false, 'the premature-settlement candidate must fail the shared policy');
assert.equal(correctedCheck.ok, true, correctedCheck.errors.join('; '));
assert.ok(oldCheck.errors.some((error) => /locked debt/.test(error)));
assert.ok(oldCheck.errors.some((error) => /retry proposer delta/.test(error)));
assert.equal(correctedCheck.outcomes.failedRefundLocked, '1000000000000000000000000');
assert.equal(correctedCheck.outcomes.retryDelta, '1000000000000000000000000');
assert.equal(correctedCheck.outcomes.overlapDelta, '1000000000000000000000000');
assert.equal(correctedCheck.outcomes.fresh.failedRefundLocked, '1000000000000000000000000', 'the fresh candidate scenario must also retain the debt');
assert.equal(correctedCheck.outcomes.inherited.failedRefundLocked, '1000000000000000000000000', 'the inherited scenario must retain the debt');

const labelSwap = JSON.parse(JSON.stringify(correctedReport));
const forged = '1'.repeat(64);
labelSwap.candidate.wasmSha256 = forged;
labelSwap.fresh.deploy.wasmSha256 = forged;
labelSwap.inherited.legacy.candidateWasmSha256 = forged;
labelSwap.inherited.transactions.upgrade.candidateWasmSha256 = forged;
const labelSwapCheck = verifySettlementReport(labelSwap, {candidateWasmSha256: forged});
assert.equal(labelSwapCheck.ok, false, 'copied identity labels must not replace DeployContract evidence');
assert.ok(labelSwapCheck.errors.some((error) => /DeployContract|deployment label|commitment|installed code hash/.test(error)));

function makeMultiHop(report, select) {
  const tx = select(report);
  const id = tx.transactionOutcome.status.SuccessReceiptId;
  const first = tx.receipts.find((receipt) => receipt.id === id);
  first.status = {SuccessReceiptId: 'hop-2'};
  first.receiptIds = [...(first.receiptIds || []), 'hop-2'];
  tx.receipts.push({id: 'hop-2', receiptIds: [], executorId: first.executorId, status: {SuccessValue: ''}});
  return tx;
}

const multiHop = JSON.parse(JSON.stringify(correctedReport));
makeMultiHop(multiHop, (report) => report.fresh.deploy);
assert.equal(verifySettlementReport(multiHop, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, true,
  'a linked multi-hop success must pass');

const multiHopMigrate = JSON.parse(JSON.stringify(correctedReport));
makeMultiHop(multiHopMigrate, (report) => report.inherited.transactions.upgrade.migrate);
assert.equal(verifySettlementReport(multiHopMigrate, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, true,
  'the shared traversal must also follow a multi-hop migrate chain');

const terminalFailure = JSON.parse(JSON.stringify(multiHop));
terminalFailure.fresh.deploy.receipts.find((receipt) => receipt.id === 'hop-2').status = {Failure: {ActionError: {kind: 'synthetic terminal failure'}}};
assert.equal(verifySettlementReport(terminalFailure, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a terminal failure at the end of the receipt chain must fail');

const missingGrandchild = JSON.parse(JSON.stringify(correctedReport));
{
  const deploy = missingGrandchild.fresh.deploy;
  const id = deploy.transactionOutcome.status.SuccessReceiptId;
  const first = deploy.receipts.find((receipt) => receipt.id === id);
  first.status = {SuccessReceiptId: 'missing-hop'};
  first.receiptIds = [...(first.receiptIds || []), 'missing-hop'];
}
assert.equal(verifySettlementReport(missingGrandchild, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a missing child in the receipt chain must fail');

const cycle = JSON.parse(JSON.stringify(correctedReport));
{
  const deploy = cycle.fresh.deploy;
  const id = deploy.transactionOutcome.status.SuccessReceiptId;
  const first = deploy.receipts.find((receipt) => receipt.id === id);
  first.status = {SuccessReceiptId: id};
  first.receiptIds = [...(first.receiptIds || []), id];
}
assert.equal(verifySettlementReport(cycle, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a receipt cycle must fail');

const disconnectedChild = JSON.parse(JSON.stringify(correctedReport));
{
  const deploy = disconnectedChild.fresh.deploy;
  const id = deploy.transactionOutcome.status.SuccessReceiptId;
  const first = deploy.receipts.find((receipt) => receipt.id === id);
  first.status = {SuccessReceiptId: 'disconnected-hop'};
}
assert.equal(verifySettlementReport(disconnectedChild, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a child not linked by receiptIds must fail');

const duplicateReceipt = JSON.parse(JSON.stringify(correctedReport));
duplicateReceipt.fresh.deploy.receipts.push({...duplicateReceipt.fresh.deploy.receipts[0]});
assert.equal(verifySettlementReport(duplicateReceipt, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'duplicate receipt IDs must fail');

const unlinkedStart = JSON.parse(JSON.stringify(correctedReport));
unlinkedStart.fresh.deploy.transactionOutcome.receiptIds = [];
assert.equal(verifySettlementReport(unlinkedStart, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the initial transaction receiptIds must link the SuccessReceiptId');

const addWrongMethod = JSON.parse(JSON.stringify(correctedReport));
addWrongMethod.inherited.transactions.add.transaction.actions[0].FunctionCall.method_name = 'get_config';
assert.equal(verifySettlementReport(addWrongMethod, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'add_proposal must be an add_proposal call');

const addWrongReceiver = JSON.parse(JSON.stringify(correctedReport));
addWrongReceiver.inherited.transactions.add.transaction.receiverId = 'unrelated.test.near';
assert.equal(verifySettlementReport(addWrongReceiver, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'add_proposal must target the scenario DAO');

const addWrongSigner = JSON.parse(JSON.stringify(correctedReport));
addWrongSigner.inherited.transactions.add.transaction.signerId = 'unrelated.test.near';
assert.equal(verifySettlementReport(addWrongSigner, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'add_proposal signer must be the recorded proposer');

const addWrongBond = JSON.parse(JSON.stringify(correctedReport));
addWrongBond.inherited.transactions.add.transaction.actions[0].FunctionCall.deposit = '0';
assert.equal(verifySettlementReport(addWrongBond, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'add_proposal bond must match the recorded bond');

const addWrongArgs = JSON.parse(JSON.stringify(correctedReport));
{
  const call = addWrongArgs.inherited.transactions.add.transaction.actions[0].FunctionCall;
  const args = JSON.parse(Buffer.from(call.args, 'base64').toString('utf8'));
  args.proposal.kind = {FunctionCall: {receiver_id: 'wrong.test.near', actions: []}};
  call.args = Buffer.from(JSON.stringify(args)).toString('base64');
}
assert.equal(verifySettlementReport(addWrongArgs, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'add_proposal kind must match the recorded proposal');

const addWrongReturnedId = JSON.parse(JSON.stringify(correctedReport));
{
  const add = addWrongReturnedId.inherited.transactions.add;
  add.receipts.find((receipt) => receipt.id === add.transactionOutcome.status.SuccessReceiptId).status.SuccessValue = Buffer.from('1').toString('base64');
}
assert.equal(verifySettlementReport(addWrongReturnedId, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'add_proposal must return the scenario proposal id');

const unauthorizedLabelOnly = JSON.parse(JSON.stringify(correctedReport));
unauthorizedLabelOnly.inherited.transactions.unauthorized = {ok: false};
assert.equal(verifySettlementReport(unauthorizedLabelOnly, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the duplicated unauthorized representation must be the full record');

const unauthorizedMissingSigner = JSON.parse(JSON.stringify(correctedReport));
delete unauthorizedMissingSigner.inherited.unauthorized.value.transaction.signerId;
delete unauthorizedMissingSigner.inherited.transactions.unauthorized.value.transaction.signerId;
assert.equal(verifySettlementReport(unauthorizedMissingSigner, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the unauthorized callback must carry a nonempty signer');

const unauthorizedBorrowedFailure = JSON.parse(JSON.stringify(correctedReport));
{
  const unauthorized = unauthorizedBorrowedFailure.inherited.unauthorized;
  const firstId = unauthorized.value.transactionOutcome.status.SuccessReceiptId;
  const first = unauthorized.value.receipts.find((receipt) => receipt.id === firstId);
  first.status = {SuccessValue: 'Method on_refund_callback is private'};
  unauthorized.value.receipts.push({
    id: 'unrelated-private-failure',
    receiptIds: [],
    executorId: unauthorized.value.transaction.receiverId,
    status: {Failure: {ActionError: {kind: {FunctionCallError: {ExecutionError: 'Method on_refund_callback is private'}}}}},
    logs: [],
    tokensBurntYocto: '0',
  });
  unauthorizedBorrowedFailure.inherited.transactions.unauthorized = JSON.parse(JSON.stringify(unauthorized));
}
assert.equal(verifySettlementReport(unauthorizedBorrowedFailure, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the linked first receipt itself must be the private-denial Failure');

const unauthorizedNoAction = JSON.parse(JSON.stringify(correctedReport));
unauthorizedNoAction.inherited.unauthorized.value.transaction.actions = [];
assert.equal(verifySettlementReport(unauthorizedNoAction, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the recorded unauthorized callback needs its actual action');

const unauthorizedWrongMethod = JSON.parse(JSON.stringify(correctedReport));
unauthorizedWrongMethod.inherited.unauthorized.value.transaction.actions[0].FunctionCall.method_name = 'get_config';
assert.equal(verifySettlementReport(unauthorizedWrongMethod, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the unauthorized callback must call on_refund_callback');

const unauthorizedDaoCaller = JSON.parse(JSON.stringify(correctedReport));
unauthorizedDaoCaller.inherited.unauthorized.value.transaction.signerId = correctedReport.inherited.deploy.transaction.receiverId;
assert.equal(verifySettlementReport(unauthorizedDaoCaller, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the unauthorized callback must come from a non-DAO caller');

const unauthorizedStringArgs = JSON.parse(JSON.stringify(correctedReport));
{
  const call = unauthorizedStringArgs.inherited.unauthorized.value.transaction.actions[0].FunctionCall;
  call.args = Buffer.from(JSON.stringify({proposal_id: '0', attempt: 999})).toString('base64');
}
assert.equal(verifySettlementReport(unauthorizedStringArgs, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the unauthorized callback proposal_id must be numeric');

const unauthorizedWrongAttempt = JSON.parse(JSON.stringify(correctedReport));
{
  const call = unauthorizedWrongAttempt.inherited.unauthorized.value.transaction.actions[0].FunctionCall;
  call.args = Buffer.from(JSON.stringify({proposal_id: 0, attempt: 998})).toString('base64');
}
assert.equal(verifySettlementReport(unauthorizedWrongAttempt, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the unauthorized callback attempt must be numeric 999');

const duplicateLabelOnly = JSON.parse(JSON.stringify(correctedReport));
duplicateLabelOnly.inherited.transactions.duplicate = {finalExecutionStatus: 'FINAL'};
assert.equal(verifySettlementReport(duplicateLabelOnly, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a duplicate retry label without its transaction must fail');

const duplicateWrongMethod = JSON.parse(JSON.stringify(correctedReport));
duplicateWrongMethod.inherited.transactions.duplicate.transaction.actions[0].FunctionCall.method_name = 'get_config';
assert.equal(verifySettlementReport(duplicateWrongMethod, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'duplicate retry must be act_proposal Finalize');

const duplicateWrongReceiver = JSON.parse(JSON.stringify(correctedReport));
duplicateWrongReceiver.inherited.transactions.duplicate.transaction.receiverId = 'unrelated.test.near';
assert.equal(verifySettlementReport(duplicateWrongReceiver, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'duplicate retry must target the scenario DAO');

const duplicateNoReceiptLink = JSON.parse(JSON.stringify(correctedReport));
duplicateNoReceiptLink.inherited.transactions.duplicate.transactionOutcome.receiptIds = [];
assert.equal(verifySettlementReport(duplicateNoReceiptLink, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'duplicate retry must link its executed receipts');

const reusedDuplicate = JSON.parse(JSON.stringify(correctedReport));
reusedDuplicate.inherited.transactions.duplicate = JSON.parse(JSON.stringify(reusedDuplicate.inherited.transactions.retries[0]));
assert.equal(verifySettlementReport(reusedDuplicate, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the duplicate retry cannot reuse an overlap transaction');

const missingDuplicateHeight = JSON.parse(JSON.stringify(correctedReport));
delete missingDuplicateHeight.inherited.transactions.duplicate.blockHeight;
assert.equal(verifySettlementReport(missingDuplicateHeight, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the duplicate retry must carry its measured block height');

const prematureDuplicate = JSON.parse(JSON.stringify(correctedReport));
prematureDuplicate.inherited.transactions.duplicate.blockHeight = prematureDuplicate.inherited.beforeRetry.blockHeight;
assert.equal(verifySettlementReport(prematureDuplicate, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the duplicate retry must be after the settled afterRetry observation');

const unboundedDuplicate = JSON.parse(JSON.stringify(correctedReport));
for (const key of ['fresh', 'inherited']) {
  unboundedDuplicate[key].afterDuplicate = JSON.parse(JSON.stringify(unboundedDuplicate[key].afterRetry));
}
const unboundedDuplicateCheck = verifySettlementReport(unboundedDuplicate, {candidateWasmSha256: correctedReport.candidate.wasmSha256});
assert.equal(unboundedDuplicateCheck.ok, false,
  'an afterRetry snapshot relabelled as afterDuplicate must not satisfy the no-double-payment check');
assert.ok(unboundedDuplicateCheck.errors.some((error) => /post-duplicate observation/.test(error)));

const staleDuplicateObservation = JSON.parse(JSON.stringify(correctedReport));
for (const key of ['fresh', 'inherited']) {
  staleDuplicateObservation[key].afterDuplicate.blockHeight = staleDuplicateObservation[key].transactions.duplicate.blockHeight;
}
assert.equal(verifySettlementReport(staleDuplicateObservation, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the post-duplicate observation must follow the duplicate execution');

const missingDuplicateObservation = JSON.parse(JSON.stringify(correctedReport));
delete missingDuplicateObservation.inherited.afterDuplicate.blockHeight;
assert.equal(verifySettlementReport(missingDuplicateObservation, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the post-duplicate observation needs its measured height');

const copiedPreObservation = JSON.parse(JSON.stringify(correctedReport));
copiedPreObservation.inherited.afterDuplicate = JSON.parse(JSON.stringify(copiedPreObservation.inherited.afterRetry));
assert.equal(verifySettlementReport(copiedPreObservation, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the post-duplicate snapshot cannot be a copy of the pre-duplicate observation');

const missingAfterDuplicateHeight = JSON.parse(JSON.stringify(correctedReport));
delete missingAfterDuplicateHeight.inherited.afterDuplicate.blockHeight;
assert.equal(verifySettlementReport(missingAfterDuplicateHeight, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the post-duplicate observation must carry its measured height');

const duplicateLegacyHash = JSON.parse(JSON.stringify(correctedReport));
duplicateLegacyHash.inherited.transactions.duplicate.transactionHash = duplicateLegacyHash.inherited.transactions.upgrade.legacyFinalize.transactionHash;
assert.equal(verifySettlementReport(duplicateLegacyHash, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the duplicate retry cannot reuse the legacy finalize transaction');

const missingRetryHeight = JSON.parse(JSON.stringify(correctedReport));
delete missingRetryHeight.inherited.transactions.retries[0].blockHeight;
const missingRetryResult = verifySettlementReport(missingRetryHeight, {candidateWasmSha256: correctedReport.candidate.wasmSha256});
assert.equal(missingRetryResult.ok, false, 'raw retries must carry measured heights');
assert.equal(missingRetryResult.unproven, true, 'missing retry capture is unproven, not a financial rejection');

const beforeWindowRetry = JSON.parse(JSON.stringify(correctedReport));
beforeWindowRetry.inherited.transactions.retries[0].blockHeight = Number(beforeWindowRetry.inherited.beforeRetry.blockHeight) - 1;
assert.equal(verifySettlementReport(beforeWindowRetry, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'raw retries must be inside the beforeRetry/afterRetry window');

const genuineTrace = JSON.parse(JSON.stringify(correctedReport));
{
  const t = genuineTrace.inherited.transactions;
  t.add.blockHeight = 147;
  t.vote2.blockHeight = 159;
  t.failedProposal.last_actions_log[t.failedProposal.last_actions_log.length - 1].block_height = '160';
  t.upgrade.deploy.blockHeight = 167;
  t.upgrade.migrate.blockHeight = 172;
  t.upgrade.legacyFinalize.blockHeight = 180;
  genuineTrace.inherited.legacy.legacyFinalize.blockHeight = 180;
}
assert.equal(verifySettlementReport(genuineTrace, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, true,
  'the genuine ordered inherited trace must pass');

const wrongBeneficiary = JSON.parse(JSON.stringify(correctedReport));
wrongBeneficiary.inherited.failedRefund.proposal.proposer = 'unrelated.test.near';
assert.equal(verifySettlementReport(wrongBeneficiary, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the post-upgrade failed proposal must retain the recorded refund beneficiary');

const wrongFailedProposalId = JSON.parse(JSON.stringify(correctedReport));
wrongFailedProposalId.inherited.transactions.failedProposal.id = 999;
assert.equal(verifySettlementReport(wrongFailedProposalId, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the recorded old-code proposal must be the scenario proposal');

const wrongFailedProposalStatus = JSON.parse(JSON.stringify(correctedReport));
wrongFailedProposalStatus.inherited.transactions.failedProposal.status = 'InProgress';
assert.equal(verifySettlementReport(wrongFailedProposalStatus, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the recorded old-code proposal must be Failed');

const zeroFailureHeight = JSON.parse(JSON.stringify(correctedReport));
{
  const logs = zeroFailureHeight.inherited.transactions.failedProposal.last_actions_log;
  logs[logs.length - 1].block_height = '0';
}
assert.equal(verifySettlementReport(zeroFailureHeight, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'an old-code failure height of zero must fail');

const failureBeforeVote2 = JSON.parse(JSON.stringify(correctedReport));
{
  const logs = failureBeforeVote2.inherited.transactions.failedProposal.last_actions_log;
  logs[logs.length - 1].block_height = String(Number(failureBeforeVote2.inherited.transactions.vote2.blockHeight) - 1);
}
assert.equal(verifySettlementReport(failureBeforeVote2, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'old-code failure cannot precede the second approval');

const legacyBeforeMigrate = JSON.parse(JSON.stringify(correctedReport));
legacyBeforeMigrate.inherited.transactions.upgrade.legacyFinalize.blockHeight = Number(legacyBeforeMigrate.inherited.transactions.upgrade.migrate.blockHeight) - 1;
assert.equal(verifySettlementReport(legacyBeforeMigrate, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'legacy finalize cannot precede migrate');

const legacyLabelOnly = JSON.parse(JSON.stringify(correctedReport));
legacyLabelOnly.inherited.legacy.legacyFinalize = {
  finalExecutionStatus: 'FINAL',
  blockHeight: correctedReport.inherited.legacy.legacyFinalize.blockHeight,
};
assert.equal(verifySettlementReport(legacyLabelOnly, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a legacy finalize label without actions and receipts must fail');

const legacyWrongMethod = JSON.parse(JSON.stringify(correctedReport));
legacyWrongMethod.inherited.transactions.upgrade.legacyFinalize.transaction.actions[0].FunctionCall.method_name = 'get_config';
legacyWrongMethod.inherited.legacy.legacyFinalize.transaction.actions[0].FunctionCall.method_name = 'get_config';
assert.equal(verifySettlementReport(legacyWrongMethod, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'legacy finalize must be act_proposal, not another method');

const legacyRepresentationMismatch = JSON.parse(JSON.stringify(correctedReport));
legacyRepresentationMismatch.inherited.legacy.legacyFinalize.transaction.receiverId = 'unrelated.test.near';
assert.equal(verifySettlementReport(legacyRepresentationMismatch, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the two legacy finalize representations must be the same full transaction');

const bothRetriesSucceed = JSON.parse(JSON.stringify(correctedReport));
{
  const retry = bothRetriesSucceed.inherited.transactions.retries[0];
  const id = retry.transactionOutcome.status.SuccessReceiptId;
  retry.receipts.find((receipt) => receipt.id === id).status = {SuccessValue: ''};
}
const bothSuccessResult = verifySettlementReport(bothRetriesSucceed, {candidateWasmSha256: correctedReport.candidate.wasmSha256});
assert.equal(bothSuccessResult.ok, false, 'two successful retries leave the in-flight guard unproven and must fail');
assert.equal(bothSuccessResult.unproven, true, 'an unexercised in-flight guard must be reported as unproven');

const bothRetriesInFlight = JSON.parse(JSON.stringify(correctedReport));
{
  const retry = bothRetriesInFlight.inherited.transactions.retries[1];
  const id = retry.transactionOutcome.status.SuccessReceiptId;
  retry.receipts.find((receipt) => receipt.id === id).status = {Failure: {ActionError: {kind: 'ERR_PROPOSAL_NOT_IN_PROGRESS'}}};
}
assert.equal(verifySettlementReport(bothRetriesInFlight, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'two in-flight rejections leave no successful retry action and must fail');

const stringFailureHeight = JSON.parse(JSON.stringify(correctedReport));
{
  const logs = stringFailureHeight.inherited.transactions.failedProposal.last_actions_log;
  logs[logs.length - 1].block_height = String(Number(correctedReport.inherited.transactions.upgrade.deploy.blockHeight) - 1);
}
assert.equal(verifySettlementReport(stringFailureHeight, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, true,
  'a valid decimal-string failure height must normalize and pass chronology');

const malformedFailureHeight = JSON.parse(JSON.stringify(correctedReport));
{
  const logs = malformedFailureHeight.inherited.transactions.failedProposal.last_actions_log;
  logs[logs.length - 1].block_height = '202x';
}
assert.equal(verifySettlementReport(malformedFailureHeight, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a malformed failure height must fail chronology');

const emptyVoteReceipts = JSON.parse(JSON.stringify(correctedReport));
emptyVoteReceipts.inherited.transactions.vote.receipts = [];
emptyVoteReceipts.inherited.transactions.vote2.receipts = [];
assert.equal(verifySettlementReport(emptyVoteReceipts, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'approvals must prove their own linked execution');

const retryChildFailure = JSON.parse(JSON.stringify(correctedReport));
{
  const retry = retryChildFailure.inherited.transactions.retries[0];
  const id = retry.transactionOutcome.status.SuccessReceiptId;
  retry.receipts.find((receipt) => receipt.id === id).status = {Failure: {ActionError: {kind: 'ERR_PERMISSION_DENIED'}}};
}
assert.equal(verifySettlementReport(retryChildFailure, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a retry child failure other than the expected in-flight error must fail');

const retryNoReceiptLink = JSON.parse(JSON.stringify(correctedReport));
retryNoReceiptLink.inherited.transactions.retries[0].transactionOutcome.receiptIds = [];
assert.equal(verifySettlementReport(retryNoReceiptLink, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a raw retry must link its first executed receipt');

const unrelatedUpgrade = JSON.parse(JSON.stringify(correctedReport));
{
  const deploy = unrelatedUpgrade.inherited.transactions.upgrade.deploy;
  deploy.transaction.receiverId = 'unrelated.test.near';
  deploy.receipts[0].executorId = 'unrelated.test.near';
}
assert.equal(verifySettlementReport(unrelatedUpgrade, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'base, upgrade and migrate must target the same inherited DAO');

const missingVote2Height = JSON.parse(JSON.stringify(correctedReport));
missingVote2Height.inherited.transactions.vote2.blockHeight = null;
assert.equal(verifySettlementReport(missingVote2Height, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the second approval height must be recorded');

const missingFailureHeight = JSON.parse(JSON.stringify(correctedReport));
{
  const logs = missingFailureHeight.inherited.transactions.failedProposal.last_actions_log;
  logs[logs.length - 1].block_height = null;
}
assert.equal(verifySettlementReport(missingFailureHeight, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the recorded old-code failure height must be enforced');

const failureAfterUpgrade = JSON.parse(JSON.stringify(correctedReport));
{
  const logs = failureAfterUpgrade.inherited.transactions.failedProposal.last_actions_log;
  logs[logs.length - 1].block_height = failureAfterUpgrade.inherited.transactions.upgrade.deploy.blockHeight + 1;
}
assert.equal(verifySettlementReport(failureAfterUpgrade, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the old-code failure cannot be after the candidate upgrade');

const substitutedMigrate = JSON.parse(JSON.stringify(correctedReport));
substitutedMigrate.inherited.transactions.upgrade.migrate.transaction.actions[0].FunctionCall.method_name = 'get_config';
assert.equal(verifySettlementReport(substitutedMigrate, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a deploy/get_config transaction relabelled as migrate must fail');

const wrongMigrateReceiver = JSON.parse(JSON.stringify(correctedReport));
wrongMigrateReceiver.inherited.transactions.upgrade.migrate.transaction.receiverId = 'fresh-dao.test.near';
assert.equal(verifySettlementReport(wrongMigrateReceiver, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'migrate must target the inherited DAO');

const missingRawRetries = JSON.parse(JSON.stringify(correctedReport));
missingRawRetries.inherited.transactions.retries = [];
assert.equal(verifySettlementReport(missingRawRetries, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'overlap cannot be accepted without the two full raw retry summaries');

const rawSummaryMismatch = JSON.parse(JSON.stringify(correctedReport));
rawSummaryMismatch.inherited.transactions.retries[0].transactionHash = 'not-the-summary-hash';
assert.equal(verifySettlementReport(rawSummaryMismatch, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a raw retry summary must match the recorded overlap hash');

const reversedChronology = JSON.parse(JSON.stringify(correctedReport));
{
  const add = reversedChronology.inherited.transactions.add;
  const up = reversedChronology.inherited.transactions.upgrade.deploy;
  [add.blockHeight, up.blockHeight] = [up.blockHeight, add.blockHeight];
}
assert.equal(verifySettlementReport(reversedChronology, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the proposal cannot be added after the candidate upgrade');

const missingHeight = JSON.parse(JSON.stringify(correctedReport));
delete missingHeight.inherited.transactions.add.blockHeight;
assert.equal(verifySettlementReport(missingHeight, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a missing recorded block height must fail chronology');

const failedDeploymentReceipt = JSON.parse(JSON.stringify(correctedReport));
{
  const deploy = failedDeploymentReceipt.fresh.deploy;
  const id = deploy.transactionOutcome.status.SuccessReceiptId;
  deploy.receipts.find((receipt) => receipt.id === id).status = {Failure: {ActionError: {kind: 'synthetic failed deployment'}}};
}
assert.equal(verifySettlementReport(failedDeploymentReceipt, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a dispatched deployment whose child receipt failed must fail');

const missingDeploymentReceipts = JSON.parse(JSON.stringify(correctedReport));
missingDeploymentReceipts.fresh.deploy.receipts = [];
assert.equal(verifySettlementReport(missingDeploymentReceipts, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a deployment without its reachable child receipt must fail');

const failedUpgradeReceipt = JSON.parse(JSON.stringify(correctedReport));
{
  const deploy = failedUpgradeReceipt.inherited.transactions.upgrade.deploy;
  const id = deploy.transactionOutcome.status.SuccessReceiptId;
  deploy.receipts.find((receipt) => receipt.id === id).status = {Failure: {ActionError: {kind: 'synthetic failed upgrade'}}};
}
assert.equal(verifySettlementReport(failedUpgradeReceipt, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a failed inherited upgrade receipt must fail');

const failedMigrateReceipt = JSON.parse(JSON.stringify(correctedReport));
{
  const migrate = failedMigrateReceipt.inherited.transactions.upgrade.migrate;
  const id = migrate.transactionOutcome.status.SuccessReceiptId;
  migrate.receipts.find((receipt) => receipt.id === id).status = {Failure: {ActionError: {kind: 'synthetic failed migrate'}}};
}
assert.equal(verifySettlementReport(failedMigrateReceipt, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a failed inherited migrate receipt must fail');

const disconnectedReceipt = JSON.parse(JSON.stringify(correctedReport));
disconnectedReceipt.fresh.deploy.transactionOutcome.status.SuccessReceiptId = 'missing-receipt';
assert.equal(verifySettlementReport(disconnectedReceipt, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a SuccessReceiptId that is not present in the report must fail');

const badInstalledHash = JSON.parse(JSON.stringify(correctedReport));
badInstalledHash.fresh.deploy.codeHash = '1111111111111111111111111111111111';
assert.equal(verifySettlementReport(badInstalledHash, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a deployment whose installed code hash disagrees with its commitment must fail');

const nonFinalDeploy = JSON.parse(JSON.stringify(correctedReport));
nonFinalDeploy.fresh.deploy.finalExecutionStatus = 'INCLUDED';
assert.equal(verifySettlementReport(nonFinalDeploy, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a non-final deployment must fail');

const failedDeploy = JSON.parse(JSON.stringify(correctedReport));
failedDeploy.fresh.deploy.transactionOutcome.status = {Failure: {}};
assert.equal(verifySettlementReport(failedDeploy, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a failed deployment must fail');

const missingAction = JSON.parse(JSON.stringify(correctedReport));
missingAction.fresh.deploy.transaction.actions = [];
assert.equal(verifySettlementReport(missingAction, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a deployment without DeployContract evidence must fail');

const swapped = JSON.parse(JSON.stringify(correctedReport));
swapped.candidate.wasmSha256 = oldReport.candidate.wasmSha256;
assert.equal(verifySettlementReport(swapped, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false, 'a report bound to a different candidate must fail');

const candidateOnly = JSON.parse(JSON.stringify(correctedReport));
candidateOnly.baseWasmSha256 = null;
candidateOnly.inherited.legacy = null;
delete candidateOnly.inherited.transactions.upgrade;
const candidateOnlyCheck = verifySettlementReport(candidateOnly, {candidateWasmSha256: correctedReport.candidate.wasmSha256});
assert.equal(candidateOnlyCheck.ok, false, 'settlement that never entered the pinned old-code upgrade path must fail');
assert.ok(candidateOnlyCheck.errors.some((error) => /legacy upgrade proof is missing/.test(error)));

const missingFresh = JSON.parse(JSON.stringify(correctedReport));
delete missingFresh.fresh;
const missingFreshCheck = verifySettlementReport(missingFresh, {candidateWasmSha256: correctedReport.candidate.wasmSha256});
assert.equal(missingFreshCheck.ok, false, 'a report without the fresh candidate scenario must fail');
assert.ok(missingFreshCheck.errors.some((error) => /settlement scenario is missing/.test(error)));

const wrongBase = JSON.parse(JSON.stringify(correctedReport));
wrongBase.baseWasmSha256 = oldReport.candidate.wasmSha256;
assert.equal(verifySettlementReport(wrongBase, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'a report for a different base artifact must fail');
assert.equal(verifySettlementReport(correctedReport, {candidateWasmSha256: correctedReport.candidate.wasmSha256, baseWasmSha256: oldReport.candidate.wasmSha256}).ok, false,
  'a pinned base identity that does not match the report must fail');
assert.equal(DEFAULT_BASE_WASM_SHA256, correctedReport.baseWasmSha256);

const oneObservableTx = JSON.parse(JSON.stringify(correctedReport));
oneObservableTx.inherited.overlap.attempts[1].transactionHash = oneObservableTx.inherited.overlap.attempts[0].transactionHash;
const oneTxCheck = verifySettlementReport(oneObservableTx, {candidateWasmSha256: correctedReport.candidate.wasmSha256});
assert.equal(oneTxCheck.ok, false, 'one transaction observed twice is not overlap evidence');
assert.ok(oneTxCheck.errors.some((error) => /two distinct transactions/.test(error)));

const oneSigner = JSON.parse(JSON.stringify(correctedReport));
oneSigner.inherited.overlap.attempts[1].signerId = oneSigner.inherited.overlap.attempts[0].signerId;
assert.equal(verifySettlementReport(oneSigner, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'overlap attempts from one signer are not independently submitted');

const noReceipts = JSON.parse(JSON.stringify(correctedReport));
noReceipts.fresh.overlap.attempts[0].receiptIds = [];
assert.equal(verifySettlementReport(noReceipts, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'an overlap attempt without executed receipts cannot count');

const freshLeak = JSON.parse(JSON.stringify(correctedReport));
freshLeak.fresh.legacy = correctedReport.inherited.legacy;
assert.equal(verifySettlementReport(freshLeak, {candidateWasmSha256: correctedReport.candidate.wasmSha256}).ok, false,
  'the fresh scenario cannot claim inherited-upgrade evidence');

console.log(JSON.stringify({
  schema: 'near-rehearsal/settlement-policy-tests/v2',
  passed: true,
  cases: [
    'old-premature-fails',
    'corrected-passes',
    'candidate-binding-fails',
    'identity-label-swap-fails',
    'installed-code-hash-fails',
    'failed-deployment-receipt-fails',
    'approval-receipts-required',
    'genuine-ordered-trace-passes',
    'reused-duplicate-fails',
    'missing-duplicate-height-fails',
    'premature-duplicate-fails',
    'unbounded-duplicate-observation-fails',
    'stale-duplicate-observation-fails',
    'missing-duplicate-observation-fails',
    'copied-pre-observation-fails',
    'missing-after-duplicate-height-fails',
    'duplicate-legacy-hash-fails',
    'missing-retry-height-fails',
    'retry-before-window-fails',
    'add-method-substitution-fails',
    'add-receiver-substitution-fails',
    'add-signer-substitution-fails',
    'add-bond-substitution-fails',
    'add-kind-substitution-fails',
    'add-returned-id-fails',
    'unauthorized-missing-signer-fails',
    'unauthorized-borrowed-failure-fails',
    'unauthorized-label-only-fails',
    'unauthorized-no-action-fails',
    'unauthorized-wrong-method-fails',
    'unauthorized-dao-caller-fails',
    'unauthorized-string-id-fails',
    'unauthorized-wrong-attempt-fails',
    'duplicate-label-only-fails',
    'duplicate-wrong-method-fails',
    'duplicate-wrong-receiver-fails',
    'duplicate-no-receipt-link-fails',
    'legacy-label-only-fails',
    'legacy-wrong-method-fails',
    'legacy-representation-mismatch-fails',
    'two-successful-retries-fail',
    'two-in-flight-retries-fail',
    'wrong-beneficiary-fails',
    'failed-proposal-id-fails',
    'failed-proposal-status-fails',
    'zero-failure-height-fails',
    'failure-before-vote2-fails',
    'legacy-before-migrate-fails',
    'string-failure-height-passes',
    'malformed-failure-height-fails',
    'retry-child-failure-fails',
    'retry-initial-link-required',
    'unrelated-upgrade-dao-fails',
    'missing-vote2-height-fails',
    'missing-failure-height-fails',
    'failure-after-upgrade-fails',
    'migrate-method-substitution-fails',
    'migrate-receiver-substitution-fails',
    'missing-raw-retries-fail',
    'raw-summary-mismatch-fails',
    'reversed-chronology-fails',
    'missing-block-height-fails',
    'multi-hop-success-passes',
    'multi-hop-migrate-passes',
    'terminal-failure-fails',
    'missing-grandchild-fails',
    'receipt-cycle-fails',
    'disconnected-child-fails',
    'duplicate-receipt-fails',
    'unlinked-initial-receipt-fails',
    'missing-deployment-receipts-fail',
    'failed-upgrade-receipt-fails',
    'failed-migrate-receipt-fails',
    'disconnected-receipt-fails',
    'non-final-deployment-fails',
    'failed-deployment-fails',
    'missing-deploy-action-fails',
    'candidate-only-fails',
    'missing-fresh-fails',
    'wrong-base-fails',
    'repeated-hash-fails',
    'single-signer-fails',
    'receiptless-fails',
    'fresh-legacy-leak-fails',
  ],
}, null, 2));
