'use strict';
/*
 * Bounded source-built reproduction for near-daos/sputnik-dao-contract#238.
 * Deploys the pinned source build, creates one failed async FunctionCall and one
 * healthy Transfer control from equivalent local state, and records raw receipts.
 * This is a local sandbox run; it does not touch public state.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, KeyPair, parseNEAR, hashContract } = require('near-workspaces');

const HERE = __dirname;
const OUT = path.resolve(process.env.SPUTNIK_OUT_DIR || path.join(HERE, 'out', `issue238-${Date.now()}`));
const WASM = path.resolve(process.env.SPUTNIK_WASM || path.join(HERE, '..', '..', '..', 'sputnik-dao-contract', 'target', 'wasm32-unknown-unknown', 'release', 'sputnikdao2.wasm'));
const GAS = 300_000_000_000_000n;
const ACTION_GAS = 20_000_000_000_000n;
const BOND = parseNEAR('1');
const TRANSFER = parseNEAR('0.1');
const DAO_ID = 'dao.test.near';
const PROPOSER_ID = 'proposer.test.near';
const RECIPIENT_ID = 'recipient.test.near';
const MAX_WAIT_MS = 90_000;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (b) => Buffer.from(b).toString('base64');
const json = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);
fs.mkdirSync(OUT, { recursive: true });

function assertLocal(worker) {
  const rpc = worker.config?.rpcAddr || worker.provider?.connection?.url;
  const host = new URL(rpc).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`refusing non-local RPC: ${rpc}`);
  return rpc;
}
async function finalStatus(worker, tx, sender) {
  const hash = tx?.transactionReceipt?.hash;
  if (!hash) throw new Error('transaction has no hash');
  const started = Date.now();
  let last;
  while (Date.now() - started < MAX_WAIT_MS) {
    try {
      const status = await worker.provider.sendJsonRpc('tx', { tx_hash: hash, sender_account_id: sender });
      if (status?.final_execution_status === 'FINAL') return { status, hash };
      last = status;
    } catch (e) { last = { error: e.message }; }
    await sleep(500);
  }
  throw new Error(`tx ${hash} did not reach FINAL: ${JSON.stringify(last)}`);
}
function summarize(final) {
  const txo = final?.status?.transaction_outcome;
  const receipts = (final?.status?.receipts_outcome || []).map((r) => ({
    id: r.id,
    receiptIds: r.outcome?.receipt_ids ?? [],
    executorId: r.outcome?.executor_id ?? null,
    status: r.outcome?.status ?? null,
    gasBurntUnits: r.outcome?.gas_burnt?.toString() ?? null,
    tokensBurntYocto: r.outcome?.tokens_burnt?.toString() ?? null,
    logs: r.outcome?.logs ?? [],
  }));
  const txTokens = BigInt(txo?.outcome?.tokens_burnt ?? 0);
  const receiptTokens = receipts.reduce((n, r) => n + BigInt(r.tokensBurntYocto ?? 0), 0n);
  return {
    transactionHash: final?.hash ?? null,
    succeeded: final?.status?.final_execution_status === 'FINAL' && !final?.status?.transaction_outcome?.outcome?.status?.Failure,
    transactionOutcomeStatus: txo?.outcome?.status ?? null,
    transactionOutcomeGasBurnt: txo?.outcome?.gas_burnt?.toString() ?? null,
    transactionOutcomeTokensBurntYocto: txTokens.toString(),
    receiptTokensBurntYocto: receiptTokens.toString(),
    totalTokensBurntYocto: (txTokens + receiptTokens).toString(),
    receipts,
    transaction: {
      signerId: final?.status?.transaction?.signer_id ?? null,
      receiverId: final?.status?.transaction?.receiver_id ?? null,
      actions: final?.status?.transaction?.actions ?? [],
    },
  };
}
async function viewJson(worker, id, method, args = {}) {
  const r = await worker.provider.viewCall(id, method, args, { finality: 'final' });
  if (!r || !Array.isArray(r.result)) throw new Error(`${method} returned no result`);
  return JSON.parse(Buffer.from(r.result).toString('utf8'));
}
async function viewAmount(worker, id) {
  return (await worker.provider.viewAccount(id, { finality: 'final' })).amount;
}
async function readState(worker, id) {
  return (await worker.provider.viewStateRaw(id, '', { finality: 'final' }))
    .map(({ key, value }) => ({ key, value }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
const stateHash = (items) => sha256(JSON.stringify(items));

async function initWorker() {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await Worker.init({ network: 'sandbox' }); }
    catch (e) { last = e; await sleep(2000); }
  }
  throw last;
}

async function runBranch(worker, label, inputKind) {
  const root = worker.rootAccount;
  const suffix = label.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const proposer = await root.createSubAccount(`proposer-${suffix}`, { initialBalance: parseNEAR('100') });
  const recipient = await root.createSubAccount(`recipient-${suffix}`, { initialBalance: parseNEAR('10') });
  const dao = await root.createSubAccount(`dao-${suffix}`, { initialBalance: parseNEAR('100') });
  const kind = inputKind.Transfer
    ? { ...inputKind, Transfer: { ...inputKind.Transfer, receiver_id: recipient.accountId } }
    : inputKind;
  const wasm = fs.readFileSync(WASM);
  const deploy = await dao.deploy(wasm);
  const deployFinal = await finalStatus(worker, deploy, root.accountId);
  const init = await root.callRaw(dao, 'new', {
    config: { name: 'issue238', purpose: 'bounded local source-built reproduction', metadata: '' },
    policy: [proposer.accountId],
  }, { gas: GAS });
  await finalStatus(worker, init, root.accountId);
  for (let i = 0; i < 40; i++) {
    try { await viewJson(worker, dao.accountId, 'get_policy'); break; } catch { await sleep(250); }
  }

  const before = {
    contract: await viewAmount(worker, dao.accountId),
    proposer: await viewAmount(worker, proposer.accountId),
    recipient: await viewAmount(worker, recipient.accountId),
    state: await readState(worker, dao.accountId),
    policy: await viewJson(worker, dao.accountId, 'get_policy'),
  };

  const add = await proposer.callRaw(dao, 'add_proposal', {
    proposal: { description: `${label} proposal`, kind },
  }, { gas: GAS, attachedDeposit: BOND });
  const addFinal = await finalStatus(worker, add, proposer.accountId);
  const proposalId = add.parseResult();
  const afterAdd = {
    contract: await viewAmount(worker, dao.accountId),
    proposer: await viewAmount(worker, proposer.accountId),
    recipient: await viewAmount(worker, recipient.accountId),
    proposal: await viewJson(worker, dao.accountId, 'get_proposal', { id: proposalId }),
  };

  const vote = await proposer.callRaw(dao, 'act_proposal', {
    id: proposalId,
    action: 'VoteApprove',
    proposal: kind,
  }, { gas: GAS });
  const voteFinal = await finalStatus(worker, vote, proposer.accountId);
  // The callback is a separate receipt; wait for the proposal to leave InProgress.
  let proposal;
  let deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    proposal = await viewJson(worker, dao.accountId, 'get_proposal', { id: proposalId });
    if (proposal.status !== 'InProgress') break;
    await sleep(500);
  }
  const after = {
    contract: await viewAmount(worker, dao.accountId),
    proposer: await viewAmount(worker, proposer.accountId),
    recipient: await viewAmount(worker, recipient.accountId),
    state: await readState(worker, dao.accountId),
    policy: await viewJson(worker, dao.accountId, 'get_policy'),
    proposal,
  };
  return {
    label,
    kind,
    contractId: dao.accountId,
    proposerId: proposer.accountId,
    recipientId: recipient.accountId,
    artifacts: { wasmSha256: sha256(wasm), wasmHash: hashContract(wasm), wasmBytes: wasm.length },
    deploy: { final: deployFinal.status?.final_execution_status, summary: summarize(deployFinal) },
    add: { proposalId, final: addFinal.status?.final_execution_status, summary: summarize(addFinal) },
    vote: { final: voteFinal.status?.final_execution_status, summary: summarize(voteFinal) },
    before,
    afterAdd,
    after,
    deltas: {
      contract: (BigInt(after.contract) - BigInt(before.contract)).toString(),
      proposer: (BigInt(after.proposer) - BigInt(before.proposer)).toString(),
      recipient: (BigInt(after.recipient) - BigInt(before.recipient)).toString(),
    },
    stateChanged: stateHash(before.state) !== stateHash(after.state),
    bondDeclaredYocto: BOND.toString(),
    transferDeclaredYocto: kind.Transfer ? TRANSFER.toString() : '0',
  };
}

(async () => {
  const worker = await initWorker();
  try {
    assertLocal(worker);
    const root = worker.rootAccount;
    const failedKind = {
      FunctionCall: {
        receiver_id: 'missing-target.test.near',
        actions: [{ method_name: 'ping', args: '', deposit: '0', gas: ACTION_GAS.toString() }],
      },
    };
    const healthyKind = {
      Transfer: { token_id: '', receiver_id: RECIPIENT_ID, amount: TRANSFER.toString(), msg: null },
    };
    // Healthy first, then failed, to keep each branch's starting state separate.
    const healthy = await runBranch(worker, 'healthy-control', healthyKind);
    const failed = await runBranch(worker, 'failed-async', failedKind);
    const report = {
      schema: 'near-rehearsal/issue238-local/v1',
      generatedAt: new Date().toISOString(),
      source: {
        repository: 'https://github.com/near-daos/sputnik-dao-contract',
        commit: process.env.SPUTNIK_SOURCE_SHA || '5434a59dec23ee0c49df8c8c4350c208a7e75b0b',
        issue: 'https://github.com/near-daos/sputnik-dao-contract/issues/238',
        wasmSha256: sha256(fs.readFileSync(WASM)),
        wasmHash: hashContract(fs.readFileSync(WASM)),
      },
      runtime: { nearWorkspaces: require('near-workspaces/package.json').version, sandbox: process.env.NEAR_SANDBOX_VERSION || '2.6.2', rpc: assertLocal(worker) },
      healthy,
      failed,
      conclusion: {
        failedStatus: failed.after.proposal?.status ?? null,
        failedContractDelta: failed.deltas.contract,
        failedProposerDelta: failed.deltas.proposer,
        failedBondDeclared: BOND.toString(),
        healthyStatus: healthy.after.proposal?.status ?? null,
        healthyContractDelta: healthy.deltas.contract,
        healthyProposerDelta: healthy.deltas.proposer,
      },
    };
    fs.writeFileSync(path.join(OUT, 'issue238-local.json'), json(report));
    console.log(json(report));
  } finally {
    await worker.tearDown?.().catch(() => {});
  }
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
