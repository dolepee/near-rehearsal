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
  let valid = true;
  if (deploy.wasmSha256 !== sha256) { valid = false; fail(`${label} deployment label does not match its DeployContract commitment`); }
  if (deploy.codeHash !== base58Encode(code)) { valid = false; fail(`${label} installed code hash does not match its DeployContract commitment`); }
  return valid ? sha256 : null;
}

const DEFAULT_BASE_WASM_SHA256 = '5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578';


function decodeCall(transaction, label, fail) {
  const call = (transaction?.transaction?.actions || [])[0]?.FunctionCall;
  if (!call) { fail(`${label} is not a FunctionCall`); return null; }
  let args;
  try { args = JSON.parse(Buffer.from(call.args || '', 'base64').toString('utf8')); }
  catch { fail(`${label} args are not valid JSON`); return null; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) { fail(`${label} args are not an object`); return null; }
  return {call, args};
}

function soleCall(summary, label, fail) {
  const actions = summary?.transaction?.actions;
  if (!Array.isArray(actions) || actions.length !== 1) { fail(`${label} must contain exactly one transaction action`); return null; }
  return decodeCall(summary, label, fail);
}

function verifyMigrate(scenario, dao, failFor) {
  let valid = true;
  const check = (condition, message) => { if (!condition) { valid = false; failFor(false, message); } };
  const migrate = scenario.transactions?.upgrade?.migrate;
  if (!migrate) { check(false, 'migrate transaction is missing'); return false; }
  check(migrate.finalExecutionStatus === 'FINAL', 'migrate was not FINAL');
  check(migrate.transaction?.signerId === dao && migrate.transaction?.receiverId === dao, 'migrate was not signed and received by the inherited DAO');
  const decoded = decodeCall(migrate, 'migrate', (message) => check(false, message));
  if (!decoded) return false;
  check(decoded.call.method_name === 'migrate', 'migrate FunctionCall method is wrong');
  check(Object.keys(decoded.args || {}).length === 0, 'migrate args are not empty');
  if (!successfulReceiptChain(migrate, 'migrate', (message) => check(false, message))) { valid = false; }
  return valid;
}

function verifyVote(scenario, signer, label, failFor) {
  let valid = true;
  const check = (condition, message) => { if (!condition) { valid = false; failFor(false, message); } };
  if (typeof signer !== 'string' || !signer) check(false, `${label} signer is missing`);
  const vote = scenario.transactions?.[label];
  if (!vote) { check(false, `${label} transaction is missing`); return false; }
  if (vote.finalExecutionStatus !== 'FINAL') check(false, `${label} was not FINAL`);
  if (vote.transaction?.signerId !== signer) check(false, `${label} signer does not match the recorded approval`);
  if (vote.transaction?.receiverId !== scenario.deploy?.transaction?.receiverId) check(false, `${label} receiver is not the DAO`);
  const decoded = decodeCall(vote, label, (message) => check(false, message));
  if (!decoded) return false;
  if (decoded.call.method_name !== 'act_proposal' || decoded.args?.action !== 'VoteApprove') check(false, `${label} is not a VoteApprove`);
  if (String(decoded.args?.id) !== String(scenario.proposalId)) check(false, `${label} targets a different proposal`);
  if (!successfulReceiptChain(vote, label, (message) => check(false, message))) return false;
  return valid;
}

function verifyAddProposal(scenario, dao, failFor) {
  let valid = true;
  const check = (condition, message) => { if (!condition) { valid = false; failFor(false, message); } };
  const add = scenario.transactions?.add;
  if (!add) { check(false, 'add_proposal transaction is missing'); return false; }
  if (add.finalExecutionStatus !== 'FINAL') check(false, 'add_proposal was not FINAL');
  if (add.transaction?.receiverId !== dao) check(false, 'add_proposal did not target the scenario DAO');
  const proposal = scenario.transactions?.failedProposal;
  if (!proposal) { check(false, 'recorded proposal is missing for add_proposal binding'); return false; }
  if (add.transaction?.signerId !== proposal.proposer) check(false, 'add_proposal signer is not the recorded proposer');
  const decoded = decodeCall(add, 'add_proposal', (message) => check(false, message));
  if (!decoded) return false;
  if (decoded.call.method_name !== 'add_proposal') check(false, 'add_proposal FunctionCall method is wrong');
  if (decoded.call.deposit !== BOND.toString()) check(false, 'add_proposal bond does not match the recorded bond');
  if (decoded.args?.proposal?.description !== proposal.description) check(false, 'add_proposal description does not match the recorded proposal');
  if (JSON.stringify(decoded.args?.proposal?.kind) !== JSON.stringify(proposal.kind)) check(false, 'add_proposal kind does not match the recorded proposal');
  if (!successfulReceiptChain(add, 'add_proposal', (message) => check(false, message))) check(false, 'add_proposal action did not execute successfully');
  const firstId = add.transactionOutcome?.status?.SuccessReceiptId;
  const first = (add.receipts || []).find((receipt) => receipt.id === firstId);
  let returnedId = null;
  try { returnedId = JSON.parse(Buffer.from(first?.status?.SuccessValue || '', 'base64').toString('utf8')); } catch {}
  if (String(returnedId) !== String(scenario.proposalId)) check(false, 'add_proposal returned a different proposal id');
  return valid;
}

