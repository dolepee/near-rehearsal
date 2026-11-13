'use strict';
/*
 * Acceptance policy for the failed-refund settlement obligation.
 *
 * This is intentionally independent of the candidate's own report verdict: it
 * recomputes the debt/refund/retry facts from a fresh local execution report.
 *
 * An accepted settlement report must contain two independently executed
 * scenarios: the candidate deployed from genesis, and a proposal created on the
 * pinned base artifact and inherited across an upgrade to the candidate. The
 * second scenario is what proves the historical bond/refund state survives.
 */
const BOND = 10n ** 24n;
const REQUIRED_SCHEMA = 'near-rehearsal/settlement-refund/v2';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes) {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) + BigInt(byte);
  let out = '';
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = `1${out}`; }
  return out || '1';
}

function receiptChain(transaction, label, fail, allowInFlight = false) {
  const start = transaction?.transactionOutcome?.status?.SuccessReceiptId;
  if (!start) { fail(`${label} has no SuccessReceiptId`); return {ok: false}; }
  if (!Array.isArray(transaction.transactionOutcome.receiptIds) || !transaction.transactionOutcome.receiptIds.includes(start)) {
    fail(`${label} initial transaction does not link its SuccessReceiptId`);
    return {ok: false};
  }
  const receipts = Array.isArray(transaction.receipts) ? transaction.receipts : [];
  const byId = new Map();
  for (const receipt of receipts) {
    if (!receipt?.id) continue;
    if (byId.has(receipt.id)) { fail(`${label} has a duplicate receipt id`); return {ok: false}; }
    byId.set(receipt.id, receipt);
  }
  const seen = new Set();
  let id = start;
  let first = true;
  while (id) {
    if (seen.has(id)) { fail(`${label} receipt chain contains a cycle`); return {ok: false}; }
    seen.add(id);
    const receipt = byId.get(id);
    if (!receipt) { fail(`${label} receipt chain has a missing child`); return {ok: false}; }
    if (first) {
      if (receipt.executorId !== transaction.transaction?.receiverId) {
        fail(`${label} first child receipt executed by the wrong receiver`);
        return {ok: false};
      }
      first = false;
    }
    const status = receipt.status || {};
    if (status.Failure) {
      const error = JSON.stringify(status.Failure);
      if (allowInFlight && error.includes('ERR_PROPOSAL_NOT_IN_PROGRESS')) return {ok: false, expected: true};
      fail(`${label} receipt chain contains a failure`);
      return {ok: false};
    }
    if (Object.prototype.hasOwnProperty.call(status, 'SuccessValue')) return {ok: true};
    const next = typeof status.SuccessReceiptId === 'string' ? status.SuccessReceiptId : null;
    if (!next) { fail(`${label} receipt chain has no terminal SuccessValue`); return {ok: false}; }
    if (!Array.isArray(receipt.receiptIds) || !receipt.receiptIds.includes(next)) {
      fail(`${label} receipt chain child is not linked by the preceding receipt`);
      return {ok: false};
    }
    id = next;
  }
  fail(`${label} receipt chain has no terminal SuccessValue`);
  return {ok: false};
}

function successfulReceiptChain(transaction, label, fail) {
  return receiptChain(transaction, label, fail).ok;
}

function deploymentCommitment(deploy, label, fail, expectedDao = null) {
  if (!deploy || deploy.finalExecutionStatus !== 'FINAL') { fail(`${label} deployment was not FINAL`); return null; }
  if (!successfulReceiptChain(deploy, label, fail)) return null;
  if (expectedDao && deploy.transaction?.receiverId !== expectedDao) {
    fail(`${label} receiver is not the inherited DAO`);
    return null;
  }
  const action = (deploy.transaction?.actions || []).find((entry) => entry && entry.DeployContract);
  if (!action) { fail(`${label} deployment has no DeployContract action`); return null; }
  let code;
  try { code = Buffer.from(action.DeployContract.code, 'base64'); } catch { code = null; }
  if (!code || code.length !== 32) { fail(`${label} DeployContract code commitment is not 32 bytes`); return null; }
  const sha256 = code.toString('hex');
  if (deploy.wasmSha256 !== sha256) fail(`${label} deployment label does not match its DeployContract commitment`);
  if (deploy.codeHash !== base58Encode(code)) fail(`${label} installed code hash does not match its DeployContract commitment`);
  return sha256;
}

