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
const REQUIRED_SCHEMA = 'near-rehearsal/settlement-refund/v3';

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
    if (receipt.status?.Failure && JSON.stringify(receipt.status).includes(needle)) {
      if (receipt.executorId !== expectedExecutor) { fail(false, `${label} failure receipt has the wrong executor`); return false; }
      found = true;
    }
    for (const child of receipt.receiptIds || []) queue.push(child);
  }
  for (const id of byId.keys()) if (!seen.has(id)) { fail(false, `${label} has an unlinked receipt`); return false; }
  if (!found) { fail(false, `${label} has no reachable failed receipt`); return false; }
  return true;
}

function verifyLegacySeed(scenario, dao, fail, installationValid = true) {
  const seed = scenario.transactions?.seed;
  const legacy = scenario.legacy;
  if (!seed) { fail(false, 'legacy principal seed transaction is missing'); return false; }
  let valid = true;
  const check = (condition, message) => { if (!condition) { valid = false; fail(false, message); } };
  const financeCheck = (condition, message) => { if (!condition) fail(false, message, valid && installationValid ? 'verified' : 'incomplete'); };
  const amountValue = (value) => (/^[0-9]+$/.test(String(value ?? '')) ? BigInt(String(value)) : null);
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
  const seededFailure = legacy?.seededRefundFailure;
  const seededFinal = seededFailure?.final;
  const seededProposer = legacy?.seedArgs?.proposer;
  check(seededFinal?.finalExecutionStatus === 'FINAL', 'seeded refund failure was not FINAL');
  check(seededFinal?.transaction?.receiverId === dao, 'seeded refund failure receiver is not the DAO');
  const seededSigner = scenario.transactions?.vote?.transaction?.signerId;
  check(seededSigner && seededFinal?.transaction?.signerId === seededSigner, 'seeded refund failure signer is not the recorded voter');
  const seededCall = soleCall(seededFinal, 'seeded refund failure', (message) => check(false, message));
  check(seededCall?.call?.method_name === 'act_proposal', 'seeded refund failure called the wrong method');
  if (seededCall) {
    check(String(seededCall.args?.id) === String(scenario.proposalId), 'seeded refund failure targets a different proposal');
    check(seededCall.args?.action === 'Finalize', 'seeded refund failure action is not Finalize');
  }
  check(seededProposer && reachableFailure(seededFinal, seededProposer, seededProposer, 'seeded refund failure', check), 'seeded refund failure lacks a linked failed transfer to the deleted proposer');
  const seedHeight = recordedHeight(legacy?.seed?.blockHeight);
  const failureHeight = recordedHeight(seededFinal?.blockHeight);
  const observationHeight = recordedHeight(seededFailure?.snapshot?.blockHeight);
  check(seedHeight !== null && failureHeight !== null && observationHeight !== null, 'seeded refund chronology is missing');
  if (seedHeight !== null && failureHeight !== null && observationHeight !== null) {
    check(seedHeight < failureHeight && failureHeight <= observationHeight, 'seeded refund chronology is not seed -> failure -> observation');
  }
  const seededLocked = amountValue(seededFailure?.snapshot?.lockedAmount);
  if (seededLocked === null) check(false, 'seeded refund failure locked observation is missing or malformed');
  else financeCheck(String(seededLocked) === String(deposit), 'seeded refund failure did not retain the locked debt');
  check(seededFailure?.snapshot?.proposal?.id === scenario.proposalId && seededFailure?.snapshot?.proposal?.status === 'Failed', 'seeded refund failure changed the original proposal');
  check(seededFailure?.snapshot?.proposer === null || BigInt(seededFailure.snapshot.proposer) === 0n, 'seeded refund failure paid the deleted proposer');
  const beforeProbeLocked = amountValue(legacy?.beforeSeedProbe?.lockedAmount);
  const afterProbeLocked = amountValue(legacy?.afterSeedProbe?.lockedAmount);
  if (beforeProbeLocked === null || afterProbeLocked === null) check(false, 'seed probe locked observations are missing or malformed');
  else financeCheck(String(beforeProbeLocked) === String(deposit) && String(afterProbeLocked) === String(deposit), 'seed probes changed the locked debt');
  check(legacy?.beforeSeedProbe?.proposer === legacy?.afterSeedProbe?.proposer, 'seed probes changed the proposer principal');
  return {valid, traceValid: valid};
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
    const legacySeedCheck = verifyLegacySeed(scenario, scenario.deploy?.transaction?.receiverId, failFor, candidateExecutionValid);
    if (!legacySeedCheck.valid) candidateExecutionValid = false;
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

function verifyUnequalOutcomes(unequal, fail, expectedCandidateSha256 = null) {
  const incomplete = (message) => fail(message);
  const principal = (message) => fail(message, 'verified');
  if (!unequal || typeof unequal !== 'object') { incomplete('unequal legacy-principal case is missing'); return; }
  if (unequal.ok !== true) incomplete('unequal legacy-principal case is not clean');
  const amount = (value) => (/^[0-9]+$/.test(String(value ?? '')) ? BigInt(String(value)) : null);
  let sharedValid = true;
  let aliceValid = true;
  let bobValid = true;
  let aliceObserved = true;
  let bobObserved = true;
  const bindingFail = (message, user = 'shared') => {
    if (user === 'alice') aliceValid = false;
    else if (user === 'bob') bobValid = false;
    else sharedValid = false;
    incomplete(message);
  };
  const requireBinding = (condition, message, user = 'shared') => { if (!condition) bindingFail(message, user); };

  const before = unequal.before;
  const after = unequal.after;
  const bobBefore = unequal.bobBefore;
  const bobAfter = unequal.bobAfter;
  if (!before || !after) { aliceObserved = false; bindingFail('unequal Alice snapshots are incomplete', 'alice'); }
  if (!bobBefore || !bobAfter) { bobObserved = false; bindingFail('unequal Bob snapshots are incomplete', 'bob'); }

  const addAlice = unequal.transactions?.addAlice;
  const addBob = unequal.transactions?.addBob;
  const unequalDao = unequal.dao || addAlice?.transaction?.receiverId;
  requireBinding(Boolean(unequalDao), 'unequal DAO identity is missing');
  if (!addAlice) bindingFail('unequal Alice funding evidence is missing', 'alice');
  if (!addBob) bindingFail('unequal Bob funding evidence is missing', 'bob');

  for (const [name, user, proposalId, beforeSnap, afterSnap, funding] of [
    ['Alice', 'alice', unequal.ids?.alice, before, after, addAlice],
    ['Bob', 'bob', unequal.ids?.bob, bobBefore, bobAfter, addBob],
  ]) {
    if (!beforeSnap || !afterSnap) continue;
    if (!funding) continue;
    requireBinding(String(beforeSnap?.proposal?.id) === String(proposalId) && String(afterSnap?.proposal?.id) === String(proposalId), `unequal ${name} snapshot is not bound to its proposal id`, user);
    requireBinding(beforeSnap?.proposal?.proposer === funding?.transaction?.signerId && afterSnap?.proposal?.proposer === funding?.transaction?.signerId, `unequal ${name} snapshot proposer does not match its funding signer`, user);
    requireBinding(funding?.transaction?.receiverId === unequalDao, `unequal ${name} funding receiver is not the DAO`, user);
    requireBinding(funding?.finalExecutionStatus === 'FINAL' && Boolean(funding?.transactionHash), `unequal ${name} funding is not FINAL and identified`, user);
    const fundingFailure = (message) => bindingFail(message, user);
    requireBinding(successfulReceiptChain(funding, `unequal ${name} funding`, fundingFailure), `unequal ${name} funding lacks a linked successful receipt chain`, user);
  }
  const depositOf = (tx) => (tx?.transaction?.actions || []).find((action) => action?.FunctionCall?.method_name === 'add_proposal')?.FunctionCall?.deposit;
  if (addAlice) requireBinding(String(depositOf(addAlice)) === String(10n ** 24n), 'unequal Alice funding deposit is not one bond', 'alice');
  if (addBob) requireBinding(String(depositOf(addBob)) === String(2n * 10n ** 24n), 'unequal Bob funding deposit is not two bonds', 'bob');
  requireBinding(!expectedCandidateSha256 || unequal.candidateWasmSha256 === expectedCandidateSha256, 'unequal evidence is bound to a different candidate');
  requireBinding(unequal.baseWasmSha256 === DEFAULT_BASE_WASM_SHA256, 'unequal evidence is not bound to the pinned base artifact');

  const baseDeploy = unequal.transactions?.baseDeploy;
  const baseCommitment = deploymentCommitment(baseDeploy, 'unequal base deploy', (message) => bindingFail(message), unequalDao);
  requireBinding(baseCommitment === unequal.baseWasmSha256, 'unequal base deploy does not bind the pinned base artifact');
  const upgradeDeploy = unequal.transactions?.upgradeDeploy;
  const upgradeMigrate = unequal.transactions?.upgradeMigrate;
  const upgradeCommitment = deploymentCommitment(upgradeDeploy, 'unequal candidate upgrade', (message) => bindingFail(message), unequalDao);
  requireBinding(upgradeCommitment === unequal.candidateWasmSha256, 'unequal candidate upgrade does not bind the candidate artifact');
  requireBinding(upgradeMigrate?.finalExecutionStatus === 'FINAL' && successfulReceiptChain(upgradeMigrate, 'unequal migrate', (message) => bindingFail(message)), 'unequal migrate was not a successful FINAL transaction');
  requireBinding(upgradeMigrate?.transaction?.signerId === unequalDao && upgradeMigrate?.transaction?.receiverId === unequalDao, 'unequal migrate is not a DAO-private call');
  const migrateCall = soleCall(upgradeMigrate, 'unequal migrate', (message) => bindingFail(message));
  requireBinding(migrateCall?.call?.method_name === 'migrate', 'unequal migrate called the wrong method');
  const recovery = unequal.transactions?.recovery;
  requireBinding(recovery?.finalExecutionStatus === 'FINAL', 'unequal Alice recovery was not FINAL');
  requireBinding(recovery?.transaction?.receiverId === unequalDao, 'unequal Alice recovery receiver is not the DAO');
  const recoveryCall = soleCall(recovery, 'unequal Alice recovery', (message) => bindingFail(message));
  requireBinding(recoveryCall?.call?.method_name === 'act_proposal' && String(recoveryCall?.args?.id) === String(unequal.ids?.alice) && recoveryCall?.args?.action === 'Finalize', 'unequal Alice recovery does not target the recorded obligation');
  requireBinding(reachableFailure(recovery, 'missing-target.test.near', 'missing-target', 'unequal Alice recovery', (message) => bindingFail(message)), 'unequal Alice recovery lacks the expected reachable failure');

  for (const [name, user, tx, seed, proposalId, proposer, expected] of [
    ['Alice', 'alice', addAlice, unequal.transactions?.seedAlice, unequal.ids?.alice, addAlice?.transaction?.signerId, '1000000000000000000000000'],
    ['Bob', 'bob', addBob, unequal.transactions?.seedBob, unequal.ids?.bob, addBob?.transaction?.signerId, '2000000000000000000000000'],
  ]) {
    if (!tx) continue;
    const seedFailure = (message) => bindingFail(message, user);
    requireBinding(seed?.finalExecutionStatus === 'FINAL' && successfulReceiptChain(seed, `unequal ${name} seed`, seedFailure), `unequal ${name} seed lacks a successful FINAL receipt chain`, user);
    requireBinding(seed?.transaction?.signerId === unequalDao && seed?.transaction?.receiverId === unequalDao, `unequal ${name} seed is not a DAO-private call`, user);
    const decoded = soleCall(seed, `unequal ${name} seed`, seedFailure);
    requireBinding(decoded?.call?.method_name === 'seed_legacy_proposal_bond', `unequal ${name} seed called the wrong method`, user);
    if (decoded) {
      requireBinding(String(decoded.args?.proposal_id) === String(proposalId), `unequal ${name} seed targets the wrong proposal`, user);
      requireBinding(decoded.args?.proposer === proposer, `unequal ${name} seed proposer does not match its funding transaction`, user);
      requireBinding(String(decoded.args?.amount) === expected, `unequal ${name} seed amount is not its measured funding deposit`, user);
      requireBinding(decoded.args?.funding_tx_hash === tx.transactionHash, `unequal ${name} seed does not bind its measured funding`, user);
    }
  }

  const height = (value, label, user = 'shared') => {
    const parsed = recordedHeight(value);
    if (parsed === null) bindingFail(`unequal ${label} height is missing or malformed`, user);
    return parsed;
  };
  const addAliceHeight = height(addAlice?.blockHeight, 'Alice funding');
  const addBobHeight = height(addBob?.blockHeight, 'Bob funding');
  const baseHeight = height(baseDeploy?.blockHeight, 'base deploy');
  const upgradeHeight = height(upgradeDeploy?.blockHeight, 'candidate upgrade');
  const migrateHeight = height(upgradeMigrate?.blockHeight, 'candidate migrate');
  const seedAliceHeight = height(unequal.transactions?.seedAlice?.blockHeight, 'Alice seed', 'alice');
  const seedBobHeight = height(unequal.transactions?.seedBob?.blockHeight, 'Bob seed', 'bob');
  const recoveryHeight = height(recovery?.blockHeight, 'Alice recovery');
  const beforeHeight = height(before?.blockHeight, 'Alice before observation', 'alice');
  const afterHeight = height(after?.blockHeight, 'Alice after observation', 'alice');
  const bobBeforeHeight = height(bobBefore?.blockHeight, 'Bob before observation', 'bob');
  const bobAfterHeight = height(bobAfter?.blockHeight, 'Bob after observation', 'bob');
  if (addAliceHeight !== null && addBobHeight !== null && upgradeHeight !== null && baseHeight !== null) {
    if (!(addAliceHeight < upgradeHeight && addBobHeight < upgradeHeight && baseHeight < upgradeHeight)) bindingFail('unequal funding/base observation is not before the candidate upgrade');
  }
  if (upgradeHeight !== null && migrateHeight !== null && seedAliceHeight !== null && seedBobHeight !== null) {
    if (!(upgradeHeight < migrateHeight && migrateHeight < seedAliceHeight && migrateHeight < seedBobHeight)) bindingFail('unequal upgrade/migrate is not before both seeds');
  }
  if (recoveryHeight !== null && seedAliceHeight !== null && seedBobHeight !== null) {
    if (!(seedAliceHeight < recoveryHeight && seedBobHeight < recoveryHeight)) bindingFail('unequal seed is not before the recovery');
  }
  if (beforeHeight !== null && afterHeight !== null && recoveryHeight !== null) {
    if (!(beforeHeight <= recoveryHeight && recoveryHeight <= afterHeight)) bindingFail('unequal Alice recovery is outside its before/after observations', 'alice');
  }
  if (bobBeforeHeight !== null && bobAfterHeight !== null && recoveryHeight !== null) {
    if (!(bobBeforeHeight <= recoveryHeight && recoveryHeight <= bobAfterHeight)) bindingFail('unequal Bob observations do not bracket the recovery', 'bob');
  }
  const raw = (value, label, user) => {
    const parsed = amount(value);
    if (parsed === null) {
      if (user === 'alice') aliceObserved = false;
      else bobObserved = false;
      incomplete(`unequal ${label} is missing or invalid`);
    }
    return parsed;
  };
  const beforeProposer = raw(before?.proposer, 'Alice before proposer balance', 'alice');
  const afterProposer = raw(after?.proposer, 'Alice after proposer balance', 'alice');
  const bobBeforeProposer = raw(bobBefore?.proposer, 'Bob before proposer balance', 'bob');
  const bobAfterProposer = raw(bobAfter?.proposer, 'Bob after proposer balance', 'bob');
  const bobAfterLocked = raw(bobAfter?.lockedAmount, 'Bob after locked amount', 'bob');
  const bobBeforeLocked = raw(bobBefore?.lockedAmount, 'Bob before locked amount', 'bob');
  if (!bobBefore?.proposal || !bobAfter?.proposal) { bobObserved = false; incomplete('unequal Bob proposal snapshot is incomplete'); }
  const delta = beforeProposer !== null && afterProposer !== null ? afterProposer - beforeProposer : null;
  const reportedAliceDelta = amount(unequal.aliceDelta);
  if (delta === null || reportedAliceDelta === null || reportedAliceDelta !== delta) { aliceObserved = false; incomplete('unequal reported Alice delta is missing or inconsistent with raw balances'); }
  const reportedBobLocked = amount(unequal.bobLocked);
  if (bobAfterLocked === null || reportedBobLocked === null || reportedBobLocked !== bobAfterLocked) { bobObserved = false; incomplete('unequal reported Bob debt is missing or inconsistent with the raw balance'); }
  const classifyAlice = sharedValid && aliceValid && aliceObserved ? principal : incomplete;
  const classifyBob = sharedValid && bobValid && bobObserved ? principal : incomplete;
  if (delta !== null && delta !== 10n ** 24n) classifyAlice('unequal Alice refund is not exactly one original bond');
  if (bobBeforeProposer !== null && bobAfterProposer !== null && bobBeforeProposer !== bobAfterProposer) classifyBob('unequal Bob principal changed');
  if (bobBefore?.proposal && bobAfter?.proposal && JSON.stringify(bobBefore.proposal) !== JSON.stringify(bobAfter.proposal)) classifyBob('unequal Bob proposal changed');
  if (bobBeforeLocked !== null && bobAfterLocked !== null && bobAfterLocked !== 2n * 10n ** 24n) classifyBob('unequal Bob debt is not preserved at two bonds');
  if (amount(unequal.policyBefore?.proposal_bond) !== 10n ** 24n || amount(unequal.policyAfter?.proposal_bond) !== 2n * 10n ** 24n) bindingFail('unequal policy change is not the measured one-to-two transition');
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
  // A demonstrated economic loss remains REJECTED even when the report uses an
  // older schema; missing current coverage is still recorded as incomplete.
  const knownSchema = report?.schema === REQUIRED_SCHEMA || report?.schema === 'near-rehearsal/settlement-refund/v2';
  const identityEstablished = knownSchema && candidateIdentityValid && baseIdentityValid && requestedCandidateValid;
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
  try { verifyUnequalOutcomes(report?.unequal, fail, candidateWasmSha256); }
  catch (error) { fail(`unequal evidence prevented verification: ${error.message}`); }
  // A successful business action whose bond refund failed is a separate
  // terminal obligation. It is mandatory for acceptance: an older report that
  // simply lacks this evidence is inconclusive, never silently accepted.
  const approved = report?.successfulActionRefund;
  if (!approved) {
    fail('approved-action/failed-refund coverage is missing');
  } else {
    const approvedAmount = (value) => {
      if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
      return null;
    };
    const approvedFail = (condition, message, kind = 'incomplete') => {
      if (!condition) fail(`approved-action/failed-refund: ${message}`, kind);
    };
    const transfer = 10n ** 23n;
    const bond = approvedAmount(approved.bond);
    approvedFail(bond === BOND, 'recorded bond is not the pinned obligation');
    approvedFail(approved.candidateWasmSha256 === candidateWasmSha256, 'evidence is for a different candidate', 'verified');
    approvedFail(typeof approved.proposer === 'string' && approved.proposer.length > 0, 'proposer identity is missing');
    approvedFail(typeof approved.recipient === 'string' && approved.recipient.length > 0, 'recipient identity is missing');
    const approvedDaoValid = typeof approved.dao === 'string' && approved.dao.length > 0;
    approvedFail(approvedDaoValid, 'DAO identity is missing');
    const deployed = deploymentCommitment(approved.deploy, 'approved-action deployment', (message) => approvedFail(false, message), approvedDaoValid ? approved.dao : null);
    if (deployed !== null) approvedFail(deployed === approved.candidateWasmSha256, 'approved-action deployment is not bound to the candidate WASM', 'verified');
    const observedCodeValid = typeof approved.observedCodeHash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(approved.observedCodeHash);
    approvedFail(observedCodeValid, 'observed DAO code hash is missing or malformed');
    if (deployed !== null && observedCodeValid) approvedFail(approved.observedCodeHash === approved.deploy.codeHash, 'observed DAO code differs from the deployment commitment', 'verified');
    const installationValid = deployed !== null && deployed === approved.candidateWasmSha256 && observedCodeValid && approved.observedCodeHash === approved.deploy.codeHash;
    let snapshotBindingsValid = true;
    let heightBindingsValid = true;
    const approval = approved.approval;
    const retry = approved.retry;
    const duplicate = approved.duplicate;
    const before = approved.before;
    const afterApproval = approved.afterApproval;
    const beforeRetry = approved.beforeRetry;
    const afterRetry = approved.afterRetry;
    const afterDuplicate = approved.afterDuplicate;
    for (const [name, value] of [['approval', approval], ['retry', retry], ['duplicate', duplicate]]) {
      approvedFail(value && value.finalExecutionStatus === 'FINAL', `${name} execution is missing or not FINAL`);
      approvedFail(value && value.transaction && value.transaction.receiverId, `${name} transaction identity is missing`);
    }
    for (const [name, value] of [['before', before], ['afterApproval', afterApproval], ['beforeRetry', beforeRetry], ['afterRetry', afterRetry], ['afterDuplicate', afterDuplicate], ['afterUnauthorized', approved.afterUnauthorized]]) {
      approvedFail(value !== null && typeof value === 'object', `${name} snapshot is missing`);
      if (value && typeof value === 'object') {
        const daoOk = typeof value.dao === 'string' && value.dao.length > 0;
        const sameDao = !approvedDaoValid || typeof value.dao !== 'string' || value.dao === approved.dao;
        const pinned = typeof value.blockHash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(value.blockHash) && recordedHeight(value.blockHeight) !== null;
        const codeOk = typeof value.codeHash === 'string' && value.codeHash.length > 0;
        const sameCode = !observedCodeValid || typeof value.codeHash !== 'string' || value.codeHash === approved.observedCodeHash;
        approvedFail(daoOk, `${name} snapshot DAO is missing`);
        if (approvedDaoValid && typeof value.dao === 'string') approvedFail(value.dao === approved.dao, `${name} snapshot belongs to a different DAO`);
        approvedFail(pinned, `${name} snapshot is not block-pinned`);
        approvedFail(codeOk, `${name} snapshot code hash is missing`);
        if (observedCodeValid && typeof value.codeHash === 'string') approvedFail(value.codeHash === approved.observedCodeHash, `${name} snapshot code differs from the deployed candidate`);
        if (!daoOk || !sameDao || !pinned || !codeOk || !sameCode) snapshotBindingsValid = false;
      } else {
        snapshotBindingsValid = false;
      }
    }
    const heightCheck = (condition, message) => {
      if (!condition) { approvedFail(false, message); heightBindingsValid = false; }
    };
    const windowCheck = (label, transaction, beforeSnapshot, afterSnapshot) => {
      const lower = recordedHeight(beforeSnapshot?.blockHeight);
      const upper = recordedHeight(afterSnapshot?.blockHeight);
      const height = recordedHeight(transaction?.blockHeight);
      heightCheck(lower !== null && upper !== null, `${label} measurement window is missing`);
      heightCheck(height !== null, `${label} blockHeight is missing or malformed`);
      if (lower !== null && upper !== null) {
        heightCheck(lower <= upper, `${label} measurement window is inverted`);
        if (height !== null) heightCheck(height >= lower && height <= upper, `${label} execution is outside its measurement window`);
        for (const receipt of transaction?.receipts || []) {
          const receiptHeight = recordedHeight(receipt?.blockHeight);
          heightCheck(receiptHeight !== null, `${label} receipt completion height is missing`);
          if (receiptHeight !== null) heightCheck(receiptHeight >= lower && receiptHeight <= upper, `${label} receipt completion is outside its measurement window`);
        }
      }
    };
    if (approval && retry && duplicate) {
      windowCheck('approval', approval, before, afterApproval);
      windowCheck('retry', retry, beforeRetry, afterRetry);
      windowCheck('duplicate', duplicate, afterRetry, afterDuplicate);
    }
    if (!approval?.transaction || !retry?.transaction || !duplicate?.transaction || !before || !afterApproval || !beforeRetry || !afterRetry || !afterDuplicate) {
      approvedFail(false, 'complete approval/retry/duplicate transactions and snapshots are required');
    } else {
      const dao = approval.transaction.receiverId;
      if (approvedDaoValid) approvedFail(approved.dao === dao, 'approval did not target the deployed approved-action DAO', 'verified');
      approvedFail(retry.transaction.receiverId === dao, 'retry did not target the same DAO');
      approvedFail(duplicate.transaction.receiverId === dao, 'duplicate did not target the same DAO');
      approvedFail(approval.transaction.receiverId === dao, 'approval did not target the retry DAO');
      const approvalCall = decodeCall(approval, 'approved action approval', (message) => fail(message));
      const retryCall = decodeCall(retry, 'approved action retry', (message) => fail(message));
      const duplicateCall = decodeCall(duplicate, 'approved action duplicate', (message) => fail(message));
      if (!approvalCall || !retryCall || !duplicateCall) {
        approvedFail(false, 'approval/retry/duplicate call payloads could not be decoded');
      } else {
      approvedFail(approvalCall.call.method_name === 'act_proposal' && approvalCall.args.action === 'VoteApprove', 'approval is not a VoteApprove');
      approvedFail(retryCall.call.method_name === 'act_proposal' && retryCall.args.action === 'Finalize', 'retry is not a Finalize');
      approvedFail(duplicateCall.call.method_name === 'act_proposal' && duplicateCall.args.action === 'Finalize', 'duplicate is not a Finalize');
      approvedFail(String(retryCall.args.id) === String(approvalCall.args.id), 'retry targets a different proposal');
      approvedFail(String(duplicateCall.args.id) === String(approvalCall.args.id), 'duplicate targets a different proposal');
      approvedFail(retry.transaction.signerId === approved.proposer, 'retry was not signed by the original proposer', 'verified');
      approvedFail(retryCall.args.proposal && JSON.stringify(retryCall.args.proposal) === JSON.stringify(approvalCall.args.proposal), 'retry changed the recorded proposal kind', 'verified');
      const approvalOk = successfulReceiptChain(approval, 'approved action approval', (message) => fail(message));
      const retryOk = successfulReceiptChain(retry, 'approved action retry', (message) => fail(message));
      approvedFail(approvalOk, 'approval has no successful receipt chain');
      approvedFail(retryOk, 'retry has no successful receipt chain');
      const operationValid = Boolean(
        approval && retry && duplicate &&
        approval.transaction && retry.transaction && duplicate.transaction &&
        approvalCall && retryCall && duplicateCall &&
        approvalCall.call.method_name === 'act_proposal' && approvalCall.args.action === 'VoteApprove' &&
        retryCall.call.method_name === 'act_proposal' && retryCall.args.action === 'Finalize' &&
        duplicateCall.call.method_name === 'act_proposal' && duplicateCall.args.action === 'Finalize' &&
        String(retryCall.args.id) === String(approvalCall.args.id) &&
        String(duplicateCall.args.id) === String(approvalCall.args.id) &&
        retry.transaction.signerId === approved.proposer &&
        approval.transaction.receiverId === dao && retry.transaction.receiverId === dao && duplicate.transaction.receiverId === dao &&
        approvalOk && retryOk,
      );
      const economicAttributable = installationValid && snapshotBindingsValid && heightBindingsValid && operationValid;
      const economicFail = (condition, message) => approvedFail(condition, message, economicAttributable ? 'verified' : 'incomplete');
      const textAmount = (snapshot, name, label) => {
        const value = approvedAmount(snapshot?.[name]);
        approvedFail(value !== null, `${label} ${name} is missing or malformed`);
        return value;
      };
      const proposerBefore = textAmount(beforeRetry, 'proposer', 'beforeRetry');
      const proposerAfter = textAmount(afterRetry, 'proposer', 'afterRetry');
      const duplicateAfter = textAmount(afterDuplicate, 'proposer', 'afterDuplicate');
      const lockedBefore = textAmount(beforeRetry, 'lockedAmount', 'beforeRetry');
      const lockedAfter = textAmount(afterRetry, 'lockedAmount', 'afterRetry');
      const lockedDuplicate = textAmount(afterDuplicate, 'lockedAmount', 'afterDuplicate');
      const recipientBefore = textAmount(before, 'recipient', 'before');
      const recipientAfterApproval = textAmount(afterApproval, 'recipient', 'afterApproval');
      const recipientBeforeRetry = textAmount(beforeRetry, 'recipient', 'beforeRetry');
      const recipientAfter = textAmount(afterRetry, 'recipient', 'afterRetry');
      const recipientDuplicate = textAmount(afterDuplicate, 'recipient', 'afterDuplicate');
      if (lockedBefore !== null && bond !== null) economicFail(lockedBefore === bond, 'retry did not start with the recorded bond locked');
      if (lockedAfter !== null) economicFail(lockedAfter === 0n, 'retry did not clear the locked bond');
      if (lockedDuplicate !== null) economicFail(lockedDuplicate === 0n, 'duplicate did not preserve the cleared locked bond');
      if (recipientBefore !== null && recipientAfterApproval !== null) {
        economicFail(recipientAfterApproval - recipientBefore === transfer, 'approved action did not pay the recipient exactly once');
      }
      if (recipientBeforeRetry !== null && recipientAfterApproval !== null) economicFail(recipientBeforeRetry === recipientAfterApproval, 'recipient changed between approval and retry start');
      if (recipientAfter !== null && recipientBeforeRetry !== null) economicFail(recipientAfter === recipientBeforeRetry, 'retry paid the recipient again');
      if (recipientDuplicate !== null && recipientAfter !== null) economicFail(recipientDuplicate === recipientAfter, 'duplicate paid the recipient again');
      const gasOf = (summary) => {
        const tx = approvedAmount(summary?.transactionOutcome?.tokensBurntYocto);
        if (tx === null || !Array.isArray(summary?.receipts)) return null;
        let total = tx;
        for (const receipt of summary.receipts) {
          const fee = approvedAmount(receipt?.tokensBurntYocto);
          if (fee === null) return null;
          total += fee;
        }
        return total;
      };
      const retryGas = gasOf(retry);
      approvedFail(retryGas !== null, 'retry gas is missing or malformed');
      if (retryGas !== null && proposerBefore !== null && proposerAfter !== null && bond !== null) {
        const principal = proposerAfter - proposerBefore + retryGas;
        economicFail(principal === bond, `retry principal is ${principal}, expected the recorded bond`);
      }
      const duplicateGas = gasOf(duplicate);
      approvedFail(duplicateGas !== null, 'duplicate gas is missing or malformed');
      if (duplicateGas !== null && proposerAfter !== null && duplicateAfter !== null) {
        const duplicatePrincipal = duplicateAfter - proposerAfter + duplicateGas;
        economicFail(duplicatePrincipal === 0n, `duplicate moved proposer principal by ${duplicatePrincipal}`);
      }
      const duplicateGuard = reachableFailure(duplicate, dao, 'ERR_PROPOSAL_ALREADY_EXECUTED', 'duplicate retry', (condition, message) => approvedFail(condition, message));
      approvedFail(duplicateGuard, 'duplicate retry was not denied by the terminal guard');
      const unauthorized = approved.unauthorized;
      approvedFail(unauthorized?.ok === false && unauthorized?.value?.finalExecutionStatus === 'FINAL', 'unauthorized callback evidence is missing or not FINAL');
      if (unauthorized?.value) {
        verifyUnauthorized({
          proposalId: approvalCall.args.id,
          transactions: {unauthorized},
          unauthorized,
          afterRetry: {blockHeight: afterRetry.blockHeight},
          afterUnauthorized: {blockHeight: approved.afterUnauthorized?.blockHeight},
        }, dao, (condition, message) => approvedFail(condition, message));
      }
      }
    }
  }
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