function verifyUnauthorized(scenario, dao, failFor) {
  let valid = true;
  const verifyFailure = (condition, message) => { if (!condition) { valid = false; failFor(false, message); } };
  const unauthorized = scenario.unauthorized;
  const value = unauthorized?.value;
  if (!value) { verifyFailure(false, 'unauthorized callback transaction is missing'); return; }
  if (JSON.stringify(scenario.transactions?.unauthorized) !== JSON.stringify(unauthorized)) {
    verifyFailure(false, 'the two unauthorized callback representations are not the same full record');
  }
  if (unauthorized.ok !== false) verifyFailure(false, 'unauthorized callback was not recorded as rejected');
  if (value.finalExecutionStatus !== 'FINAL') verifyFailure(false, 'unauthorized callback was not FINAL');
  if (value.transaction?.receiverId !== dao) verifyFailure(false, 'unauthorized callback did not target the DAO');
  const signer = value.transaction?.signerId;
  if (typeof signer !== 'string' || signer.length === 0) verifyFailure(false, 'unauthorized callback signer is missing');
  else if (signer === dao) verifyFailure(false, 'unauthorized callback was sent by the DAO itself');
  const decoded = decodeCall(value, 'unauthorized callback', (message) => verifyFailure(false, message));
  if (!decoded) return;
  if (decoded.call.method_name !== 'on_refund_callback') verifyFailure(false, 'unauthorized callback method is wrong');
  if (typeof decoded.args?.proposal_id !== 'number' || !Number.isInteger(decoded.args.proposal_id) || String(decoded.args.proposal_id) !== String(scenario.proposalId)) {
    verifyFailure(false, 'unauthorized callback proposal_id is not the numeric scenario proposal');
  }
  if (decoded.args?.attempt !== 999) verifyFailure(false, 'unauthorized callback attempt is not numeric 999');
  const firstId = value.transactionOutcome?.status?.SuccessReceiptId;
  if (!Array.isArray(value.transactionOutcome?.receiptIds) || !value.transactionOutcome.receiptIds.includes(firstId)) {
    verifyFailure(false, 'unauthorized callback does not link its first receipt'); return;
  }
  const first = (value.receipts || []).find((receipt) => receipt.id === firstId);
  if (!first) { verifyFailure(false, 'unauthorized callback first receipt is missing'); return; }
  if (first.executorId !== dao) verifyFailure(false, 'unauthorized callback first receipt was not executed by the DAO');
  const failure = first.status?.Failure;
  if (!failure) verifyFailure(false, 'unauthorized callback first receipt is not a Failure');
  else if (!JSON.stringify(failure).includes('Method on_refund_callback is private')) {
    verifyFailure(false, 'unauthorized callback linked receipt was not rejected by the private-method guard');
  }
  const beforeHeight = recordedHeight(scenario.afterRetry?.blockHeight);
  const operationHeight = recordedHeight(value.blockHeight);
  const observedHeight = recordedHeight(scenario.afterUnauthorized?.blockHeight);
  const receiptHeight = recordedHeight(first.blockHeight);
  verifyFailure(typeof first.blockHash === 'string' && first.blockHash.length > 0 && receiptHeight !== null,
    'unauthorized callback linked execution receipt has no measured block');
  verifyFailure(beforeHeight !== null && operationHeight !== null && observedHeight !== null,
    'unauthorized callback execution or observation height is missing or malformed');
  if (beforeHeight !== null && operationHeight !== null) verifyFailure(beforeHeight < operationHeight,
    'unauthorized callback was not after the retry observation');
  if (operationHeight !== null && receiptHeight !== null) verifyFailure(operationHeight <= receiptHeight,
    'unauthorized callback receipt precedes its root transaction');
  if (receiptHeight !== null && observedHeight !== null) verifyFailure(receiptHeight < observedHeight,
    'unauthorized callback was not bounded by a later observation');
  return valid;
}

function verifyDuplicate(scenario, dao, failFor) {
  let valid = true;
  const verifyFailure = (condition, message) => { if (!condition) { valid = false; failFor(false, message); } };
  const duplicate = scenario.transactions?.duplicate;
  if (!duplicate) { verifyFailure(false, 'duplicate retry transaction is missing'); return; }
  if (duplicate.finalExecutionStatus !== 'FINAL') verifyFailure(false, 'duplicate retry was not FINAL');
  if (duplicate.transaction?.receiverId !== dao) verifyFailure(false, 'duplicate retry did not target the DAO');
  const voteSigners = [scenario.transactions?.vote?.transaction?.signerId, scenario.transactions?.vote2?.transaction?.signerId].filter(Boolean);
  if (!voteSigners.includes(duplicate.transaction?.signerId)) verifyFailure(false, 'duplicate retry was not signed by an approving voter');
  const decoded = decodeCall(duplicate, 'duplicate retry', (message) => verifyFailure(false, message));
  if (!decoded) return;
  if (decoded.call.method_name !== 'act_proposal' || decoded.args?.action !== 'Finalize') verifyFailure(false, 'duplicate retry is not an act_proposal Finalize');
  if (String(decoded.args?.id) !== String(scenario.proposalId)) verifyFailure(false, 'duplicate retry targets a different proposal');
  const retryHashes = (Array.isArray(scenario.transactions?.retries) ? scenario.transactions.retries : []).map((tx) => tx?.transactionHash).filter(Boolean);
  const legacyHash = scenario.transactions?.upgrade?.legacyFinalize?.transactionHash;
  if (duplicate.transactionHash && retryHashes.includes(duplicate.transactionHash)) verifyFailure(false, 'duplicate retry reuses an overlap transaction');
  if (duplicate.transactionHash && legacyHash && duplicate.transactionHash === legacyHash) verifyFailure(false, 'duplicate retry reuses the legacy finalize transaction');
  const afterHeight = recordedHeight(scenario.afterRetry?.blockHeight);
  const duplicateHeight = recordedHeight(duplicate.blockHeight);
  const afterDuplicateHeight = recordedHeight(scenario.afterDuplicate?.blockHeight);
  if (afterHeight === null || duplicateHeight === null) verifyFailure(false, 'duplicate retry height is missing or malformed');
  else if (duplicateHeight <= afterHeight) verifyFailure(false, 'duplicate retry was not after the settled afterRetry observation');
  if (afterDuplicateHeight === null) verifyFailure(false, 'post-duplicate observation height is missing or malformed');
  else if (duplicateHeight !== null && afterDuplicateHeight <= duplicateHeight) {
    verifyFailure(false, 'duplicate retry was not bounded by a later post-duplicate observation');
  }
  const outcome = receiptChain(duplicate, 'duplicate retry', (message) => verifyFailure(false, message), true);
  if (!outcome.ok && !outcome.expected) valid = false;
  return valid;
}