const DEFAULT_BASE_WASM_SHA256 = '5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578';


function decodeCall(transaction, label, fail) {
  const call = (transaction?.transaction?.actions || [])[0]?.FunctionCall;
  if (!call) { fail(`${label} is not a FunctionCall`); return null; }
  let args;
  try { args = JSON.parse(Buffer.from(call.args || '', 'base64').toString('utf8')); }
  catch { fail(`${label} args are not valid JSON`); return null; }
  return {call, args};
}

function verifyMigrate(scenario, dao, failFor) {
  const migrate = scenario.transactions?.upgrade?.migrate;
  if (!migrate) { failFor(false, 'migrate transaction is missing'); return; }
  if (migrate.finalExecutionStatus !== 'FINAL') failFor(false, 'migrate was not FINAL');
  if (migrate.transaction?.signerId !== dao || migrate.transaction?.receiverId !== dao) failFor(false, 'migrate was not signed and received by the inherited DAO');
  const decoded = decodeCall(migrate, 'migrate', (message) => failFor(false, message));
  if (!decoded) return;
  if (decoded.call.method_name !== 'migrate') failFor(false, 'migrate FunctionCall method is wrong');
  if (Object.keys(decoded.args || {}).length !== 0) failFor(false, 'migrate args are not empty');
  if (!successfulReceiptChain(migrate, 'migrate', (message) => failFor(false, message))) failFor(false, 'migrate receipt chain did not reach success');
}

function verifyVote(scenario, signer, label, failFor) {
  const vote = scenario.transactions?.[label];
  if (!vote) { failFor(false, `${label} transaction is missing`); return false; }
  if (vote.finalExecutionStatus !== 'FINAL') failFor(false, `${label} was not FINAL`);
  if (vote.transaction?.signerId !== signer) failFor(false, `${label} signer does not match the recorded approval`);
  if (vote.transaction?.receiverId !== scenario.deploy?.transaction?.receiverId) failFor(false, `${label} receiver is not the DAO`);
  const decoded = decodeCall(vote, label, (message) => failFor(false, message));
  if (!decoded) return false;
  if (decoded.call.method_name !== 'act_proposal' || decoded.args?.action !== 'VoteApprove') failFor(false, `${label} is not a VoteApprove`);
  if (String(decoded.args?.id) !== String(scenario.proposalId)) failFor(false, `${label} targets a different proposal`);
  if (!successfulReceiptChain(vote, label, (message) => failFor(false, message))) return false;
  return true;
}

function verifyRetries(scenario, dao, failFor) {
  const raw = scenario.transactions?.retries;
  const attempts = scenario.overlap?.attempts;
  if (!Array.isArray(raw) || raw.length !== 2) { failFor(false, 'two full retry transaction summaries are required'); return; }
  if (!Array.isArray(attempts) || attempts.length !== 2) { failFor(false, 'two retry attempts are required'); return; }
  const voteSigners = [scenario.transactions?.vote?.transaction?.signerId, scenario.transactions?.vote2?.transaction?.signerId].filter(Boolean);
  if (voteSigners.length !== 2) failFor(false, 'two recorded voter approvals are required');
  if (!verifyVote(scenario, voteSigners[0], 'vote', failFor) || !verifyVote(scenario, voteSigners[1], 'vote2', failFor)) return;
  const hashes = [];
  const signers = [];
  let successful = 0;
  raw.forEach((tx, index) => {
    const label = `retry ${index + 1}`;
    if (tx.finalExecutionStatus !== 'FINAL') failFor(false, `${label} was not FINAL`);
    if (tx.transaction?.receiverId !== dao) failFor(false, `${label} receiver is not the DAO`);
    if (!voteSigners.includes(tx.transaction?.signerId)) failFor(false, `${label} signer was not an approving voter`);
    const decoded = decodeCall(tx, label, (message) => failFor(false, message));
    if (!decoded) return;
    if (decoded.call.method_name !== 'act_proposal') failFor(false, `${label} method is not act_proposal`);
    if (decoded.args?.action !== 'Finalize') failFor(false, `${label} is not Finalize`);
    if (String(decoded.args?.id) !== String(scenario.proposalId)) failFor(false, `${label} targets a different proposal`);
    const receiptIds = (tx.receipts || []).map((receipt) => receipt.id).filter(Boolean);
    if (!receiptIds.length) failFor(false, `${label} has no executed receipts`);
    const attempt = attempts[index];
    if (attempt?.transactionHash !== tx.transactionHash) failFor(false, `${label} summary hash does not match its attempt`);
    if (attempt?.signerId !== tx.transaction?.signerId) failFor(false, `${label} summary signer does not match its attempt`);
    if (JSON.stringify(attempt?.receiptIds || []) !== JSON.stringify(receiptIds)) failFor(false, `${label} summary receipts do not match its attempt`);
    const outcome = receiptChain(tx, label, (message) => failFor(false, message), true);
    if (outcome.ok) successful += 1;
    hashes.push(tx.transactionHash); signers.push(tx.transaction?.signerId);
  });
  if (new Set(hashes).size !== 2) failFor(false, 'retry transactions do not have distinct hashes');
  if (new Set(signers).size !== 2) failFor(false, 'retry transactions do not have distinct signers');
  if (successful < 1) failFor(false, 'no retry transaction successfully executed the action');
}


