'use strict';
/*
 * Pilot-only Node harness for Sputnik #226.
 *
 * Thin, single-case runner. It does not alter the Rehearsal app or claim a
 * generic adapter. The old DAO state is locally constructed, not captured
 * mainnet state.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {Worker, parseNEAR} = require('near-workspaces');

const GAS = 100_000_000_000_000n;
const near = (value) => BigInt(parseNEAR(value));
const TRANSFER = near('1');
const EVIDENCE = path.resolve(process.env.EVIDENCE_PATH || 'case-triage/sputnik-226/evidence.json');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
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

async function main() {
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

  let worker;
  try {
    worker = await Worker.init({network: 'sandbox'});
    assertLocal(worker);
    const root = worker.rootAccount;
    const dao = await root.createSubAccount('pilot-dao', {initialBalance: near('100')});
    const recipient = await root.createSubAccount('pilot-recipient', {initialBalance: near('1')});
    await dao.deploy(baseWasm);

    const initTx = await dao.callRaw(dao, 'new', {
      config: {name: 'pilot', purpose: 'locally constructed old-proposal upgrade pilot', metadata: ''},
      policy: [root.accountId],
    }, {gas: GAS});
    assertSuccess(initTx, 'init');

    const configBefore = await viewJson(worker, dao.accountId, 'get_config');
    const transferKind = {
      Transfer: {token_id: '', receiver_id: recipient.accountId, amount: TRANSFER.toString(), msg: null},
    };
    const addTx = await root.callRaw(dao, 'add_proposal', {
      proposal: {description: 'pre-upgrade transfer proposal', kind: transferKind},
    }, {gas: GAS, attachedDeposit: TRANSFER});
    assertSuccess(addTx, 'add_proposal');
    const proposalId = addTx.parseResult();
    if (!Number.isSafeInteger(Number(proposalId))) throw new Error(`unsafe proposal id: ${proposalId}`);

    const before = await viewJson(worker, dao.accountId, 'get_proposal', {id: Number(proposalId)});
    assert.equal(before.status, 'InProgress', 'old proposal must be InProgress');
    assert.equal(before.kind?.Transfer?.receiver_id, recipient.accountId, 'old proposal receiver mismatch');
    assert.equal(Object.prototype.hasOwnProperty.call(before, 'last_actions_log'), false, 'old schema unexpectedly has last_actions_log');
    const recipientBefore = await viewAmount(worker, recipient.accountId);

    // Contract::call-style self-update: sign as the DAO and target its own account.
    // update() deploys the candidate, then calls migrate() in the same promise chain.
    const updateTx = await dao.callRaw(dao, 'update', candidateWasm, {gas: GAS});
    assertSuccess(updateTx, 'update');

    const rawCode = await worker.provider.viewCodeRaw(dao.accountId, {finality: 'final'});
    const code = Buffer.isBuffer(rawCode) ? rawCode : Buffer.from(rawCode, 'base64');
    assert.equal(Buffer.compare(code, candidateWasm), 0, 'candidate code bytes mismatch');

    const after = await viewJson(worker, dao.accountId, 'get_proposal', {id: Number(proposalId)});
    assert.equal(after.status, 'InProgress', 'post-upgrade proposal status changed unexpectedly');
    const configAfter = await viewJson(worker, dao.accountId, 'get_config');
    assert.deepEqual(configAfter, configBefore, 'get_config changed across upgrade');

    const approveTx = await root.callRaw(dao, 'act_proposal', {
      id: Number(proposalId), action: 'VoteApprove', proposal: transferKind,
    }, {gas: GAS});
    assertSuccess(approveTx, 'act_proposal');

    const finalProposal = await viewJson(worker, dao.accountId, 'get_proposal', {id: Number(proposalId)});
    assert.equal(finalProposal.status, 'Approved', 'proposal was not approved');
    assert.equal(finalProposal.votes?.[root.accountId], 'Approve', 'root vote did not persist');

    const recipientAfter = await viewAmount(worker, recipient.accountId);
    assert.equal(recipientAfter - recipientBefore, TRANSFER, 'recipient balance did not increase by transfer amount');

    const evidence = {
      schema: 'near-rehearsal/pilot/sputnik-226-node-evidence/v1',
      state: 'locally constructed; not captured public-chain state',
      inputs: {
        baseWasm: path.resolve(basePath), baseSha256: sha256(baseWasm),
        candidateWasm: path.resolve(candidatePath), candidateSha256: sha256(candidateWasm),
      },
      contract: dao.accountId,
      proposalId,
      configBefore,
      configAfter,
      proposalBefore: before,
      proposalAfter: finalProposal,
      recipient: {
        accountId: recipient.accountId,
        before: recipientBefore.toString(),
        after: recipientAfter.toString(),
        delta: (recipientAfter - recipientBefore).toString(),
      },
      transactions: {
        init: initTx.result,
        addProposal: addTx.result,
        update: updateTx.result,
        approve: approveTx.result,
      },
    };
    fs.mkdirSync(path.dirname(EVIDENCE), {recursive: true});
    fs.writeFileSync(EVIDENCE, json(evidence) + '\n');
    console.log(JSON.stringify({ok: true, evidence: EVIDENCE, proposalId, recipientDelta: evidence.recipient.delta}, null, 2));
  } finally {
    if (worker) await worker.tearDown();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ok: false, error: error.stack || error.message}, null, 2));
  process.exitCode = 1;
});