function verifyLegacyFinalize(scenario, dao, failFor) {
  let valid = true;
  const check = (condition, message) => { if (!condition) { valid = false; failFor(false, message); } };
  const recorded = scenario.legacy?.legacyFinalize;
  const transaction = scenario.transactions?.upgrade?.legacyFinalize;
  if (!recorded || !transaction) { check(false, 'legacy finalize representations are missing'); return false; }
  check(JSON.stringify(recorded) === JSON.stringify(transaction), 'legacy finalize representations are not the same full transaction');
  check(transaction.finalExecutionStatus === 'FINAL', 'legacy finalize was not FINAL');
  check(transaction.transaction?.receiverId === dao, 'legacy finalize did not target the inherited DAO');
  const voteSigners = [scenario.transactions?.vote?.transaction?.signerId, scenario.transactions?.vote2?.transaction?.signerId].filter(Boolean);
  check(voteSigners.includes(transaction.transaction?.signerId), 'legacy finalize was not signed by an approving voter');
  const decoded = decodeCall(transaction, 'legacy finalize', (message) => check(false, message));
  if (!decoded) return false;
  check(decoded.call.method_name === 'act_proposal' && decoded.args?.action === 'Finalize', 'legacy finalize is not an act_proposal Finalize');
  check(String(decoded.args?.id) === String(scenario.proposalId), 'legacy finalize targets a different proposal');
  if (!successfulReceiptChain(transaction, 'legacy finalize', (message) => check(false, message))) { valid = false; }
  return valid;
}

function verifyRetries(scenario, dao, failFor) {
  const coverageErrors = [];
  let executionValid = true;
  const invalid = (condition, message) => { if (!condition) executionValid = false; failFor(condition, message); };
  const raw = scenario.transactions?.retries;
  const attempts = scenario.overlap?.attempts;
  if (!Array.isArray(raw) || raw.length !== 2) {
    coverageErrors.push('two full retry transaction summaries are required');
    invalid(false, coverageErrors[coverageErrors.length - 1]);
    return {guardUnproven: true, coverageErrors, executionValid: false};
  }
  if (!Array.isArray(attempts) || attempts.length !== 2) {
    coverageErrors.push('two retry attempts are required');
    invalid(false, coverageErrors[coverageErrors.length - 1]);
    return {guardUnproven: true, coverageErrors, executionValid: false};
  }
  const voteSigners = [scenario.transactions?.vote?.transaction?.signerId, scenario.transactions?.vote2?.transaction?.signerId].filter(Boolean);
  if (voteSigners.length !== 2) invalid(false, 'two recorded voter approvals are required');
  if (!verifyVote(scenario, voteSigners[0], 'vote', invalid) || !verifyVote(scenario, voteSigners[1], 'vote2', invalid)) return;
  const hashes = [];
  const signers = [];
  let successful = 0;
  let expectedInFlight = 0;
  raw.forEach((tx, index) => {
    const label = `retry ${index + 1}`;
    if (!tx || typeof tx !== 'object') { invalid(false, `${label} execution record is missing or malformed`); return; }
    if (tx.finalExecutionStatus !== 'FINAL') invalid(false, `${label} was not FINAL`);
    if (tx.transaction?.receiverId !== dao) { executionValid = false; invalid(false, `${label} receiver is not the DAO`); }
    if (!voteSigners.includes(tx.transaction?.signerId)) { executionValid = false; invalid(false, `${label} signer was not an approving voter`); }
    const decoded = decodeCall(tx, label, (message) => invalid(false, message));
    if (!decoded) { executionValid = false; return; }
    if (decoded.call.method_name !== 'act_proposal') { executionValid = false; invalid(false, `${label} method is not act_proposal`); }
    if (decoded.args?.action !== 'Finalize') { executionValid = false; invalid(false, `${label} is not Finalize`); }
    if (String(decoded.args?.id) !== String(scenario.proposalId)) { executionValid = false; invalid(false, `${label} targets a different proposal`); }
    const receiptIds = (Array.isArray(tx.receipts) ? tx.receipts : []).map((receipt) => receipt?.id).filter(Boolean);
    if (!receiptIds.length) { executionValid = false; invalid(false, `${label} has no executed receipts`); }
    const attempt = attempts[index];
    if (attempt?.transactionHash !== tx.transactionHash) invalid(false, `${label} summary hash does not match its attempt`);
    if (attempt?.signerId !== tx.transaction?.signerId) invalid(false, `${label} summary signer does not match its attempt`);
    if (JSON.stringify(attempt?.receiptIds || []) !== JSON.stringify(receiptIds)) invalid(false, `${label} summary receipts do not match its attempt`);
    const outcome = receiptChain(tx, label, (message) => invalid(false, message), true);
    if (!outcome.ok && !outcome.expected) executionValid = false;
    if (outcome.ok) successful += 1;
    if (outcome.expected) expectedInFlight += 1;
    hashes.push(tx.transactionHash); signers.push(tx.transaction?.signerId);
  });
  if (new Set(hashes).size !== 2) invalid(false, 'retry transactions do not have distinct hashes');
  if (new Set(signers).size !== 2) invalid(false, 'retry transactions do not have distinct signers');
  const beforeHeight = recordedHeight(scenario.beforeRetry?.blockHeight);
  const afterHeight = recordedHeight(scenario.afterRetry?.blockHeight);
  if (beforeHeight === null || afterHeight === null) {
    coverageErrors.push('raw retry evidence is not bounded by valid before/after snapshots');
    invalid(false, coverageErrors[coverageErrors.length - 1]);
  }
  else {
    raw.forEach((tx, index) => {
      const height = recordedHeight(tx?.blockHeight);
      if (height === null) {
        coverageErrors.push(`retry ${index + 1} height is missing or malformed`);
        invalid(false, coverageErrors[coverageErrors.length - 1]);
      }
      else if (height < beforeHeight || height > afterHeight) invalid(false, `retry ${index + 1} is outside the measured recovery window`);
    });
  }
  if (successful !== 1) { coverageErrors.push(`expected exactly one successful retry action, got ${successful}`); failFor(false, coverageErrors[coverageErrors.length - 1]); }
  if (expectedInFlight !== 1) { coverageErrors.push(`expected exactly one receipt-backed ERR_PROPOSAL_NOT_IN_PROGRESS rejection, got ${expectedInFlight}`); failFor(false, coverageErrors[coverageErrors.length - 1]); }
  return {guardUnproven: successful === 2 && expectedInFlight === 0, coverageErrors, executionValid};
}


