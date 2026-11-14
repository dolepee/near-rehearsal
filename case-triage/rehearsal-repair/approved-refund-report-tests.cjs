'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verifySettlementReport} = require('./settlement-policy.cjs');

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const recorded = path.join(__dirname, 'out', 'audit-intended');
const base = read(path.join(recorded, 'settlement', 'settlement-refund.json'));
const captures = [['canonical', read(path.join(recorded, 'approved-targeted', 'successful-action-refund.json'))]];
// A separate local execution can exercise these same checks without adding
// private audit paths or regenerated evidence to the repository.
const captureFlag = process.argv.indexOf('--approved-capture');
if (captureFlag !== -1) {
  assert.ok(process.argv[captureFlag + 1], '--approved-capture requires a JSON path');
  captures.push(['fresh', read(path.resolve(process.argv[captureFlag + 1]))]);
}

const snapshots = ['before', 'afterApproval', 'beforeRetry', 'afterRetry', 'afterDuplicate', 'afterUnauthorized'];
const operations = ['approval', 'retry', 'duplicate'];
const cases = [];
const editCall = (transaction, mutate) => {
  const call = transaction.transaction.actions.find((action) => action.FunctionCall)?.FunctionCall;
  assert.ok(call, 'positive capture must contain the operation call');
  const args = JSON.parse(Buffer.from(call.args, 'base64').toString('utf8'));
  mutate(args);
  call.args = Buffer.from(JSON.stringify(args)).toString('base64');
};
const refundFailure = (approved) => {
  const receipt = approved.approval.receipts.find((item) => (
    item.executorId === approved.proposer
    && item.status?.Failure?.ActionError?.kind?.AccountDoesNotExist?.account_id === approved.proposer
  ));
  assert.ok(receipt, 'positive capture must contain the original proposer refund failure');
  return receipt;
};

