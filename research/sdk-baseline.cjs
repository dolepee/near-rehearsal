'use strict';
/*
 * Independent near-workspaces baseline for Sputnik DAO issue #238.
 *
 * Inputs are the reviewed pinned base artifact and the generated e8262f5a
 * candidate. This script does not import or copy the Rehearsal runner/report
 * checker. It exercises the contract through the published upstream API and
 * records its own evidence.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {Worker, parseNEAR, hashContract} = require('near-workspaces');

const ROOT = path.resolve(__dirname, '..');
const REPAIR = path.join(ROOT, 'case-triage', 'rehearsal-repair');
const BASE = path.join(REPAIR, 'bundle', 'artifacts', 'base.wasm');
const CANDIDATE = path.join(REPAIR, 'generated', 'e8262f5a', 'candidate.wasm');
const PATCH = path.join(REPAIR, 'generated', 'e8262f5a', 'repair.patch');
const IDENTITY = path.join(REPAIR, 'generated', 'e8262f5a', 'candidate-identity.json');
const SOURCE = '/workspace/near-rehearsal/sputnik-dao-contract/sputnikdao2/src/proposals.rs';
const OUT = path.join(ROOT, 'research', 'sdk-baseline-report.json');
const BOND = parseNEAR('1');
const TRANSFER = parseNEAR('0.1');
const GAS = 300_000_000_000_000n;
const ACTION_GAS = 20_000_000_000_000n;
const MISSING = 'missing-target.test.near';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const b64 = (b) => Buffer.from(b).toString('base64');
const json = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2) + '\n';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runtime() {
  const dir = process.env.NEAR_SANDBOX_BIN_PATH;
  if (!dir) throw new Error('NEAR_SANDBOX_BIN_PATH is required');
  const bin = path.join(dir, 'near-sandbox');
  if (!fs.existsSync(bin)) throw new Error(`missing ${bin}`);
  const p = spawnSync(bin, ['--version'], {encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
  const text = `${p.stdout || ''}\n${p.stderr || ''}`;
  const m = text.match(/neard \(release ([^)]+)\).*?commit ([0-9a-f]+).*?\(protocol (\d+)\)/s);
  if (p.status !== 0 || !m) throw new Error(`cannot verify sandbox: ${text}`);
  if (m[1] !== '2.14.0' || m[2] !== 'bc4e9e8cfb03d9e82f027883055624e18576993e') {
    throw new Error(`wrong sandbox version: ${text}`);
  }
  return {version: m[1], commit: m[2], protocol: Number(m[3]), binary: bin,
          wrapperSha256: sha(fs.readFileSync(bin)), targetSha256: sha(fs.readFileSync(fs.realpathSync(bin)))};
}

function local(worker) {
  const rpc = worker.config?.rpcAddr || worker.provider?.connection?.url;
  const host = new URL(rpc).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`non-local RPC: ${rpc}`);
  return rpc;
}

async function finalStatus(worker, tx, sender) {
  const hash = tx?.transactionReceipt?.hash;
  if (!hash) throw new Error('transaction returned no hash');
  const deadline = Date.now() + 90_000;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await worker.provider.sendJsonRpc('tx', {tx_hash: hash, sender_account_id: sender});
      if (value?.final_execution_status === 'FINAL') return {hash, status: value};
      last = value;
    } catch (e) { last = {error: e.message}; }
    await sleep(500);
  }
  throw new Error(`tx ${hash} did not reach FINAL: ${JSON.stringify(last)}`);
}

function summarize(final) {
  const txo = final.status?.transaction_outcome;
  const receipts = (final.status?.receipts_outcome || []).map((r) => ({
    id: r.id,
    parent: r.outcome?.receipt_ids || [],
    executor: r.outcome?.executor_id || null,
    status: r.outcome?.status || null,
    gasBurnt: r.outcome?.gas_burnt?.toString() || '0',
    tokensBurnt: r.outcome?.tokens_burnt?.toString() || '0',
    logs: r.outcome?.logs || [],
  }));
  const txTokens = BigInt(txo?.outcome?.tokens_burnt || 0);
  const receiptTokens = receipts.reduce((n, r) => n + BigInt(r.tokensBurnt), 0n);
  const actions = (final.status?.transaction?.actions || []).map((action) => {
    if (action.DeployContract) {
      const bytes = Buffer.from(action.DeployContract.code || '', 'base64');
      return {DeployContract: {bytes: bytes.length, sha256: sha(bytes)}};
    }
    if (action.FunctionCall) {
      const bytes = Buffer.from(action.FunctionCall.args || '', 'base64');
      return {FunctionCall: {...action.FunctionCall, args: null, argsBytes: bytes.length, argsSha256: sha(bytes)}};
    }
    return action;
  });
  return {
    txHash: final.hash,
    finalExecutionStatus: final.status?.final_execution_status || null,
    transactionOutcomeStatus: txo?.outcome?.status || null,
    succeeded: final.status?.final_execution_status === 'FINAL' && !txo?.outcome?.status?.Failure,
    transactionTokens: txTokens.toString(),
    receiptTokens: receiptTokens.toString(),
    totalGas: (txTokens + receiptTokens).toString(),
    receipts,
    transaction: {
      signer: final.status?.transaction?.signer_id || null,
      receiver: final.status?.transaction?.receiver_id || null,
      actions,
    },
  };
}

async function view(worker, id, method, args = {}) {
  const value = await worker.provider.viewCall(id, method, args, {finality: 'final'});
  if (!value || !Array.isArray(value.result)) throw new Error(`${method} returned no result`);
  return JSON.parse(Buffer.from(value.result).toString('utf8'));
}

async function balance(worker, id) {
  return BigInt((await worker.provider.viewAccount(id, {finality: 'final'})).amount);
}

async function state(worker, id) {
  return (await worker.provider.viewStateRaw(id, '', {finality: 'final'}))
    .map(({key, value}) => ({key, value}))
    .sort((a, b) => a.key.localeCompare(b.key));
}

async function token(worker, id, method) {
  const text = Buffer.from((await worker.provider.viewCall(id, method, {}, {finality: 'final'})).result).toString();
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (value && typeof value.__near_token__ === 'string') return BigInt(value.__near_token__);
  throw new Error(`${method} returned ${text.slice(0, 100)}`);
}

async function snapshot(worker, dao, proposer, recipient, id) {
  const account = await worker.provider.viewAccount(dao.accountId, {finality: 'final'});
  const available = await token(worker, dao.accountId, 'get_available_amount');
  const lockedStorage = await token(worker, dao.accountId, 'get_locked_storage_amount');
  const balanceValue = BigInt(account.amount);
  const stateValue = await state(worker, dao.accountId);
  return {
    codeHash: hashContract(await dao.viewCode()),
    stateHash: sha(JSON.stringify(stateValue)),
    state: stateValue,
    policy: await view(worker, dao.accountId, 'get_policy'),
    proposal: await view(worker, dao.accountId, 'get_proposal', {id}),
    contract: balanceValue.toString(),
    locked: (balanceValue - lockedStorage - available).toString(),
    available: available.toString(),
    lockedStorage: lockedStorage.toString(),
    proposer: (await balance(worker, proposer.accountId)).toString(),
    recipient: (await balance(worker, recipient.accountId)).toString(),
  };
}

async function settle(worker, dao, proposer, recipient) {
  let previous = null;
  let stable = 0;
  for (let i = 0; i < 30; i += 1) {
    const value = {
      contract: (await balance(worker, dao.accountId)).toString(),
      proposer: (await balance(worker, proposer.accountId)).toString(),
      recipient: (await balance(worker, recipient.accountId)).toString(),
      state: sha(JSON.stringify(await state(worker, dao.accountId))),
    };
    const key = JSON.stringify(value);
    if (key === previous) stable += 1; else { stable = 0; previous = key; }
    if (stable >= 3) return value;
    await sleep(500);
  }
  throw new Error('balances did not settle');
}

async function init(worker) {
  const root = worker.rootAccount;
  const proposer = await root.createSubAccount('proposer', {initialBalance: parseNEAR('100')});
  const recipient = await root.createSubAccount('recipient', {initialBalance: parseNEAR('10')});
  const dao = await root.createSubAccount('dao', {initialBalance: parseNEAR('100')});
  const base = fs.readFileSync(BASE);
  const deploy = summarize(await finalStatus(worker, await dao.deploy(base), root.accountId));
  const call = await root.callRaw(dao, 'new', {
    config: {name: 'sdk-baseline', purpose: 'independent issue 238 comparison', metadata: ''},
    policy: [proposer.accountId],
  }, {gas: GAS});
  const initFinal = summarize(await finalStatus(worker, call, root.accountId));
  for (let i = 0; i < 40; i += 1) {
    try { await view(worker, dao.accountId, 'get_policy'); break; } catch { await sleep(250); }
  }
  return {root, proposer, recipient, dao, deploy, init: initFinal};
}

async function proposal(worker, dao, proposer, kind, label, deposit = BOND) {
  const added = await proposer.callRaw(dao, 'add_proposal', {proposal: {description: label, kind}},
    {gas: GAS, attachedDeposit: deposit});
  const addFinal = summarize(await finalStatus(worker, added, proposer.accountId));
  return {id: added.parseResult(), addFinal};
}

async function waitProposal(worker, dao, id) {
  const deadline = Date.now() + 90_000;
  let value;
  while (Date.now() < deadline) {
    value = await view(worker, dao.accountId, 'get_proposal', {id});
    if (value.status !== 'InProgress') return value;
    await sleep(500);
  }
  return value;
}

async function upgrade(worker, dao, candidate) {
  const deploy = summarize(await finalStatus(worker, await dao.deploy(candidate), dao.accountId));
  const migrate = summarize(await finalStatus(worker, await dao.callRaw(dao, 'migrate', {}, {gas: GAS}), dao.accountId));
  const expected = hashContract(candidate);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (hashContract(await dao.viewCode()) === expected) break;
    await sleep(250);
  }
  return {deploy, migrate, codeHash: hashContract(await dao.viewCode())};
}

async function recovery(worker, candidate) {
  const base = await init(worker);
  const kind = {FunctionCall: {receiver_id: MISSING, actions: [{method_name: 'ping', args: '', deposit: '0', gas: ACTION_GAS.toString()}]}};
  const created = await proposal(worker, base.dao, base.proposer, kind, 'failed old-code proposal');
  const id = created.id;
  const vote = await base.proposer.callRaw(base.dao, 'act_proposal', {id, action: 'VoteApprove', proposal: kind}, {gas: GAS});
  const voteFinal = summarize(await finalStatus(worker, vote, base.proposer.accountId));
  const failed = await waitProposal(worker, base.dao, id);
  await settle(worker, base.dao, base.proposer, base.recipient);
  const frozen = await snapshot(worker, base.dao, base.proposer, base.recipient, id);
  const up = await upgrade(worker, base.dao, candidate);
  const afterUpgrade = await snapshot(worker, base.dao, base.proposer, base.recipient, id);
  const firstTx = await base.proposer.callRaw(base.dao, 'act_proposal', {id, action: 'Finalize', proposal: kind}, {gas: GAS});
  const firstFinal = summarize(await finalStatus(worker, firstTx, base.proposer.accountId));
  const firstProposal = await waitProposal(worker, base.dao, id);
  await settle(worker, base.dao, base.proposer, base.recipient);
  const first = await snapshot(worker, base.dao, base.proposer, base.recipient, id);
  const secondTx = await base.proposer.callRaw(base.dao, 'act_proposal', {id, action: 'Finalize', proposal: kind}, {gas: GAS});
  const secondFinal = summarize(await finalStatus(worker, secondTx, base.proposer.accountId));
  const secondProposal = await waitProposal(worker, base.dao, id);
  await settle(worker, base.dao, base.proposer, base.recipient);
  const second = await snapshot(worker, base.dao, base.proposer, base.recipient, id);
  return {
    base: {deploy: base.deploy, init: base.init, proposer: base.proposer.accountId,
           recipient: base.recipient.accountId, dao: base.dao.accountId},
    proposalId: id,
    add: created.addFinal,
    vote: voteFinal,
    failedProposal: failed,
    frozen,
    upgrade: up,
    afterUpgrade,
    first: {final: firstFinal, proposal: firstProposal, before: afterUpgrade, after: first,
      delta: {
        contract: (BigInt(first.contract) - BigInt(afterUpgrade.contract)).toString(),
        proposer: (BigInt(first.proposer) - BigInt(afterUpgrade.proposer)).toString(),
        recipient: (BigInt(first.recipient) - BigInt(afterUpgrade.recipient)).toString(),
        locked: (BigInt(first.locked) - BigInt(afterUpgrade.locked)).toString(),
      }},
    second: {final: secondFinal, proposal: secondProposal, before: first, after: second,
      delta: {
        contract: (BigInt(second.contract) - BigInt(first.contract)).toString(),
        proposer: (BigInt(second.proposer) - BigInt(first.proposer)).toString(),
        recipient: (BigInt(second.recipient) - BigInt(first.recipient)).toString(),
        locked: (BigInt(second.locked) - BigInt(first.locked)).toString(),
      }},
  };
}

async function healthyControls(worker, candidate) {
  const base = await init(worker);
  const kind = {Transfer: {token_id: '', receiver_id: base.recipient.accountId,
                           amount: TRANSFER.toString(), msg: null}};

  const paid = await proposal(worker, base.dao, base.proposer, kind, 'already-paid healthy transfer');
  const paidVote = await base.proposer.callRaw(base.dao, 'act_proposal', {id: paid.id, action: 'VoteApprove', proposal: kind}, {gas: GAS});
  const paidVoteFinal = summarize(await finalStatus(worker, paidVote, base.proposer.accountId));
  const paidProposal = await waitProposal(worker, base.dao, paid.id);
  await settle(worker, base.dao, base.proposer, base.recipient);
  const paidSnapshot = await snapshot(worker, base.dao, base.proposer, base.recipient, paid.id);

  const pending = await proposal(worker, base.dao, base.proposer, kind, 'inherited unpaid healthy transfer');
  const pendingBefore = await snapshot(worker, base.dao, base.proposer, base.recipient, pending.id);

  const up = await upgrade(worker, base.dao, candidate);
  const paidAfterUpgrade = await snapshot(worker, base.dao, base.proposer, base.recipient, paid.id);
  const pendingAfterUpgrade = await snapshot(worker, base.dao, base.proposer, base.recipient, pending.id);

  const paidFinalizeTx = await base.proposer.callRaw(base.dao, 'act_proposal', {id: paid.id, action: 'Finalize', proposal: kind}, {gas: GAS});
  const paidFinalize = summarize(await finalStatus(worker, paidFinalizeTx, base.proposer.accountId));
  await settle(worker, base.dao, base.proposer, base.recipient);
  const paidAfterFinalize = await snapshot(worker, base.dao, base.proposer, base.recipient, paid.id);

  const pendingVote = await base.proposer.callRaw(base.dao, 'act_proposal', {id: pending.id, action: 'VoteApprove', proposal: kind}, {gas: GAS});
  const pendingVoteFinal = summarize(await finalStatus(worker, pendingVote, base.proposer.accountId));
  const pendingProposal = await waitProposal(worker, base.dao, pending.id);
  await settle(worker, base.dao, base.proposer, base.recipient);
  const pendingAfter = await snapshot(worker, base.dao, base.proposer, base.recipient, pending.id);

  return {
    base: {deploy: base.deploy, init: base.init, proposer: base.proposer.accountId,
           recipient: base.recipient.accountId, dao: base.dao.accountId},
    paid: {id: paid.id, add: paid.addFinal, vote: paidVoteFinal, proposal: paidProposal,
           snapshot: paidSnapshot, afterUpgrade: paidAfterUpgrade,
           finalize: paidFinalize, afterFinalize: paidAfterFinalize},
    pending: {id: pending.id, add: pending.addFinal, beforeUpgrade: pendingBefore,
              afterUpgrade: pendingAfterUpgrade, vote: pendingVoteFinal,
              proposal: pendingProposal, after: pendingAfter},
    upgrade: up,
    checks: {
      paidStayedPaid: paidProposal.status === 'Approved'
        && paidAfterUpgrade.recipient === paidSnapshot.recipient
        && paidAfterFinalize.recipient === paidSnapshot.recipient,
      pendingPreserved: pendingAfterUpgrade.codeHash === up.codeHash
        && JSON.stringify(pendingAfterUpgrade.proposal) === JSON.stringify(pendingBefore.proposal)
        && pendingAfterUpgrade.locked === pendingBefore.locked,
      pendingPaidOnce: (BigInt(pendingAfter.recipient) - BigInt(pendingAfterUpgrade.recipient)).toString() === TRANSFER.toString()
        && pendingProposal.status === 'Approved',
      pendingBondReturned: (BigInt(pendingAfter.proposer) - BigInt(pendingAfterUpgrade.proposer)
        + BigInt(pendingVoteFinal.totalGas) + BigInt(paidFinalize.totalGas)).toString() === BOND.toString(),
    },
  };
}

(async () => {
  const candidate = fs.readFileSync(CANDIDATE);
  const base = fs.readFileSync(BASE);
  const identity = JSON.parse(fs.readFileSync(IDENTITY, 'utf8'));
  if (sha(candidate) !== '49a5120cee5f4e453a37e40b18231ce9b0fef95c08dca4fdbf23f102937eb923') throw new Error('candidate hash mismatch');
  if (sha(base) !== '5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578') throw new Error('base hash mismatch');
  if (sha(fs.readFileSync(PATCH)) !== identity.patch.sha256) throw new Error('patch hash mismatch');
  const sourceSha = sha(fs.readFileSync(SOURCE));
  if (identity.wasm.sha256 !== sha(candidate)) throw new Error('identity candidate mismatch');
  const rt = runtime();
  process.env.NEAR_SANDBOX_BIN_PATH = path.dirname(rt.binary);
  process.env.NEAR_SANDBOX_BINARY_PATH = path.dirname(rt.binary);
  const worker = await Worker.init({network: 'sandbox'});
  const report = {schema: 'near-rehearsal/sdk-baseline/v1', generatedAt: new Date().toISOString(),
    runtime: rt, identity: {sourceCommit: identity.source.commit, sourceSha256: identity.source.sha256,
      sourceFileSha256: sourceSha, sourceHashMatches: sourceSha === identity.source.sha256,
      baseSha256: sha(base), candidateSha256: sha(candidate), patchSha256: sha(fs.readFileSync(PATCH)),
      candidateWasmHash: hashContract(candidate), baseWasmHash: hashContract(base)},
    rpc: local(worker)};
  try {
    report.recovery = await recovery(worker, candidate);
    const healthyWorker = await Worker.init({network: 'sandbox'});
    try { report.controls = await healthyControls(healthyWorker, candidate); }
    finally { await healthyWorker.tearDown(); }
    report.checks = {
      firstRecoveredOneBond: report.recovery.first.delta.locked === `-${BOND}`,
      secondDidNotRecoverAgain: report.recovery.second.delta.locked === '0',
      noTargetPayment: report.recovery.first.delta.recipient === '0' && report.recovery.second.delta.recipient === '0',
      firstProposerDeltaPlusGas: (BigInt(report.recovery.first.delta.proposer) + BigInt(report.recovery.first.final.totalGas)).toString() === BOND.toString(),
      secondProposerDeltaPlusGas: (BigInt(report.recovery.second.delta.proposer) + BigInt(report.recovery.second.final.totalGas)).toString() === '0',
      codeIdentity: report.recovery.upgrade.codeHash === hashContract(candidate),
      controls: report.controls.checks,
    };
  } finally { await worker.tearDown(); }
  fs.writeFileSync(OUT, json(report));
  console.log(json(report));
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