function recordedHeight(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  return null;
}


function reachableFailure(summary, expectedExecutor, needle, label, fail) {
  const start = summary?.transactionOutcome?.status?.SuccessReceiptId;
  const roots = summary?.transactionOutcome?.receiptIds || (start ? [start] : []);
  if (!start || !Array.isArray(roots) || !roots.includes(start)) { fail(false, `${label} has no linked first receipt`); return false; }
  const byId = new Map();
  for (const receipt of summary?.receipts || []) {
    if (!receipt?.id || byId.has(receipt.id)) { fail(false, `${label} has a duplicate or missing receipt`); return false; }
    byId.set(receipt.id, receipt);
  }
  const seen = new Set();
  const queue = [...roots];
  let found = false;
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const receipt = byId.get(id);
    if (!receipt) { fail(false, `${label} roots a missing receipt`); return false; }
    if (receipt.status?.Failure) {
      if (receipt.executorId !== expectedExecutor) { fail(false, `${label} failure receipt has the wrong executor`); return false; }
      if (!JSON.stringify(receipt.status).includes(needle)) { fail(false, `${label} reachable failure lacks the expected error`); return false; }
      found = true;
    }
    for (const child of receipt.receiptIds || []) queue.push(child);
  }
  for (const id of byId.keys()) if (!seen.has(id)) { fail(false, `${label} has an unlinked receipt`); return false; }
  if (!found) { fail(false, `${label} has no reachable failed receipt`); return false; }
  return true;
}

function verifyLegacySeed(scenario, dao, fail) {
  const seed = scenario.transactions?.seed;
  const legacy = scenario.legacy;
  if (!seed) { fail(false, 'legacy principal seed transaction is missing'); return false; }
  let valid = true;
  const check = (condition, message) => { if (!condition) { valid = false; fail(false, message); } };
  check(seed.finalExecutionStatus === 'FINAL', 'legacy principal seed was not FINAL');
  check(seed.transaction?.receiverId === dao && seed.transaction?.signerId === dao, 'legacy principal seed was not a DAO-private call');
  check(successfulReceiptChain(seed, 'legacy principal seed', (message) => check(false, message)), 'legacy principal seed lacks a linked successful receipt chain');
  const decoded = decodeCall(seed, 'legacy principal seed', (message) => { valid = false; fail(false, message); });
  check(decoded.call.method_name === 'seed_legacy_proposal_bond', 'legacy principal seed has the wrong method');
  check(String(decoded.args?.proposal_id) === String(scenario.proposalId), 'legacy principal seed targets a different proposal');
  check(decoded.args?.proposer === scenario.transactions?.add?.transaction?.signerId, 'legacy principal seed proposer does not match the funding proposal');
  const addCall = (scenario.transactions?.add?.transaction?.actions || []).find((action) => action?.FunctionCall?.method_name === 'add_proposal')?.FunctionCall;
  const deposit = addCall?.deposit;
  check(deposit && String(decoded.args?.amount) === String(deposit), 'legacy principal seed amount is not the measured add_proposal deposit');
  check(decoded.args?.funding_tx_hash === scenario.transactions?.add?.transactionHash, 'legacy principal seed funding hash is not the add_proposal transaction');
  check(legacy?.seedArgs && JSON.stringify(legacy.seedArgs) === JSON.stringify(decoded.args), 'declared legacy seed input does not match the executed seed');
  check(String(legacy?.afterMissingSeed?.lockedAmount) === String(deposit), 'unseeded legacy finalize did not preserve the original debt');
  check(legacy?.afterMissingSeed?.proposer === null || BigInt(legacy.afterMissingSeed.proposer) === 0n, 'unseeded legacy finalize paid the proposer');
  for (const [label, probe, needle, expectedSigner] of [
    ['unauthorized seed', legacy?.unauthorizedSeed, 'Method seed_legacy_proposal_bond is private', 'non-dao'],
    ['duplicate seed', legacy?.duplicateSeed, 'ERR_LEGACY_BOND_ALREADY_RECORDED', 'dao'],
  ]) {
    check(probe?.executed === true && probe?.rejected === true, `${label} did not produce the expected FINAL rejection`);
    check(probe?.value?.finalExecutionStatus === 'FINAL', `${label} was not FINAL`);
    check(probe?.value?.transaction?.receiverId === dao && probe?.value?.transaction?.signerId === probe?.signer, `${label} has the wrong signer or receiver`);
    if (label === 'unauthorized seed') {
      check(probe?.signer !== dao && probe?.value?.transaction?.signerId !== dao, 'unauthorized seed must not be signed by the DAO');
    } else {
      check(probe?.signer === dao && probe?.value?.transaction?.signerId === dao, 'duplicate seed must be signed by the DAO');
    }
    const probeDecoded = soleCall(probe?.value, label, (message) => check(false, message));
    check(probeDecoded?.call?.method_name === 'seed_legacy_proposal_bond', `${label} called the wrong method`);
    if (probeDecoded) {
      check(String(probeDecoded.args?.proposal_id) === String(scenario.proposalId), `${label} targets a different proposal`);
      check(probeDecoded.args?.proposer === scenario.transactions?.add?.transaction?.signerId, `${label} proposer does not match the funding proposal`);
      check(probeDecoded.args?.funding_tx_hash === scenario.transactions?.add?.transactionHash, `${label} funding hash is not the add_proposal transaction`);
    }
    check(reachableFailure(probe?.value, dao, needle, label, check), `${label} lacks a reachable failed receipt`);
  }
  check(String(legacy?.beforeSeedProbe?.lockedAmount) === String(deposit) && String(legacy?.afterSeedProbe?.lockedAmount) === String(deposit), 'seed probes changed the locked debt');
  check(legacy?.beforeSeedProbe?.proposer === legacy?.afterSeedProbe?.proposer, 'seed probes changed the proposer principal');
  return valid;
}

