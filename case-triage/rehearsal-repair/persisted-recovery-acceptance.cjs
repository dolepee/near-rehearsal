'use strict';
/*
 * Independent acceptance for persisted old-code failure recovery.
 *
 * The report's convenience booleans and cached deltas are not trusted. State,
 * authority, payment accounting and the past-settled control are recomputed
 * from the frozen/after snapshots and the actual candidate bytes.
 *
 * Native balances are allowed to move for deploy, migrate, gas and storage.
 * Gross bond recovery is measured from the locked amount and from the
 * proposer credit plus receipt-derived gas; recipient and contract deltas are
 * checked separately.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const {hashContract} = require('near-workspaces');

const BASE_WASM_SHA = '5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578';
const BOND = 10n ** 24n;
const TRANSFER = 10n ** 23n;
const SANDBOX = '2.14.0';
const SANDBOX_COMMIT = 'bc4e9e8cfb03d9e82f027883055624e18576993e';
const SANDBOX_PROTOCOL = 88;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha256File = (file) => sha256(fs.readFileSync(file));
const stateHash = (state) => sha256(JSON.stringify(state));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const failureText = (status) => JSON.stringify(status || {});

function summaryGas(summary) {
  const tx = BigInt(summary?.transactionOutcome?.tokensBurntYocto ?? 0);
  const receipts = (summary?.receipts || []).reduce((sum, receipt) => sum + BigInt(receipt?.tokensBurntYocto ?? 0), 0n);
  return tx + receipts;
}

function receiptGraphErrors(summary, label, fail) {
  if (summary?.finalExecutionStatus !== 'FINAL') fail(`${label} has no separate FINAL execution status`);
  if (summary?.transactionOutcome?.status?.Failure) fail(`${label} transaction outcome failed`);
  const roots = summary?.transactionOutcome?.rootReceiptIds;
  if (!Array.isArray(roots) || roots.length === 0) {
    fail(`${label} has no transaction-outcome root receipt IDs`);
    return;
  }
  const receipts = summary?.receipts || [];
  const byId = new Map();
  for (const receipt of receipts) {
    if (!receipt?.id || byId.has(receipt.id)) fail(`${label} has a duplicate or missing receipt id`);
    else byId.set(receipt.id, receipt);
  }
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const receipt = byId.get(id);
    if (!receipt) {
      fail(`${label} roots a receipt that is not present: ${id}`);
      continue;
    }
    for (const child of receipt.receiptIds || []) queue.push(child);
  }
  for (const id of byId.keys()) {
    if (!seen.has(id)) fail(`${label} contains a receipt not reachable from the transaction root: ${id}`);
  }
  const computed = summaryGas(summary);
  if (BigInt(summary?.gasBurntYocto ?? '-1') !== computed) fail(`${label} recorded gas does not equal transaction tokens plus receipt tokens`);
}

function hasFailure(summary, executorId, needle) {
  return (summary?.receipts || []).some((receipt) =>
    receipt?.executorId === executorId &&
    receipt?.status?.Failure &&
    (!needle || failureText(receipt.status).includes(needle))
  );
}

function functionCall(summary, method) {
  for (const action of summary?.transaction?.actions || []) {
    if (action?.FunctionCall?.method_name !== method) continue;
    let args = null;
    try { args = action.FunctionCall.args ? JSON.parse(Buffer.from(action.FunctionCall.args, 'base64').toString('utf8')) : null; } catch {}
    return {method, args, deposit: action.FunctionCall.deposit, action};
  }
  return null;
}

function hasAction(summary, name) {
  return (summary?.transaction?.actions || []).some((action) => action?.[name]);
}

function assertProposalAction(summary, label, report, proposalId, action, fail) {
  if (!summary?.transaction) { fail(`${label} has no transaction`); return; }
  if (summary.transaction.signerId !== report?.accounts?.proposer) fail(`${label} signer is not the recorded proposer`);
  if (summary.transaction.receiverId !== report?.accounts?.contract) fail(`${label} receiver is not the contract`);
  const call = functionCall(summary, 'act_proposal');
  if (!call) { fail(`${label} has no act_proposal action`); return; }
  if (String(call.args?.id) !== String(proposalId)) fail(`${label} proposal id does not match the recorded obligation`);
  if (call.args?.action !== action) fail(`${label} action is not ${action}`);
}

function verify(report, options = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (report?.schema !== 'near-rehearsal/persisted-bond-recovery/v1') fail('report schema');
  if (report?.runtime?.sandbox !== SANDBOX) fail('Sandbox is not 2.14.0');
  if (report?.runtime?.commit !== SANDBOX_COMMIT) fail('Sandbox commit');
  if (Number(report?.runtime?.protocol) !== SANDBOX_PROTOCOL) fail('Sandbox protocol');
  if (report?.source?.baseWasmSha256 !== BASE_WASM_SHA) fail('base WASM identity');

  // Bind the actual candidate bytes, not a report-only hash.
  if (!options.wasmPath) fail('candidate WASM file is required for byte/code identity');
  let candidateBytes = null;
  let candidateCodeHash = null;
  if (options.wasmPath) {
    candidateBytes = fs.readFileSync(options.wasmPath);
    const actualSha = sha256(candidateBytes);
    candidateCodeHash = hashContract(candidateBytes);
    if (report?.candidate?.wasmSha256 !== actualSha) fail('candidate WASM SHA-256 does not match report');
    if (report?.candidate?.wasmHash !== candidateCodeHash) fail('candidate WASM code hash does not match report');
    if (Number(report?.candidate?.wasmBytes) !== candidateBytes.length) fail('candidate WASM byte length does not match report');
    if (report?.upgrade?.codeHash !== candidateCodeHash) fail('upgraded code hash does not match actual candidate bytes');
  }
  if (options.expectedWasmSha256 && report?.candidate?.wasmSha256 !== options.expectedWasmSha256) fail('candidate WASM SHA-256 expectation');
  if (options.expectedPatchSha256 && report?.identity?.patch?.sha256 !== options.expectedPatchSha256) fail('candidate patch SHA-256 expectation');
  if (options.expectedSourceSha256 && report?.identity?.source?.sha256 !== options.expectedSourceSha256) fail('candidate source SHA-256 expectation');
  if (report?.identity?.wasm?.sha256 && report.identity.wasm.sha256 !== report.candidate.wasmSha256) fail('identity WASM does not match report');
  if (options.patchPath) {
    const actual = sha256File(options.patchPath);
    if (report?.identity?.patch?.sha256 && actual !== report.identity.patch.sha256) fail('patch file changed after identity binding');
  }
  if (options.sourcePath) {
    const actual = sha256File(options.sourcePath);
    if (report?.identity?.source?.sha256 && actual !== report.identity.source.sha256) fail('source file changed after identity binding');
  }

  const failed = report?.failed;
  const frozen = failed?.frozen;
  const upgraded = report?.upgraded;
  if (failed?.proposal?.status !== 'Failed') fail('old-code proposal did not end Failed');
  if (frozen?.proposal?.status !== 'Failed') fail('frozen proposal is not Failed');
  if (BigInt(frozen?.lockedAmount ?? '-1') !== BOND) fail('frozen locked amount is not the declared bond');
  const beforeContract = BigInt(failed?.beforeProposal?.contract ?? '-1');
  const afterAddContract = BigInt(failed?.afterAdd?.contract ?? '-2');
  if (afterAddContract - beforeContract !== BOND) fail('bond was not attached to the failed proposal');
  if (failed?.afterAdd?.proposal?.status !== 'InProgress') fail('proposal was not in progress after add');
  if (report?.deploy?.succeeded !== true || report?.init?.succeeded !== true) fail('base deploy/init did not succeed');
  if (failed?.add?.succeeded !== true) fail('failed proposal add did not succeed');
  if (failed?.vote?.succeeded !== true) fail('failed proposal vote did not succeed');

  // Recompute preservation from raw state and snapshots.
  if (stateHash(frozen?.state) !== stateHash(upgraded?.state)) fail('state changed across code replacement');
  if (!sameJson(frozen?.policy, upgraded?.policy)) fail('policy changed across code replacement');
  if (!sameJson(frozen?.proposal, upgraded?.proposal)) fail('proposal changed across code replacement');
  if (String(frozen?.lockedAmount) !== String(upgraded?.lockedAmount)) fail('locked funds changed across code replacement');
  if (upgraded?.codeHash !== candidateCodeHash) fail('candidate code was not applied to the persisted account');

  // Recompute authority from executed transaction summaries.
  const updateProbe = report?.authority?.unauthorizedUpdateProbe;
  if (!updateProbe?.ok || updateProbe?.value?.finalExecutionStatus !== 'FINAL') fail('unauthorized update probe was not an executed FINAL transaction');
  else if (!hasFailure(updateProbe.value, report?.accounts?.contract, 'ERR_MUST_BE_SELF_OR_FACTORY')) fail('unauthorized update did not fail with the expected authority error');
  const finalizeProbe = report?.authority?.unauthorizedFinalizeProbe;
  if (!finalizeProbe?.ok || finalizeProbe?.value?.finalExecutionStatus !== 'FINAL') fail('unauthorized finalize probe was not an executed FINAL transaction');
  else if (!hasFailure(finalizeProbe.value, report?.accounts?.contract, 'ERR_PERMISSION_DENIED')) fail('unauthorized finalize did not fail with the expected permission error');
  // Upgrade path: deploy + migrate on the contract account, both FINAL and
  // successful, with no initializer call. The base init is the only new().
  const baseDeploy = report?.deploy;
  const baseInit = report?.init;
  if (!baseDeploy?.transaction || !baseInit?.transaction) fail('base deploy/init summaries are missing');
  else {
    if (baseDeploy.transaction.signerId !== report?.accounts?.contract || baseDeploy.transaction.receiverId !== report?.accounts?.contract) fail('base deploy signer/receiver is not the contract');
    if (!hasAction(baseDeploy, 'DeployContract')) fail('base deploy has no DeployContract action');
    if (baseInit.transaction.signerId !== report?.accounts?.factory || baseInit.transaction.receiverId !== report?.accounts?.contract) fail('base init signer/receiver does not match the recorded factory/contract');
    if (!functionCall(baseInit, 'new')) fail('base init has no new() action');
  }
  const upgradeDeploy = report?.upgrade?.final;
  const upgradeMigrate = report?.upgrade?.migrate;
  for (const [label, summary] of [['upgrade deploy', upgradeDeploy], ['upgrade migrate', upgradeMigrate]]) {
    receiptGraphErrors(summary, label, fail);
    if (summary?.receiptFailure !== false) fail(`${label} did not produce a successful receipt`);
    if (summary?.transaction?.signerId !== report?.accounts?.contract) fail(`${label} signer is not the contract`);
    if (summary?.transaction?.receiverId !== report?.accounts?.contract) fail(`${label} receiver is not the contract`);
  }
  if (!hasAction(upgradeDeploy, 'DeployContract')) fail('upgrade deploy has no DeployContract action');
  if (functionCall(upgradeDeploy, 'new')) fail('upgrade deploy unexpectedly calls new()');
  if (!functionCall(upgradeMigrate, 'migrate')) fail('upgrade migrate has no migrate() action');
  if (functionCall(upgradeMigrate, 'new')) fail('upgrade migrate unexpectedly calls new()');
  if (hasAction(upgradeMigrate, 'DeployContract')) fail('upgrade migrate contains an unexpected deploy action');
  if (report?.authority?.upgradeMethod !== 'account-key deploy + private migrate') fail('upgrade method is not the declared account-key deploy/migrate path');

  assertProposalAction(report?.firstRecovery?.final, 'first recovery', report, report?.failed?.proposalId, 'Finalize', fail);
  assertProposalAction(report?.secondRetry?.final, 'second retry', report, report?.failed?.proposalId, 'Finalize', fail);

  receiptGraphErrors(report?.firstRecovery?.final, 'first recovery', fail);
  receiptGraphErrors(report?.secondRetry?.final, 'second retry', fail);
  receiptGraphErrors(report?.authority?.unauthorizedUpdateProbe?.value, 'unauthorized update', fail);
  receiptGraphErrors(report?.authority?.unauthorizedFinalizeProbe?.value, 'unauthorized finalize', fail);
  if (report?.healthyPreservation?.finalizeAttempt?.value) {
    receiptGraphErrors(report.healthyPreservation.finalizeAttempt.value, 'past-settled finalize', fail);
  }

  const firstBefore = report?.firstRecovery?.before;
  const firstAfter = report?.firstRecovery?.after;
  const firstFinal = report?.firstRecovery?.final;
  if (firstFinal?.finalExecutionStatus !== 'FINAL') fail('first recovery was not FINAL');
  if (firstFinal?.receiptFailure !== true || !hasFailure(firstFinal, report?.accounts?.failedTarget)) fail('first recovery lacks the expected downstream failure receipt');
  if (report?.firstRecovery?.proposal?.status !== 'Failed') fail('first recovery did not end Failed');
  const firstDeltas = {
    contract: BigInt(firstAfter?.contractBalance ?? 0) - BigInt(firstBefore?.contractBalance ?? 0),
    proposer: BigInt(firstAfter?.proposerBalance ?? 0) - BigInt(firstBefore?.proposerBalance ?? 0),
    recipient: BigInt(firstAfter?.recipientBalance ?? 0) - BigInt(firstBefore?.recipientBalance ?? 0),
    locked: BigInt(firstAfter?.lockedAmount ?? 0) - BigInt(firstBefore?.lockedAmount ?? 0),
  };
  const firstGas = summaryGas(firstFinal);
  if (firstDeltas.locked !== -BOND) fail('first recovery did not clear the bond liability exactly once');
  if (firstDeltas.contract !== -BOND) fail('first recovery contract delta is not exactly the bond');
  if (firstDeltas.recipient !== 0n) fail('first recovery paid the failed target');
  if (firstDeltas.proposer + firstGas !== BOND) fail('first recovery proposer credit is not bond minus receipt-derived gas');
  if (firstDeltas.contract + firstDeltas.proposer + firstDeltas.recipient !== -firstGas) fail('first recovery account deltas do not conserve transaction gas');
  if (BigInt(report?.firstRecovery?.grossRecoveryYocto ?? '0') !== BOND) fail('reported first gross recovery is not the bond');
  if (report?.firstRecovery?.endedFailed !== true) fail('first recovery endedFailed flag');
  if (report?.firstRecovery?.noTargetPayment !== true) fail('first recovery noTargetPayment flag');

  const secondBefore = report?.secondRetry?.before;
  const secondAfter = report?.secondRetry?.after;
  const secondFinal = report?.secondRetry?.final;
  if (secondFinal?.finalExecutionStatus !== 'FINAL') fail('second retry was not FINAL');
  if (secondFinal?.receiptFailure !== true || !hasFailure(secondFinal, report?.accounts?.failedTarget)) fail('second retry lacks the expected downstream failure receipt');
  if (report?.secondRetry?.proposal?.status !== 'Failed') fail('second retry did not end Failed');
  const secondDeltas = {
    contract: BigInt(secondAfter?.contractBalance ?? 0) - BigInt(secondBefore?.contractBalance ?? 0),
    proposer: BigInt(secondAfter?.proposerBalance ?? 0) - BigInt(secondBefore?.proposerBalance ?? 0),
    recipient: BigInt(secondAfter?.recipientBalance ?? 0) - BigInt(secondBefore?.recipientBalance ?? 0),
    locked: BigInt(secondAfter?.lockedAmount ?? 0) - BigInt(secondBefore?.lockedAmount ?? 0),
  };
  const secondGas = summaryGas(secondFinal);
  if (secondDeltas.locked !== 0n) fail('second retry changed the locked entitlement');
  if (secondDeltas.contract !== 0n) fail('second retry changed the contract balance');
  if (secondDeltas.recipient !== 0n) fail('second retry paid the failed target');
  if (secondDeltas.proposer + secondGas !== 0n) fail('second retry proposer delta is not receipt-derived gas');
  if (secondDeltas.contract + secondDeltas.proposer + secondDeltas.recipient !== -secondGas) fail('second retry account deltas do not conserve transaction gas');
  if (BigInt(report?.secondRetry?.grossRecoveryYocto ?? '1') !== 0n) fail('second retry reported another bond recovery');
  if (report?.secondRetry?.endedFailed !== true) fail('second retry endedFailed flag');
  if (report?.secondRetry?.noTargetPayment !== true) fail('second retry noTargetPayment flag');

  // Recompute the past-settled control from snapshots, not its cached checks.
  const healthy = report?.healthyPreservation;
  if (!healthy) {
    fail('healthy/past-settled control missing');
  } else {
    const settled = healthy.settled;
    const afterUpgrade = healthy.afterUpgrade;
    const afterAttempt = healthy.afterAttempt;
    if (settled?.proposal?.status !== 'Approved') fail('past-settled proposal is not Approved');
    if (BigInt(settled?.recipientBalance ?? 0) - BigInt(healthy?.before?.recipient ?? 0) !== TRANSFER) fail('past-settled payout is not the declared transfer');
    if (afterUpgrade?.codeHash !== candidateCodeHash) fail('past-settled control was not upgraded to candidate code');
    if (!sameJson(afterUpgrade?.proposal, settled?.proposal)) fail('past-settled proposal changed across upgrade');
    if (afterUpgrade?.recipientBalance !== settled?.recipientBalance) fail('past-settled recipient changed across upgrade');
    if (BigInt(settled?.lockedAmount ?? '-1') !== 0n) fail('past-settled control still has locked funds');
    if (!healthy?.finalizeAttempt?.ok || healthy?.finalizeAttempt?.value?.finalExecutionStatus !== 'FINAL') fail('past-settled finalize probe was not an executed FINAL transaction');
    else if (!healthy.finalizeAttempt.value.receiptFailure || !hasFailure(healthy.finalizeAttempt.value, report?.accounts?.contract, 'ERR_PROPOSAL_NOT_IN_PROGRESS')) fail('past-settled finalize did not fail as expected');
    if (afterAttempt?.recipientBalance !== settled?.recipientBalance) fail('past-settled control paid again after finalize attempt');

    // A Transfer that was still pending on the old code must survive the code
    // replacement and pay exactly once with its bond accounted separately.
    const pending = healthy?.pending;
    if (!pending) {
      fail('unpaid pending Transfer control missing');
    } else {
      const pendingBefore = pending.before;
      const pendingUpgrade = pending.afterUpgrade;
      const pendingFinal = pending.final;
      const pendingAfter = pending.after;
      const pendingKind = pendingBefore?.proposal?.kind?.Transfer;
      if (pendingBefore?.proposal?.status !== 'InProgress') fail('pending Transfer was not InProgress before upgrade');
      if (!pendingKind || pendingKind.receiver_id !== report?.accounts?.recipient || pendingKind.amount !== TRANSFER.toString()) fail('pending Transfer beneficiary/amount does not match the recorded obligation');
      if (BigInt(pendingBefore?.lockedAmount ?? '-1') !== BOND) fail('pending Transfer did not lock its bond before upgrade');
      if (pendingUpgrade?.codeHash !== candidateCodeHash) fail('pending Transfer was not preserved on candidate code');
      if (!sameJson(pendingUpgrade?.proposal, pendingBefore?.proposal)) fail('pending Transfer proposal changed across upgrade');
      if (String(pendingUpgrade?.lockedAmount) !== String(pendingBefore?.lockedAmount)) fail('pending Transfer bond changed across upgrade');
      receiptGraphErrors(pendingFinal, 'pending healthy Transfer', fail);
      if (pendingFinal?.finalExecutionStatus !== 'FINAL' || pendingFinal?.receiptFailure !== false) fail('pending healthy Transfer did not execute successfully');
      assertProposalAction(pendingFinal, 'pending healthy Transfer', report, pending.proposalId, 'VoteApprove', fail);
      if (pendingAfter?.proposal?.status !== 'Approved') fail('pending healthy Transfer did not end Approved');
      const payoutBase = pending.beforePayout || healthy.afterAttempt;
      const pendingDeltas = {
        contract: BigInt(pendingAfter?.contractBalance ?? 0) - BigInt(payoutBase?.contractBalance ?? 0),
        proposer: BigInt(pendingAfter?.proposerBalance ?? 0) - BigInt(payoutBase?.proposerBalance ?? 0),
        recipient: BigInt(pendingAfter?.recipientBalance ?? 0) - BigInt(payoutBase?.recipientBalance ?? 0),
        locked: BigInt(pendingAfter?.lockedAmount ?? 0) - BigInt(payoutBase?.lockedAmount ?? 0),
      };
      const pendingGas = summaryGas(pendingFinal);
      if (pendingDeltas.locked !== -BOND) fail('pending Transfer did not clear its bond liability');
      if (pendingDeltas.contract !== -(BOND + TRANSFER)) fail('pending Transfer contract delta is not the bond plus the transfer');
      if (pendingDeltas.recipient !== TRANSFER) fail('pending Transfer did not pay the declared recipient exactly once');
      if (pendingDeltas.proposer + pendingGas !== BOND) fail('pending Transfer proposer credit is not bond minus receipt-derived gas');
      if (pendingDeltas.contract + pendingDeltas.proposer + pendingDeltas.recipient !== -pendingGas) fail('pending Transfer account deltas do not conserve transaction gas');
    }
  }
  return errors;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--report') opts.report = args[++i];
    else if (arg === '--wasm') opts.wasmPath = args[++i];
    else if (arg === '--expected-wasm-sha256') opts.expectedWasmSha256 = args[++i];
    else if (arg === '--expected-patch-sha256') opts.expectedPatchSha256 = args[++i];
    else if (arg === '--expected-source-sha256') opts.expectedSourceSha256 = args[++i];
    else if (arg === '--patch') opts.patchPath = args[++i];
    else if (arg === '--source') opts.sourcePath = args[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.report) throw new Error('--report is required');
  if (!opts.wasmPath) throw new Error('--wasm is required');
  const report = JSON.parse(fs.readFileSync(opts.report, 'utf8'));
  const errors = verify(report, opts);
  console.log(JSON.stringify({
    schema: 'near-rehearsal/persisted-bond-recovery-acceptance/v1',
    ok: errors.length === 0,
    candidateWasmSha256: report?.candidate?.wasmSha256 ?? null,
    errors,
  }, null, 2));
  if (errors.length) process.exitCode = 1;
}

module.exports = {verify, BASE_WASM_SHA, BOND, TRANSFER};
