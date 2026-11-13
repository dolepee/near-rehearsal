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