function verifyScenario(scenario, mode, context) {
  const {fail, text, candidateWasmSha256, baseWasmSha256, report} = context;
  if (!scenario) { fail(`${mode} settlement scenario is missing`); return null; }
  const failFor = (condition, message, kind = 'incomplete') => { if (!condition) fail(`${mode}: ${message}`, kind); };
  const failFinancial = (condition, prerequisite, message) => { if (condition) return; fail(`${mode}: ${message}`, prerequisite ? 'verified' : 'incomplete'); };
  const {parseAmount} = context;

  // Installation/creation facts precede retries. A missing later operation must
  // never erase an already complete counterexample from the failed refund.
  let candidateExecutionValid = true;
  let legacyFinalizeValid = false;
  const installCheck = (condition, message) => {
    if (!condition) candidateExecutionValid = false;
    failFor(condition, message);
  };
  if (mode === 'candidate-only') {
    if (scenario.legacy) installCheck(false, 'fresh candidate scenario must not claim legacy upgrade evidence');
    const committed = deploymentCommitment(scenario.deploy, 'fresh candidate', (message) => installCheck(false, message));
    if (committed !== candidateWasmSha256) installCheck(false, 'fresh candidate deployment does not commit to the candidate WASM');
    if (scenario.deploy?.wasmSha256 !== candidateWasmSha256) installCheck(false, 'fresh candidate scenario did not deploy the candidate WASM');
    const upgrade = report?.inherited?.transactions?.upgrade;
    if (upgrade && scenario.deploy?.codeHash && upgrade.codeHash && scenario.deploy.codeHash !== upgrade.codeHash) {
      failFor(false, 'fresh deployment installed different code from the inherited upgrade');
    }
  } else {
    const legacy = scenario.legacy;
    if (!legacy) installCheck(false, 'legacy upgrade proof is missing');
    else {
      if (legacy.baseWasmSha256 !== baseWasmSha256) installCheck(false, 'legacy base WASM identity is wrong');
      if (legacy.candidateWasmSha256 !== candidateWasmSha256) installCheck(false, 'legacy candidate identity is wrong');
      if (legacy.upgradeCodeHash !== scenario.transactions?.upgrade?.codeHash || !legacy.upgradeCodeHash) installCheck(false, 'legacy upgrade did not install the candidate');
      if (legacy.proposalCreatedBeforeUpgrade !== true) installCheck(false, 'legacy proposal was not created before upgrade');
      if (legacy.legacyFinalize?.finalExecutionStatus !== 'FINAL') failFor(false, 'legacy finalize evidence is missing');
    }
    const upgrade = scenario.transactions?.upgrade;
    if (!upgrade || upgrade.candidateWasmSha256 !== candidateWasmSha256 || !upgrade.deploy || !upgrade.migrate) {
      installCheck(false, 'legacy upgrade transaction evidence is missing');
    } else {
      const upgradedCode = deploymentCommitment(upgrade.deploy, 'inherited upgrade', (message) => installCheck(false, message), scenario.deploy?.transaction?.receiverId);
      if (upgradedCode !== candidateWasmSha256) installCheck(false, 'inherited upgrade does not commit to the candidate WASM');
      if (upgrade.codeHash !== base58Encode(Buffer.from(candidateWasmSha256, 'hex'))) installCheck(false, 'inherited installed code hash is not the candidate');
      if (upgrade.migrate?.finalExecutionStatus !== 'FINAL') installCheck(false, 'inherited migrate was not successful');
      if (upgrade.migrate && !successfulReceiptChain(upgrade.migrate, 'inherited migrate', (message) => installCheck(false, message))) {
        installCheck(false, 'inherited migrate child receipt failed');
      }
    }
    const baseCommitted = deploymentCommitment(scenario.deploy, 'inherited base', (message) => installCheck(false, message), scenario.deploy?.transaction?.receiverId);
    if (baseCommitted !== baseWasmSha256) installCheck(false, 'inherited scenario does not commit to the pinned base WASM');
    if (scenario.deploy?.wasmSha256 !== baseWasmSha256) installCheck(false, 'inherited scenario did not deploy the pinned base WASM');
    if (!verifyMigrate(scenario, scenario.deploy?.transaction?.receiverId, installCheck)) candidateExecutionValid = false;
    legacyFinalizeValid = verifyLegacyFinalize(scenario, scenario.deploy?.transaction?.receiverId, failFor);
    if (!verifyLegacySeed(scenario, scenario.deploy?.transaction?.receiverId, failFor)) candidateExecutionValid = false;
    const addHeight = recordedHeight(scenario.transactions?.add?.blockHeight);
    const vote2Height = recordedHeight(scenario.transactions?.vote2?.blockHeight);
    const failedLog = scenario.transactions?.failedProposal?.last_actions_log;
    const failureHeight = recordedHeight(failedLog?.[failedLog.length - 1]?.block_height);
    const upgradeHeight = recordedHeight(scenario.transactions?.upgrade?.deploy?.blockHeight);
    const migrateHeight = recordedHeight(scenario.transactions?.upgrade?.migrate?.blockHeight);
    const legacyHeight = recordedHeight(scenario.transactions?.upgrade?.legacyFinalize?.blockHeight);
    if (addHeight === null || upgradeHeight === null) installCheck(false, 'recorded add/upgrade block heights are missing or malformed');
    else if (addHeight >= upgradeHeight) installCheck(false, 'proposal was not added before the candidate upgrade');
    if (vote2Height === null) installCheck(false, 'second approval height is missing or malformed');
    else if (addHeight !== null && addHeight > vote2Height) installCheck(false, 'proposal was added after the second approval');
    if (failureHeight === null) installCheck(false, 'recorded old-code failure height is missing or malformed');
    else if (vote2Height !== null && vote2Height > failureHeight) installCheck(false, 'old-code failure was recorded before the second approval');
    if (failureHeight !== null && upgradeHeight !== null && failureHeight >= upgradeHeight) installCheck(false, 'recorded old-code failure was not before the candidate upgrade');
    if (migrateHeight === null) installCheck(false, 'migrate height is missing or malformed');
    else if (upgradeHeight !== null && upgradeHeight > migrateHeight) installCheck(false, 'migrate was not after the candidate upgrade');
    if (legacyHeight === null) { legacyFinalizeValid = false; failFor(false, 'legacy finalize height is missing or malformed'); }
    else if (migrateHeight !== null && migrateHeight > legacyHeight) { legacyFinalizeValid = false; failFor(false, 'legacy finalize was before migrate'); }
    else if (upgradeHeight !== null && legacyHeight < upgradeHeight) { legacyFinalizeValid = false; failFor(false, 'legacy finalize was not after the candidate upgrade'); }
  }

  const operationDao = scenario.deploy?.transaction?.receiverId;
  let proposalEvidenceValid = verifyAddProposal(scenario, operationDao, failFor);
  const approval1Valid = verifyVote(scenario, scenario.transactions?.vote?.transaction?.signerId, 'vote', failFor);
  const approval2Valid = verifyVote(scenario, scenario.transactions?.vote2?.transaction?.signerId, 'vote2', failFor);
  proposalEvidenceValid = proposalEvidenceValid && approval1Valid && approval2Valid;
  const proposalCheck = (condition, message) => {
    if (!condition) proposalEvidenceValid = false;
    failFor(condition, message);
  };
  const unauthorizedExecutionValid = verifyUnauthorized(scenario, operationDao, failFor);
  const duplicateExecutionValid = verifyDuplicate(scenario, operationDao, failFor);
  const retryProof = verifyRetries(scenario, operationDao, failFor);
  const recordedProposal = scenario.transactions?.failedProposal;
  if (!recordedProposal) proposalCheck(false, 'recorded old-code proposal is missing');
  else {
    if (String(recordedProposal.id) !== String(scenario.proposalId)) proposalCheck(false, 'recorded old-code proposal is not the scenario proposal');
    if (recordedProposal.status !== 'Failed') proposalCheck(false, 'recorded old-code proposal is not Failed');
  }
  const freshMode = mode === 'candidate-only';
  const failedFinalizeValid = freshMode ? approval2Valid : legacyFinalizeValid;
  const failed = scenario.failedRefund;
  if (!failed) failFor(false, 'failed-refund snapshot missing');
  else if (!text(failed.lockedAmount)) failFor(false, 'failed refund locked amount is missing');
  if (failed?.proposal) {
    if (String(failed.proposal.id) !== String(scenario.proposalId)) proposalCheck(false, 'post-upgrade proposal identity changed');
    if (failed.proposal.status !== 'Failed') proposalCheck(false, 'post-upgrade proposal is not Failed');
    if (JSON.stringify(recordedProposal?.kind) !== JSON.stringify(failed.proposal.kind)) proposalCheck(false, 'proposal kind changed across the upgrade');
    if (recordedProposal?.description !== failed.proposal.description) proposalCheck(false, 'proposal description changed across the upgrade');
    if (recordedProposal?.proposer !== failed.proposal.proposer) proposalCheck(false, 'proposal beneficiary changed across the upgrade');
  } else proposalCheck(false, 'post-upgrade proposal identity is missing');
  const failedDebtPrereq = candidateExecutionValid && proposalEvidenceValid && failedFinalizeValid;
  if (!failed) failFor(false, 'failed-refund snapshot missing');
  else {
    const failedLocked = failed ? parseAmount(failed.lockedAmount) : null;
    if (text(failed?.lockedAmount) && failedLocked === null) failFor(false, 'failed refund locked amount is malformed');
    else if (failedLocked !== null && failedLocked !== BOND) failFinancial(false, failedDebtPrereq, 'failed refund did not retain the locked debt');
    if (failed.proposal?.status !== 'Failed') failFor(false, 'failed refund did not leave the proposal Failed');
  }

  const before = scenario.beforeRetry;
  const after = scenario.afterRetry;
  let retryDelta = null;
  const beforeAmount = before ? parseAmount(before.proposer) : null;
  const afterAmount = after ? parseAmount(after.proposer) : null;
  const beforeLocked = before ? parseAmount(before.lockedAmount) : null;
  const afterLocked = after ? parseAmount(after.lockedAmount) : null;
  const retryExecutionValid = candidateExecutionValid && proposalEvidenceValid && retryProof?.executionValid === true;
  // Exact payout requires a measured starting obligation. A later missing
  // locked-state observation cannot erase an already observed wrong payout.
  const retryBalanceValid = retryExecutionValid && beforeLocked === BOND && beforeAmount !== null && afterAmount !== null;
  if (!before || !after) failFor(false, 'retry snapshots missing');
  if (beforeAmount === null || afterAmount === null) failFor(false, 'retry proposer amounts missing or malformed');
  else {
    retryDelta = afterAmount - beforeAmount;
    if (retryDelta !== BOND) failFinancial(false, retryBalanceValid, `retry proposer delta is ${retryDelta}, expected exactly one bond`);
  }
  // Debt and balance observations are independent assertions. A missing balance
  // cannot erase a complete debt counterexample, or the converse.
  if (beforeLocked === null) failFor(false, 'retry locked amount is missing or malformed');
  else if (beforeLocked !== BOND) failFinancial(false, retryExecutionValid, 'retry did not start with the debt still locked');
  if (afterLocked === null) failFor(false, 'retry resulting locked amount is missing or malformed');
  else if (afterLocked !== 0n) failFinancial(false, retryExecutionValid, 'successful retry did not clear the debt');

  for (const [name, snapshot, operationValid] of [
    ['duplicate retry', scenario.afterDuplicate, duplicateExecutionValid],
    ['unauthorized callback', scenario.afterUnauthorized, unauthorizedExecutionValid],
  ]) {
    const amount = parseAmount(snapshot?.proposer);
    const locked = parseAmount(snapshot?.lockedAmount);
    const operationEstablished = retryExecutionValid && operationValid === true;
    if (amount === null || afterAmount === null) failFor(false, `${name} observation balance is missing or malformed`);
    else if (amount !== afterAmount) failFinancial(false, operationEstablished, `${name} changed the proposer balance`);
    if (locked === null || afterLocked === null) failFor(false, `${name} observation debt is missing or malformed`);
    else if (locked !== afterLocked) failFinancial(false, operationEstablished, `${name} changed the locked debt`);
  }

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
    const overlapDelta = parseAmount(overlap.delta);
    if (overlapDelta === null) failFor(false, 'overlap delta is missing or malformed');
    else if (overlapDelta !== retryDelta) failFor(false, 'overlap delta does not match the observed retry balances');
    const overlapLocked = parseAmount(overlap.lockedAfter);
    if (overlapLocked === null) failFor(false, 'overlap resulting locked amount is missing or malformed');
    else if (afterLocked === null || overlapLocked !== afterLocked) failFor(false, 'overlap locked amount does not match the post-retry observation');
  }

  return {
    retryGuardUnproven: retryProof?.guardUnproven === true,
    coverageErrors: Array.isArray(retryProof?.coverageErrors) ? retryProof.coverageErrors : [],
    failedRefundLocked: text(failed?.lockedAmount),
    retryDelta: beforeAmount !== null && afterAmount !== null ? (afterAmount - beforeAmount).toString() : null,
    duplicateDelta: (() => {
      const duplicateAmount = scenario.afterDuplicate ? parseAmount(scenario.afterDuplicate.proposer) : null;
      return duplicateAmount !== null && afterAmount !== null ? (duplicateAmount - afterAmount).toString() : null;
    })(),
    unauthorizedDenied: Boolean(unauthorized && unauthorized.ok !== true),
    overlapDelta: overlap?.delta ?? null,
  };
}