for (const [captureName, capture] of captures) {
  assert.equal(capture.candidateWasmSha256, base.candidate.wasmSha256, `${captureName} candidate differs from the full-suite fixture`);
  const check = (label, mutate, expected) => {
    const report = structuredClone(base);
    report.successfulActionRefund = structuredClone(capture);
    mutate(report.successfulActionRefund);
    const checked = verifySettlementReport(report, {candidateWasmSha256: base.candidate.wasmSha256});
    assert.equal(checked.status, expected, `${captureName}: ${label}: ${checked.errors.join('; ')}`);
    assert.equal(checked.ok, expected === 'ACCEPTED', `${captureName}: ${label}: inconsistent acceptance flag`);
    cases.push(`${captureName}: ${label}`);
  };

  check('unaltered complete capture', () => {}, 'ACCEPTED');
  check('missing top-level proposal id', (approved) => { delete approved.proposalId; }, 'INCONCLUSIVE');
  for (const invalidId of [null, '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, {}, 'not-an-id']) {
    check(`malformed top-level proposal id ${JSON.stringify(invalidId)}`, (approved) => {
      approved.proposalId = invalidId;
    }, 'INCONCLUSIVE');
  }
  for (const operation of operations) {
    check(`${operation} targets another proposal`, (approved) => {
      editCall(approved[operation], (args) => { args.id = 987654; });
    }, 'INCONCLUSIVE');
  }
  check('original refund failure erased', (approved) => {
    refundFailure(approved).status = {SuccessValue: ''};
  }, 'INCONCLUSIVE');
  check('refund failure executed by another account', (approved) => {
    refundFailure(approved).executorId = 'unrelated.test.near';
  }, 'INCONCLUSIVE');
  check('refund failure identifies another missing account', (approved) => {
    refundFailure(approved).status.Failure.ActionError.kind.AccountDoesNotExist.account_id = 'unrelated.test.near';
  }, 'INCONCLUSIVE');
  check('unrelated structured failure is not a deleted-proposer refund', (approved) => {
    refundFailure(approved).status = {Failure: {ActionError: {index: 0, kind: {FunctionCallError: {ExecutionError: 'unrelated panic'}}}}};
  }, 'INCONCLUSIVE');
  check('typed error text inside a different error is not refund failure evidence', (approved) => {
    const errorText = JSON.stringify({AccountDoesNotExist: {account_id: approved.proposer}});
    refundFailure(approved).status = {Failure: {ActionError: {index: 0, kind: {FunctionCallError: {ExecutionError: errorText}}}}};
  }, 'INCONCLUSIVE');
  check('unlinked refund failure cannot replace the executed failure', (approved) => {
    const original = refundFailure(approved);
    const disconnected = structuredClone(original);
    disconnected.id = 'unlinked-refund-failure';
    disconnected.receiptIds = [];
    original.status = {SuccessValue: ''};
    approved.approval.receipts.push(disconnected);
  }, 'INCONCLUSIVE');

  for (const name of snapshots) {
    check(`${name} proposal missing`, (approved) => { delete approved[name].proposal; }, 'INCONCLUSIVE');
    check(`${name} proposal id changed`, (approved) => { approved[name].proposal.id = 987654; }, 'INCONCLUSIVE');
    check(`${name} proposal proposer changed`, (approved) => { approved[name].proposal.proposer = 'unrelated.test.near'; }, 'INCONCLUSIVE');
    check(`${name} proposal kind changed`, (approved) => { approved[name].proposal.kind = {Vote: {}}; }, 'INCONCLUSIVE');
    check(`${name} proposal status changed`, (approved) => { approved[name].proposal.status = 'Failed'; }, 'INCONCLUSIVE');
  }
  check('consistent snapshot kind rewrite still differs from executed operation', (approved) => {
    for (const name of snapshots) approved[name].proposal.kind = {Vote: {}};
  }, 'INCONCLUSIVE');
  check('consistent snapshot id rewrite still differs from recorded operations', (approved) => {
    for (const name of snapshots) approved[name].proposal.id = 987654;
  }, 'INCONCLUSIVE');
  check('consistent snapshot and operation kind rewrite is not the required transfer', (approved) => {
    for (const name of snapshots) approved[name].proposal.kind = {Vote: {}};
    for (const name of operations) editCall(approved[name], (args) => { args.proposal = {Vote: {}}; });
  }, 'INCONCLUSIVE');
  check('snapshot kind property order does not change proposal identity', (approved) => {
    for (const name of snapshots) {
      const transfer = approved[name].proposal.kind.Transfer;
      approved[name].proposal.kind = {Transfer: {
        msg: transfer.msg, amount: transfer.amount, receiver_id: transfer.receiver_id, token_id: transfer.token_id,
      }};
    }
  }, 'ACCEPTED');

  const underpayRetry = (approved) => {
    // Keep the subsequent zero-principal operations consistent so the only
    // economic counterexample is the original retry's one-yocto underpayment.
    for (const name of ['afterRetry', 'afterDuplicate', 'afterUnauthorized']) {
      approved[name].proposer = (BigInt(approved[name].proposer) - 1n).toString();
    }
  };
  check('complete retry underpayment is rejected', underpayRetry, 'REJECTED');
  check('retry underpayment survives missing initial-failure evidence', (approved) => {
    refundFailure(approved).status = {SuccessValue: ''};
    underpayRetry(approved);
  }, 'REJECTED');
  check('retry underpayment survives missing unrelated later proposal', (approved) => {
    delete approved.afterUnauthorized.proposal;
    underpayRetry(approved);
  }, 'REJECTED');
  check('duplicate principal loss survives unrelated earlier proposal drift', (approved) => {
    approved.before.proposal.status = 'Failed';
    approved.afterDuplicate.proposer = (BigInt(approved.afterDuplicate.proposer) - 1n).toString();
  }, 'REJECTED');
}

console.log(JSON.stringify({schema: 'near-rehearsal/approved-refund-report-tests/v1', passed: true, cases}, null, 2));
