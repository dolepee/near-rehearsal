'use strict';
/*
 * Pilot-only Node harness for Sputnik #226.
 *
 * Thin, single-case runner. It does not alter the Rehearsal app or claim a
 * generic adapter. The old DAO state is locally constructed, not captured
 * mainnet state.
 *
 * The update is a local configured-factory update: `new()` is called by root,
 * so root is persisted as FactoryInfo.factory_id. Root then calls `update()`
 * with raw candidate bytes. This is the authorized factory branch, not the
 * governance UpgradeSelf/callback branch.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

// The patched Node near-sandbox binding expects a DIRECTORY. Do not reuse the
// Rust NEAR_SANDBOX_BIN_PATH value, which is the executable file.
if (process.env.NODE_SANDBOX_BIN_DIR) {
  process.env.NEAR_SANDBOX_BIN_PATH = process.env.NODE_SANDBOX_BIN_DIR;
}
const {Worker, parseNEAR} = require('near-workspaces');

const GAS = 100_000_000_000_000n;
const FINALITY_TIMEOUT_MS = 30_000;
const FINALITY_POLL_MS = 250;
const near = (value) => BigInt(parseNEAR(value));
const TRANSFER = near('1');
const EVIDENCE = path.resolve(process.env.EVIDENCE_PATH || 'case-triage/sputnik-226/evidence.json');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const evidence = {
  schema: 'near-rehearsal/pilot/sputnik-226-node-evidence/v1',
  status: 'running',
  stage: 'setup',
  mode: 'local-configured-factory-update',
  governanceUpgradeSelf: false,
  callbackFlow: false,
  state: 'locally constructed; not captured public-chain state',
  transactions: {},
  finality: {},
};

let worker;
let currentStage = 'setup';

function persist(status = evidence.status) {
  evidence.status = status;
  evidence.stage = currentStage;
  try {
    fs.mkdirSync(path.dirname(EVIDENCE), {recursive: true});
    fs.writeFileSync(EVIDENCE, json(evidence) + '\n');
  } catch (error) {
    console.error(`could not persist evidence at ${EVIDENCE}: ${error.stack || error.message}`);
  }
}

function stage(name) {
  currentStage = name;
  evidence.stage = name;
  persist('running');
}

const viewJson = async (worker, accountId, method, args = {}) => {
  const result = await worker.provider.viewCall(accountId, method, args, {finality: 'final'});
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
};
const viewAmount = async (worker, accountId) => BigInt((await worker.provider.viewAccount(accountId, {finality: 'final'})).amount);
const assertSuccess = (tx, label) => {
  if (tx.failed || !tx.succeeded || (tx.failures || []).length) {
    throw new Error(`${label} failed: ${JSON.stringify(tx.failures)}`);
  }
};
const assertLocal = (worker) => {
  const rpc = worker.config?.rpcAddr || worker.provider?.connection?.url;
  const host = new URL(rpc).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`refusing non-local execution RPC: ${rpc}`);
};

async function blockHeight(blockHash) {
  const block = await worker.provider.block({blockId: blockHash});
  if (!Number.isFinite(block?.header?.height)) throw new Error(`block ${blockHash} has no header.height`);
  return block.header.height;
}

async function waitFinalized(tx, label) {
  const result = tx?.result;
  const receiptOutcomes = result?.receipts_outcome || [];
  const hashes = [];
  if (result?.transaction_outcome?.block_hash) hashes.push(result.transaction_outcome.block_hash);
  for (const outcome of receiptOutcomes) {
    if (outcome?.block_hash) hashes.push(outcome.block_hash);
  }
  if (!hashes.length) throw new Error(`cannot establish finality target for ${label}: no receipt block hashes`);
  const target = Math.max(...await Promise.all(hashes.map(blockHeight)));
  const started = Date.now();
  while (Date.now() - started <= FINALITY_TIMEOUT_MS) {
    const finalized = await worker.provider.block({finality: 'final'});
    const height = finalized?.header?.height;
    if (Number.isFinite(height) && height >= target) {
      evidence.finality[label] = {target, finalized: height, waitedMs: Date.now() - started};
      persist();
      return;
    }
    await sleep(FINALITY_POLL_MS);
  }
  throw new Error(`finality barrier timed out for ${label}: target block ${target}, waited ${FINALITY_TIMEOUT_MS}ms`);
}

async function main() {
  try {
    stage('inputs');
    const basePath = process.env.BASE_WASM;
    const candidatePath = process.env.CANDIDATE_WASM;
    const baseSha = process.env.BASE_WASM_SHA256;
    const candidateSha = process.env.CANDIDATE_WASM_SHA256;
    if (!basePath || !candidatePath || !baseSha || !candidateSha) {
      throw new Error('BASE_WASM, CANDIDATE_WASM, BASE_WASM_SHA256 and CANDIDATE_WASM_SHA256 are required');
    }
    const baseWasm = fs.readFileSync(path.resolve(basePath));
    const candidateWasm = fs.readFileSync(path.resolve(candidatePath));
    assert.equal(sha256(baseWasm), baseSha, 'base WASM hash mismatch');
    assert.equal(sha256(candidateWasm), candidateSha, 'candidate WASM hash mismatch');
    evidence.inputs = {
      baseWasm: path.resolve(basePath), baseSha256: sha256(baseWasm),
      candidateWasm: path.resolve(candidatePath), candidateSha256: sha256(candidateWasm),
    };
    persist('running');

    stage('worker');
    worker = await Worker.init({network: 'sandbox'});
    assertLocal(worker);
    evidence.rpc = worker.config?.rpcAddr || worker.provider?.connection?.url;
    const root = worker.rootAccount;
    evidence.factory = {
      factoryId: root.accountId,
      initializedBy: root.accountId,
      mode: 'local-configured-factory-update',
      governanceUpgradeSelf: false,
      callbackFlow: false,
    };
    persist('running');

    stage('create-accounts');
    const dao = await root.createSubAccount('pilot-dao', {initialBalance: near('100')});
    const recipient = await root.createSubAccount('pilot-recipient', {initialBalance: near('1')});
    evidence.contract = dao.accountId;
    evidence.recipient = {accountId: recipient.accountId};
    persist('running');

    stage('deploy-base');
    const deployTx = await dao.deploy(baseWasm);
    evidence.transactions.deploy = deployTx.result;
    persist('running');
    stage('deploy-finality');
    await waitFinalized(deployTx, 'deploy');

    stage('init');
    // Root calls new(), so FactoryInfo.factory_id is persisted as root.
    const initTx = await root.callRaw(dao, 'new', {
      config: {name: 'pilot', purpose: 'locally constructed old-proposal upgrade pilot', metadata: ''},
      policy: [root.accountId],
    }, {gas: GAS});
    evidence.transactions.init = initTx.result;
    persist('running');
    assertSuccess(initTx, 'init');
    stage('init-finality');
    await waitFinalized(initTx, 'init');

    stage('config-before');
    const configBefore = await viewJson(worker, dao.accountId, 'get_config');
    evidence.configBefore = configBefore;
    persist('running');

    const transferKind = {
      Transfer: {token_id: '', receiver_id: recipient.accountId, amount: TRANSFER.toString(), msg: null},
    };
    stage('add-proposal');
    const addTx = await root.callRaw(dao, 'add_proposal', {
      proposal: {description: 'pre-upgrade transfer proposal', kind: transferKind},
    }, {gas: GAS, attachedDeposit: TRANSFER});
    evidence.transactions.addProposal = addTx.result;
    persist('running');
    assertSuccess(addTx, 'add_proposal');
    stage('add-finality');
    await waitFinalized(addTx, 'add-proposal');
    const proposalId = addTx.parseResult();
    if (!Number.isSafeInteger(Number(proposalId))) throw new Error(`unsafe proposal id: ${proposalId}`);
    evidence.proposalId = proposalId;
    persist('running');

    stage('proposal-before');
    const before = await viewJson(worker, dao.accountId, 'get_proposal', {id: Number(proposalId)});
    assert.equal(before.status, 'InProgress', 'old proposal must be InProgress');
    assert.equal(before.kind?.Transfer?.receiver_id, recipient.accountId, 'old proposal receiver mismatch');
    assert.equal(Object.prototype.hasOwnProperty.call(before, 'last_actions_log'), false, 'old schema unexpectedly has last_actions_log');
    evidence.proposalBefore = before;
    persist('running');

    stage('recipient-before');
    const recipientBefore = await viewAmount(worker, recipient.accountId);
    evidence.recipient.before = recipientBefore.toString();
    persist('running');

    stage('update');
    // Root is the persisted factory. Do not use the DAO self-call: that branch
    // consumes promise_result(0) as a callback and is invalid for a direct call.
    const updateTx = await root.callRaw(dao, 'update', candidateWasm, {gas: GAS});
    evidence.transactions.update = updateTx.result;
    persist('running');
    assertSuccess(updateTx, 'update');
    stage('update-finality');
    await waitFinalized(updateTx, 'update');

    stage('post-update-code');
    const rawCode = await worker.provider.viewCodeRaw(dao.accountId, {finality: 'final'});
    const code = Buffer.isBuffer(rawCode) ? rawCode : Buffer.from(rawCode, 'base64');
    assert.equal(Buffer.compare(code, candidateWasm), 0, 'candidate code bytes mismatch');
    evidence.codeSha256 = sha256(code);
    persist('running');

    stage('post-update-proposal');
    const after = await viewJson(worker, dao.accountId, 'get_proposal', {id: Number(proposalId)});
    assert.equal(after.status, 'InProgress', 'post-upgrade proposal status changed unexpectedly');
    evidence.proposalAfterUpgrade = after;
    persist('running');

    stage('config-after');
    const configAfter = await viewJson(worker, dao.accountId, 'get_config');
    assert.deepEqual(configAfter, configBefore, 'get_config changed across upgrade');
    evidence.configAfter = configAfter;
    persist('running');

    stage('approve');
    const approveTx = await root.callRaw(dao, 'act_proposal', {
      id: Number(proposalId), action: 'VoteApprove', proposal: transferKind,
    }, {gas: GAS});
    evidence.transactions.approve = approveTx.result;
    persist('running');
    assertSuccess(approveTx, 'act_proposal');
    stage('approve-finality');
    await waitFinalized(approveTx, 'approve');

    stage('final-proposal');
    const finalProposal = await viewJson(worker, dao.accountId, 'get_proposal', {id: Number(proposalId)});
    assert.equal(finalProposal.status, 'Approved', 'proposal was not approved');
    assert.equal(finalProposal.votes?.[root.accountId], 'Approve', 'root vote did not persist');
    evidence.proposalAfter = finalProposal;
    persist('running');

    stage('recipient-after');
    const recipientAfter = await viewAmount(worker, recipient.accountId);
    assert.equal(recipientAfter - recipientBefore, TRANSFER, 'recipient balance did not increase by transfer amount');
    evidence.recipient.after = recipientAfter.toString();
    evidence.recipient.delta = (recipientAfter - recipientBefore).toString();
    persist('running');

    // Exactly-once check: replay the same approval after the proposal is Approved.
    // It must fail and must not create a second transfer.
    stage('replay');
    const replayTx = await root.callRaw(dao, 'act_proposal', {
      id: Number(proposalId), action: 'VoteApprove', proposal: transferKind,
    }, {gas: GAS});
    evidence.transactions.replay = replayTx.result;
    persist('running');
    stage('replay-finality');
    await waitFinalized(replayTx, 'replay');
    assert.equal(replayTx.succeeded, false, 'duplicate approval unexpectedly succeeded');
    assert.equal(replayTx.failed, true, 'duplicate approval did not fail at execution');

    stage('replay-state');
    const replayProposal = await viewJson(worker, dao.accountId, 'get_proposal', {id: Number(proposalId)});
    assert.equal(replayProposal.status, 'Approved', 'duplicate approval changed final proposal status');
    assert.equal(replayProposal.votes?.[root.accountId], 'Approve', 'duplicate approval changed root vote');
    const recipientAfterReplay = await viewAmount(worker, recipient.accountId);
    assert.equal(recipientAfterReplay.toString(), recipientAfter.toString(), 'duplicate approval caused a second transfer');
    assert.equal(recipientAfterReplay - recipientBefore, TRANSFER, 'total recipient delta is not exactly one transfer');
    evidence.proposalAfterReplay = replayProposal;
    evidence.recipient.afterReplay = recipientAfterReplay.toString();
    evidence.recipient.deltaTotal = (recipientAfterReplay - recipientBefore).toString();

    // Second legitimate retry route: Finalize against the already Approved/paid
    // proposal. Policy::proposal_status rejects non-InProgress/non-Failed states.
    stage('finalize-retry');
    const finalizeTx = await root.callRaw(dao, 'act_proposal', {
      id: Number(proposalId), action: 'Finalize', proposal: transferKind,
    }, {gas: GAS});
    evidence.transactions.finalizeRetry = finalizeTx.result;
    persist('running');
    stage('finalize-retry-finality');
    await waitFinalized(finalizeTx, 'finalize-retry');
    assert.equal(finalizeTx.succeeded, false, 'Finalize retry unexpectedly succeeded');
    assert.equal(finalizeTx.failed, true, 'Finalize retry did not fail at execution');

    stage('finalize-retry-state');
    const finalizeProposal = await viewJson(worker, dao.accountId, 'get_proposal', {id: Number(proposalId)});
    assert.equal(finalizeProposal.status, 'Approved', 'Finalize retry changed final proposal status');
    assert.equal(finalizeProposal.votes?.[root.accountId], 'Approve', 'Finalize retry changed root vote');
    const recipientAfterFinalizeRetry = await viewAmount(worker, recipient.accountId);
    assert.equal(recipientAfterFinalizeRetry.toString(), recipientAfter.toString(), 'Finalize retry caused a second transfer');
    assert.equal(recipientAfterFinalizeRetry - recipientBefore, TRANSFER, 'total recipient delta is not exactly one transfer');
    evidence.proposalAfterFinalizeRetry = finalizeProposal;
    evidence.recipient.afterFinalizeRetry = recipientAfterFinalizeRetry.toString();
    evidence.recipient.deltaTotal = (recipientAfterFinalizeRetry - recipientBefore).toString();
    evidence.replay = {
      scope: 'two tested retry routes; not a universal exactly-once guarantee',
      duplicateApproval: {
        attempted: true,
        expected: 'rejected after Approved',
        transactionSucceeded: replayTx.succeeded,
        transactionFailed: replayTx.failed,
        secondTransfer: false,
      },
      finalizeRetry: {
        attempted: true,
        expected: 'rejected after Approved',
        transactionSucceeded: finalizeTx.succeeded,
        transactionFailed: finalizeTx.failed,
        secondTransfer: false,
      },
    };
    persist('running');

    currentStage = 'complete';
    evidence.stage = currentStage;
    evidence.status = 'passed';
    persist('passed');
    console.log(JSON.stringify({ok: true, evidence: EVIDENCE, proposalId, recipientDelta: evidence.recipient.delta}, null, 2));
  } catch (error) {
    evidence.error = error.stack || error.message;
    persist('failed');
    throw error;
  } finally {
    if (worker) {
      try { await worker.tearDown(); } catch (error) { console.error(`tearDown failed: ${error.stack || error.message}`); }
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ok: false, evidence: EVIDENCE, stage: evidence.stage, error: error.stack || error.message}, null, 2));
  process.exitCode = 1;
});