function verifyUnequalOutcomes(unequal, fail) {
  if (!unequal || unequal.ok !== true) { fail('unequal legacy-principal case is missing or not clean'); return; }
  const amount = (value) => (/^[0-9]+$/.test(String(value ?? '')) ? BigInt(String(value)) : null);
  const before = unequal.before;
  const after = unequal.after;
  const bobBefore = unequal.bobBefore;
  const bobAfter = unequal.bobAfter;
  if (!before || !after || !bobBefore || !bobAfter) { fail('unequal legacy-principal snapshots are incomplete'); return; }
  const delta = amount(after.proposer) !== null && amount(before.proposer) !== null ? amount(after.proposer) - amount(before.proposer) : null;
  if (delta === null || delta !== 10n ** 24n) fail('unequal Alice refund is not exactly one original bond');
  if (String(unequal.aliceDelta) !== (delta === null ? '' : delta.toString())) fail('unequal reported Alice delta does not match the raw snapshots');
  if (String(unequal.bobLocked) !== String(bobAfter.lockedAmount)) fail('unequal reported Bob debt does not match the raw snapshot');
  if (amount(bobBefore.proposer) !== amount(bobAfter.proposer)) fail('unequal Bob principal changed');
  if (JSON.stringify(bobBefore.proposal) !== JSON.stringify(bobAfter.proposal)) fail('unequal Bob proposal changed');
  if (amount(bobAfter.lockedAmount) !== 2n * 10n ** 24n) fail('unequal Bob debt is not preserved at two bonds');
  if (amount(unequal.policyBefore?.proposal_bond) !== 10n ** 24n || amount(unequal.policyAfter?.proposal_bond) !== 2n * 10n ** 24n) fail('unequal policy change is not the measured one-to-two transition');
  const addAlice = unequal.transactions?.addAlice;
  const addBob = unequal.transactions?.addBob;
  const aliceDeposit = (addAlice?.transaction?.actions || []).find((action) => action?.FunctionCall?.method_name === 'add_proposal')?.FunctionCall?.deposit;
  const bobDeposit = (addBob?.transaction?.actions || []).find((action) => action?.FunctionCall?.method_name === 'add_proposal')?.FunctionCall?.deposit;
  if (String(aliceDeposit) !== String(10n ** 24n) || String(bobDeposit) !== String(2n * 10n ** 24n)) fail('unequal funding deposits are not one and two bonds');
  const unequalDao = addAlice?.transaction?.receiverId;
  for (const [name, tx, expected] of [['Alice', addAlice, '1000000000000000000000000'], ['Bob', addBob, '2000000000000000000000000']]) {
    if (tx?.finalExecutionStatus !== 'FINAL' || !tx?.transactionHash) fail(`unequal ${name} funding is not FINAL and identified`);
    if (!successfulReceiptChain(tx, `unequal ${name} funding`, (message) => fail(message))) fail(`unequal ${name} funding lacks a linked successful receipt chain`);
    const seed = unequal.transactions?.[name === 'Alice' ? 'seedAlice' : 'seedBob'];
    if (seed?.finalExecutionStatus !== 'FINAL') fail(`unequal ${name} seed is not FINAL`);
    if (!successfulReceiptChain(seed, `unequal ${name} seed`, (message) => fail(message))) fail(`unequal ${name} seed lacks a linked successful receipt chain`);
    if (seed?.transaction?.signerId !== unequalDao || seed?.transaction?.receiverId !== unequalDao) fail(`unequal ${name} seed is not a DAO-private call`);
    const decoded = soleCall(seed, `unequal ${name} seed`, (message) => fail(message));
    if (decoded?.call?.method_name !== 'seed_legacy_proposal_bond') fail(`unequal ${name} seed called the wrong method`);
    if (decoded) {
      if (String(decoded.args?.proposal_id) !== String(unequal.ids?.[name.toLowerCase()])) fail(`unequal ${name} seed targets the wrong proposal`);
      if (decoded.args?.proposer !== tx?.transaction?.signerId) fail(`unequal ${name} seed proposer does not match its funding transaction`);
      if (String(decoded.args?.amount) !== expected) fail(`unequal ${name} seed amount is not its measured funding deposit`);
      if (decoded.args?.funding_tx_hash !== tx.transactionHash) fail(`unequal ${name} seed does not bind its measured funding`);
    }
  }
}