function recordedHeight(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  return null;
}

function verifyScenario(scenario, mode, context) {
  const {fail, text, candidateWasmSha256, baseWasmSha256, report} = context;
  if (!scenario) { fail(`${mode} settlement scenario is missing`); return null; }
  const failFor = (condition, message) => { if (!condition) fail(`${mode}: ${message}`); };

  if (mode === 'candidate-only') {
    if (scenario.legacy) failFor(false, 'fresh candidate scenario must not claim legacy upgrade evidence');
    const committed = deploymentCommitment(scenario.deploy, 'fresh candidate', (message) => failFor(false, message));
    if (committed !== candidateWasmSha256) failFor(false, 'fresh candidate deployment does not commit to the candidate WASM');
    if (scenario.deploy?.wasmSha256 !== candidateWasmSha256) failFor(false, 'fresh candidate scenario did not deploy the candidate WASM');
    const upgrade = report?.inherited?.transactions?.upgrade;
    if (upgrade && scenario.deploy?.codeHash && upgrade.codeHash && scenario.deploy.codeHash !== upgrade.codeHash) {
      failFor(false, 'fresh deployment installed different code from the inherited upgrade');
    }
  } else {
    const legacy = scenario.legacy;
    if (!legacy) failFor(false, 'legacy upgrade proof is missing');
    else {
      if (legacy.baseWasmSha256 !== baseWasmSha256) failFor(false, 'legacy base WASM identity is wrong');
      if (legacy.candidateWasmSha256 !== candidateWasmSha256) failFor(false, 'legacy candidate identity is wrong');
      if (legacy.upgradeCodeHash !== scenario.transactions?.upgrade?.codeHash || !legacy.upgradeCodeHash) failFor(false, 'legacy upgrade did not install the candidate');
      if (legacy.proposalCreatedBeforeUpgrade !== true) failFor(false, 'legacy proposal was not created before upgrade');
      if (legacy.legacyFinalize?.finalExecutionStatus !== 'FINAL') failFor(false, 'legacy finalize evidence is missing');
    }
    const upgrade = scenario.transactions?.upgrade;
    if (!upgrade || upgrade.candidateWasmSha256 !== candidateWasmSha256 || !upgrade.deploy || !upgrade.migrate) {
      failFor(false, 'legacy upgrade transaction evidence is missing');
    } else {
      const upgradedCode = deploymentCommitment(upgrade.deploy, 'inherited upgrade', (message) => failFor(false, message), scenario.deploy?.transaction?.receiverId);
      if (upgradedCode !== candidateWasmSha256) failFor(false, 'inherited upgrade does not commit to the candidate WASM');
      if (upgrade.codeHash !== base58Encode(Buffer.from(candidateWasmSha256, 'hex'))) failFor(false, 'inherited installed code hash is not the candidate');
      if (upgrade.migrate?.finalExecutionStatus !== 'FINAL') failFor(false, 'inherited migrate was not successful');
      if (upgrade.migrate && !successfulReceiptChain(upgrade.migrate, 'inherited migrate', (message) => failFor(false, message))) {
        failFor(false, 'inherited migrate child receipt failed');
      }
    }
    const baseCommitted = deploymentCommitment(scenario.deploy, 'inherited base', (message) => failFor(false, message), scenario.deploy?.transaction?.receiverId);
    if (baseCommitted !== baseWasmSha256) failFor(false, 'inherited scenario does not commit to the pinned base WASM');
    if (scenario.deploy?.wasmSha256 !== baseWasmSha256) failFor(false, 'inherited scenario did not deploy the pinned base WASM');
    verifyMigrate(scenario, scenario.deploy?.transaction?.receiverId, failFor);
    const addHeight = recordedHeight(scenario.transactions?.add?.blockHeight);
    const vote2Height = recordedHeight(scenario.transactions?.vote2?.blockHeight);
    const failedLog = scenario.transactions?.failedProposal?.last_actions_log;
    const failureHeight = recordedHeight(failedLog?.[failedLog.length - 1]?.block_height);
    const upgradeHeight = recordedHeight(scenario.transactions?.upgrade?.deploy?.blockHeight);
    const migrateHeight = recordedHeight(scenario.transactions?.upgrade?.migrate?.blockHeight);
    const legacyHeight = recordedHeight(scenario.transactions?.upgrade?.legacyFinalize?.blockHeight);
    if (addHeight === null || upgradeHeight === null) failFor(false, 'recorded add/upgrade block heights are missing or malformed');
    else if (addHeight >= upgradeHeight) failFor(false, 'proposal was not added before the candidate upgrade');
    if (vote2Height === null || vote2Height >= upgradeHeight) failFor(false, 'second approval height is missing, malformed or not before the candidate upgrade');
    if (failureHeight === null || failureHeight >= upgradeHeight) failFor(false, 'recorded old-code failure height is missing, malformed or not before the candidate upgrade');
    if (legacyHeight === null || legacyHeight < upgradeHeight) failFor(false, 'legacy finalize height is missing, malformed or not after the candidate upgrade');
    if (migrateHeight === null || migrateHeight < upgradeHeight) failFor(false, 'migrate height is missing, malformed or not after the candidate upgrade');
  }

  const failed = scenario.failedRefund;
  if (!failed) failFor(false, 'failed-refund snapshot missing');
  else {
    if (text(failed.lockedAmount) !== BOND.toString()) failFor(false, 'failed refund did not retain the locked debt');
    if (failed.proposal?.status !== 'Failed') failFor(false, 'failed refund did not leave the proposal Failed');
  }

  const before = scenario.beforeRetry;
  const after = scenario.afterRetry;
  let retryDelta = null;
  if (!before || !after) failFor(false, 'retry snapshots missing');
  else {
    if (text(before.lockedAmount) !== BOND.toString()) failFor(false, 'retry did not start with the debt still locked');
    retryDelta = BigInt(after.proposer ?? 0) - BigInt(before.proposer ?? 0);
    if (retryDelta !== BOND) failFor(false, `retry proposer delta is ${retryDelta}, expected exactly one bond`);
    if (text(after.lockedAmount) !== '0') failFor(false, 'successful retry did not clear the debt');
  }

  if (text(scenario.afterDuplicate?.proposer) !== text(after?.proposer)) failFor(false, 'duplicate retry changed the proposer balance');
  if (text(scenario.afterDuplicate?.lockedAmount) !== '0') failFor(false, 'duplicate retry changed the locked debt');
  if (text(scenario.afterUnauthorized?.proposer) !== text(after?.proposer)) failFor(false, 'unauthorized callback changed the proposer balance');
  if (text(scenario.afterUnauthorized?.lockedAmount) !== '0') failFor(false, 'unauthorized callback changed the locked debt');

  const unauthorized = scenario.unauthorized;
  const unauthorizedReceipts = unauthorized?.value?.receipts || unauthorized?.receipts || [];
  if (!unauthorized || unauthorized.ok === true) failFor(false, 'unauthorized callback was accepted');
  else {
    const failures = unauthorizedReceipts.filter((receipt) => receipt?.status?.Failure);
    if (!failures.some((receipt) => JSON.stringify(receipt.status).includes('Method on_refund_callback is private'))) {
      failFor(false, 'unauthorized callback did not fail with the private-method denial');
    }
  }
  if (scenario.unauthorizedArgs?.attempt !== 999) failFor(false, 'unauthorized callback did not use the numeric attempt argument');

  verifyRetries(scenario, scenario.deploy?.transaction?.receiverId, failFor);
  const overlap = scenario.overlap;
  if (!overlap || overlap.ok !== true) failFor(false, 'overlapping retry evidence missing or failed');
  else {
    if (overlap.kind !== 'concurrent-submission') failFor(false, 'overlap evidence is not a concurrent submission');
    if (overlap.distinctHashes !== true) failFor(false, 'overlap attempts reused one transaction hash');
    if (overlap.distinctSigners !== true) failFor(false, 'overlap attempts were not independently signed');
    if (overlap.bothFinal !== true) failFor(false, 'both overlap attempts were not executed to FINAL');
    if (overlap.receiptBacked !== true) failFor(false, 'overlap attempts are not receipt-backed');
    const attempts = Array.isArray(overlap.attempts) ? overlap.attempts : [];
    if (attempts.length !== 2) failFor(false, 'overlap evidence must record exactly two attempts');
    attempts.forEach((attempt, index) => {
      if (!attempt?.transactionHash) failFor(false, `overlap attempt ${index + 1} has no transaction hash`);
      if (attempt?.finalExecutionStatus !== 'FINAL') failFor(false, `overlap attempt ${index + 1} did not reach FINAL`);
      if (!attempt?.signerId) failFor(false, `overlap attempt ${index + 1} has no signer identity`);
      if (!Array.isArray(attempt?.receiptIds) || attempt.receiptIds.length === 0) failFor(false, `overlap attempt ${index + 1} has no executed receipts`);
    });
    const hashes = attempts.map((attempt) => attempt?.transactionHash).filter(Boolean);
    if (new Set(hashes).size !== 2) failFor(false, 'overlap did not produce two distinct transactions');
    const signers = attempts.map((attempt) => attempt?.signerId).filter(Boolean);
    if (new Set(signers).size !== 2) failFor(false, 'overlap did not produce two distinct signers');
    if (overlap.delta !== BOND.toString()) failFor(false, 'overlapping retries did not pay exactly one bond');
    if (text(overlap.lockedAfter) !== '0') failFor(false, 'overlapping retries did not settle the debt');
  }

  return {
    failedRefundLocked: text(failed?.lockedAmount),
    retryDelta: before && after ? (BigInt(after.proposer ?? 0) - BigInt(before.proposer ?? 0)).toString() : null,
    duplicateDelta: text(scenario.afterDuplicate?.proposer) && text(after?.proposer) ? (BigInt(scenario.afterDuplicate.proposer) - BigInt(after.proposer)).toString() : null,
    unauthorizedDenied: Boolean(unauthorized && unauthorized.ok !== true),
    overlapDelta: overlap?.delta ?? null,
  };
}