function verifySettlementReport(report, opts = {}) {
  const errors = [];
  const incompleteReasons = [];
  const verifiedReasons = [];
  const fail = (message, kind = 'incomplete') => {
    errors.push(message);
    if (kind === 'verified') verifiedReasons.push(message);
    else incompleteReasons.push(message);
  };
  const text = (value) => (value === null || value === undefined ? '' : String(value));
  const parseAmount = (value) => {
    if (typeof value === 'bigint') return value >= 0n ? value : null;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
    return null;
  };
  if (report?.schema !== REQUIRED_SCHEMA) fail(`settlement report schema must be ${REQUIRED_SCHEMA}`);
  const candidateWasmSha256 = report?.candidate?.wasmSha256;
  const candidateIdentityValid = Boolean(candidateWasmSha256 && /^[0-9a-f]{64}$/.test(candidateWasmSha256));
  if (!candidateIdentityValid) fail('settlement candidate WASM hash missing');
  const baseWasmSha256 = opts.baseWasmSha256 || DEFAULT_BASE_WASM_SHA256;
  const baseIdentityValid = report?.baseWasmSha256 === baseWasmSha256;
  if (!baseIdentityValid) fail('settlement base WASM identity is wrong');
  const requestedCandidateValid = !opts.candidateWasmSha256 || candidateWasmSha256 === opts.candidateWasmSha256;
  if (!requestedCandidateValid) fail('settlement report is for a different candidate WASM');
  const identityEstablished = report?.schema === REQUIRED_SCHEMA && candidateIdentityValid && baseIdentityValid && requestedCandidateValid;
  if (report?.ok !== true || (Array.isArray(report?.errors) && report.errors.length)) {
    fail(`settlement execution was not clean: ${(Array.isArray(report?.errors) ? report.errors.join('; ') : report?.errors) || 'ok is not true'}`, 'incomplete');
  }

  const context = {fail, text, parseAmount, candidateWasmSha256, baseWasmSha256, report};
  const inspect = (scenario, mode) => {
    try { return verifyScenario(scenario, mode, context); }
    catch (error) {
      // A malformed scenario cannot discard another scenario's already verified
      // counterexample. Preserve accumulated reasons and continue independently.
      fail(`${mode}: malformed evidence prevented remaining checks: ${error.message}`);
      return null;
    }
  };
  const freshOutcomes = inspect(report?.fresh, 'candidate-only');
  const inheritedOutcomes = inspect(report?.inherited, 'legacy-upgrade');
  verifyUnequalOutcomes(report?.unequal, fail);

  const attributableVerified = identityEstablished ? verifiedReasons : [];
  const attributableIncomplete = identityEstablished ? incompleteReasons : [...incompleteReasons, ...verifiedReasons];
  const status = attributableVerified.length ? 'REJECTED' : (attributableIncomplete.length ? 'INCONCLUSIVE' : 'ACCEPTED');
  return {
    status,
    verifiedFailure: attributableVerified.length > 0,
    incomplete: status === 'INCONCLUSIVE',
    reasons: {verified: attributableVerified, incomplete: attributableIncomplete},
    ok: status === 'ACCEPTED',
    errors,
    unproven: status === 'INCONCLUSIVE',
    outcomes: inheritedOutcomes ? {
      ...inheritedOutcomes,
      fresh: freshOutcomes,
      inherited: inheritedOutcomes,
    } : (freshOutcomes ? {fresh: freshOutcomes, inherited: null} : null),
  };
}

module.exports = {verifySettlementReport, BOND, REQUIRED_SCHEMA, DEFAULT_BASE_WASM_SHA256};