function verifySettlementReport(report, opts = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const text = (value) => (value === null || value === undefined ? '' : String(value));
  if (report?.schema !== REQUIRED_SCHEMA) fail(`settlement report schema must be ${REQUIRED_SCHEMA}`);
  const candidateWasmSha256 = report?.candidate?.wasmSha256;
  if (!candidateWasmSha256 || !/^[0-9a-f]{64}$/.test(candidateWasmSha256)) fail('settlement candidate WASM hash missing');
  const baseWasmSha256 = opts.baseWasmSha256 || DEFAULT_BASE_WASM_SHA256;
  if (report?.baseWasmSha256 !== baseWasmSha256) fail('settlement base WASM identity is wrong');
  if (opts.candidateWasmSha256 && candidateWasmSha256 !== opts.candidateWasmSha256) fail('settlement report is for a different candidate WASM');
  if (report?.ok !== true || (Array.isArray(report?.errors) && report.errors.length)) {
    fail(`settlement execution was not clean: ${(report?.errors || []).join('; ') || 'ok is not true'}`);
  }

  const context = {fail, text, candidateWasmSha256, baseWasmSha256, report};
  const freshOutcomes = verifyScenario(report?.fresh, 'candidate-only', context);
  const inheritedOutcomes = verifyScenario(report?.inherited, 'legacy-upgrade', context);

  return {
    ok: errors.length === 0,
    errors,
    outcomes: inheritedOutcomes ? {
      ...inheritedOutcomes,
      fresh: freshOutcomes,
      inherited: inheritedOutcomes,
    } : (freshOutcomes ? {fresh: freshOutcomes, inherited: null} : null),
  };
}

module.exports = {verifySettlementReport, BOND, REQUIRED_SCHEMA, DEFAULT_BASE_WASM_SHA256};
