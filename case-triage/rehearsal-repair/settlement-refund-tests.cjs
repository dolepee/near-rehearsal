'use strict';
/*
 * Local-chain settlement regression for the #238 repair.
 *
 * The proposal is created by the candidate (so its original bond is recorded),
 * then the proposer account is deleted before the failed action's callback.
 * The refund transfer therefore fails. The debt must remain locked; after the
 * proposer is recreated and the proposal is finalised again, exactly one bond
 * must be paid, and a further finalise must not pay a second time.
 *
 * usage: NEAR_SANDBOX_BIN_PATH=/workspace/tools/near-sandbox-2.14-wrapper \
 *   node settlement-refund-tests.cjs --wasm <candidate.wasm> --out <dir>
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {Worker, parseNEAR, hashContract} = require('near-workspaces');

const BOND = BigInt(parseNEAR('1'));
const GAS = 300_000_000_000_000n;
const ACTION_GAS = 20_000_000_000_000n;
const MAX_WAIT_MS = 90_000;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const json = (v) => `${JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2)}\n`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stage = (name) => process.stderr.write(`[settlement] ${name}\n`);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--wasm') opts.wasm = path.resolve(argv[++i]);
    else if (argv[i] === '--base-wasm') opts.baseWasm = path.resolve(argv[++i]);
    else if (argv[i] === '--out') opts.out = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!opts.wasm || !opts.out) throw new Error('--wasm and --out are required');
  return opts;
}

function runtime() {
  const dir = process.env.NEAR_SANDBOX_BIN_PATH || process.env.NEAR_SANDBOX_BINARY_PATH;
  if (!dir) throw new Error('NEAR_SANDBOX_BIN_PATH is required');
  const binary = path.join(dir, 'near-sandbox');
  if (!fs.existsSync(binary)) throw new Error(`Sandbox binary missing: ${binary}`);
  const result = spawnSync(binary, ['--version'], {encoding: 'utf8', timeout: 30_000});
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const match = output.match(/neard \(release ([^)]+)\).*?commit ([0-9a-f]+).*?\(protocol (\d+)\)/s);
  if (result.status !== 0 || !match) throw new Error(`cannot verify Sandbox runtime: ${output}`);
  if (match[1] !== '2.14.0') throw new Error(`expected Sandbox 2.14.0, got ${match[1]}`);
  return {version: match[1], commit: match[2], protocol: Number(match[3]), binary, versionOutput: output};
}

function assertLocal(worker) {
  const rpc = worker.config?.rpcAddr || worker.provider?.connection?.url;
  const host = new URL(rpc).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`refusing non-local RPC: ${rpc}`);
}

async function finalStatus(worker, tx, sender) {
  const hash = tx?.transactionReceipt?.hash || tx?.transaction?.hash;
  if (!hash) throw new Error('transaction has no hash');
  const started = Date.now();
  let last;
  while (Date.now() - started < MAX_WAIT_MS) {
    try {
      const status = await worker.provider.sendJsonRpc('tx', {tx_hash: hash, sender_account_id: sender});
      if (status?.final_execution_status === 'FINAL') return {status, hash};
      last = status;
    } catch (error) { last = {error: error.message}; }
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
    logs: r.outcome?.logs ?? [],
    tokensBurntYocto: r.outcome?.tokens_burnt?.toString() ?? '0',
  }));
  return {
    transactionHash: final?.hash ?? null,
    finalExecutionStatus: final?.status?.final_execution_status ?? null,
    transactionOutcome: {
      status: txo?.outcome?.status ?? null,
      tokensBurntYocto: txo?.outcome?.tokens_burnt?.toString() ?? '0',
      receiptIds: txo?.outcome?.receipt_ids ?? [],
    },
    receipts,
    transaction: {
      signerId: final?.status?.transaction?.signer_id ?? null,
      receiverId: final?.status?.transaction?.receiver_id ?? null,
      actions: final?.status?.transaction?.actions ?? [],
    },
  };
}

async function viewJson(worker, id, method, args = {}, blockId = null) {
  const result = await worker.provider.viewCall(id, method, args, blockId ? {blockId} : {finality: 'final'});
  if (!result || !Array.isArray(result.result)) throw new Error(`${method} returned no result`);
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

async function viewAmount(worker, id) {
  let last;
  for (let i = 0; i < 10; i += 1) {
    try { return (await worker.provider.viewAccount(id, {finality: 'final'})).amount; }
    catch (error) { last = error; await sleep(500); }
  }
  throw last;
}

async function snapshot(worker, dao, proposerId, voter) {
  const block = await worker.provider.sendJsonRpc('block', {finality: 'final'});
  const blockId = block?.header?.hash;
  const account = await worker.provider.viewAccount(dao.accountId, {blockId});
  const available = await worker.provider.viewCall(dao.accountId, 'get_available_amount', {}, {blockId});
  const lockedStorage = await worker.provider.viewCall(dao.accountId, 'get_locked_storage_amount', {}, {blockId});
  const proposal = await viewJson(worker, dao.accountId, 'get_proposal', {id: 0}, blockId);
  const balance = BigInt(account.amount);
  return {
    blockHash: blockId,
    blockHeight: block.header.height,
    contractBalance: account.amount,
    lockedStorageAmount: (() => {
      const text = Buffer.from(lockedStorage.result).toString('utf8');
      try { const value = JSON.parse(text); return value?.__near_token__ || value?.amount || value; } catch { return text; }
    })(),
    availableAmount: (() => {
      const text = Buffer.from(available.result).toString('utf8');
      try { const value = JSON.parse(text); return value?.__near_token__ || value?.amount || value; } catch { return text; }
    })(),
    lockedAmount: (() => {
      const avail = JSON.parse(Buffer.from(available.result).toString('utf8'));
      const storage = JSON.parse(Buffer.from(lockedStorage.result).toString('utf8'));
      const a = BigInt(avail.__near_token__ || avail.amount || avail);
      const s = BigInt(storage.__near_token__ || storage.amount || storage);
      return (balance - s - a).toString();
    })(),
    proposal,
    proposer: await viewAmount(worker, proposerId).catch(() => null),
    voter: voter ? await viewAmount(worker, voter).catch(() => null) : null,
  };
}

async function waitProposal(worker, dao, id, terminal) {
  const deadline = Date.now() + MAX_WAIT_MS;
  let proposal;
  while (Date.now() < deadline) {
    proposal = await viewJson(worker, dao.accountId, 'get_proposal', {id});
    if (proposal.status === terminal) return proposal;
    await sleep(300);
  }
  return proposal;
}

async function settle(worker, dao, proposerId, voter) {
  let last = null;
  let stable = 0;
  for (let i = 0; i < 24; i += 1) {
    const snap = await snapshot(worker, dao, proposerId, voter);
    const key = JSON.stringify({locked: snap.lockedAmount, balance: snap.contractBalance, proposer: snap.proposer, status: snap.proposal.status, receipts: snap.proposal.last_actions_log?.length});
    if (key === last) stable += 1; else { stable = 0; last = key; }
    if (stable >= 3) return snap;
    await sleep(500);
  }
  return snapshot(worker, dao, proposerId, voter);
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const rt = runtime();
  process.env.NEAR_SANDBOX_BIN_PATH = path.dirname(rt.binary);
  process.env.NEAR_SANDBOX_BINARY_PATH = path.dirname(rt.binary);
  process.env.NEAR_SANDBOX_VERSION = rt.version;
  const wasm = fs.readFileSync(opts.wasm);
  const baseWasm = opts.baseWasm ? fs.readFileSync(opts.baseWasm) : null;
  const errors = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  const worker = await Worker.init({network: 'sandbox'});
  try {
    assertLocal(worker);
    const root = worker.rootAccount;
    const proposer = await root.createSubAccount('proposer', {initialBalance: parseNEAR('20')});
    const voter = await root.createSubAccount('voter', {initialBalance: parseNEAR('20')});
    const dao = await root.createSubAccount('dao', {initialBalance: parseNEAR('100')});
    stage('deploy');
    const deploy = await dao.deploy(baseWasm || wasm);
    const deployFinal = summarize(await finalStatus(worker, deploy, root.accountId));
    const init = await root.callRaw(dao, 'new', {
      config: {name: 'settlement', purpose: 'bounded refund settlement', metadata: ''},
      policy: [voter.accountId],
    }, {gas: GAS});
    const initFinal = summarize(await finalStatus(worker, init, root.accountId));

    const kind = {FunctionCall: {receiver_id: 'missing-target.test.near', actions: [{method_name: 'ping', args: '', deposit: '0', gas: ACTION_GAS.toString()}]}};
    stage('add');
    const add = await proposer.callRaw(dao, 'add_proposal', {proposal: {description: 'deleted proposer refund', kind}}, {gas: GAS, attachedDeposit: BOND.toString()});
    const addFinal = summarize(await finalStatus(worker, add, proposer.accountId));
    const id = add.parseResult();
    let upgrade = null;
    let deleteFinal;
    if (!baseWasm) {
      stage('delete proposer');
      const deleted = await proposer.delete(root.accountId);
      deleteFinal = {transactionHash: deleted?.transactionReceipt?.hash || null, transactionOutcome: {status: 'DeleteAccount submitted'}};
    }
    stage('vote');
    const vote = await voter.callRaw(dao, 'act_proposal', {id, action: 'VoteApprove', proposal: kind}, {gas: GAS});
    const voteFinal = summarize(await finalStatus(worker, vote, voter.accountId));
    await waitProposal(worker, dao, id, 'Failed');
    if (baseWasm) {
      stage('upgrade candidate');
      const codeHash = hashContract(wasm);
      const upgradeDeploy = await dao.deploy(wasm);
      const upgradeDeployFinal = summarize(await finalStatus(worker, upgradeDeploy, root.accountId));
      const migrate = await dao.callRaw(dao, 'migrate', {}, {gas: GAS});
      const migrateFinal = summarize(await finalStatus(worker, migrate, root.accountId));
      for (let i = 0; i < 40; i += 1) {
        const code = await dao.viewCode();
        if (code?.length && hashContract(code) === codeHash) break;
        await sleep(250);
      }
      upgrade = {deploy: upgradeDeployFinal, migrate: migrateFinal, codeHash};
      stage('delete proposer');
      const deleted = await proposer.delete(root.accountId);
      deleteFinal = {transactionHash: deleted?.transactionReceipt?.hash || null, transactionOutcome: {status: 'DeleteAccount submitted'}};
      stage('legacy finalize while deleted');
      const legacyFinalize = await voter.callRaw(dao, 'act_proposal', {id, action: 'Finalize', proposal: kind}, {gas: GAS});
      const legacyFinalizeFinal = summarize(await finalStatus(worker, legacyFinalize, voter.accountId));
      await waitProposal(worker, dao, id, 'Failed');
      upgrade.legacyFinalize = legacyFinalizeFinal;
    }
    const failedRefund = await settle(worker, dao, proposer.accountId, voter.accountId);
    require(failedRefund.lockedAmount === BOND.toString(), `locked liability after failed refund is ${failedRefund.lockedAmount}, expected ${BOND}`);
    require(failedRefund.proposal.status === 'Failed', `proposal after failed refund is ${failedRefund.proposal.status}`);

    stage('recreate proposer');
    const recreated = await root.createSubAccount('proposer', {initialBalance: parseNEAR('10')});
    const recreateFinal = {accountId: recreated.accountId, status: 'created'};
    const recreatedBalance = await viewAmount(worker, proposer.accountId);
    stage(`recreated balance ${recreatedBalance}`);
    const beforeRetry = await snapshot(worker, dao, proposer.accountId, voter.accountId);
    stage('retry');
    const retry = await voter.callRaw(dao, 'act_proposal', {id, action: 'Finalize', proposal: kind}, {gas: GAS});
    const retryFinal = summarize(await finalStatus(worker, retry, voter.accountId));
    await waitProposal(worker, dao, id, 'Failed');
    const afterRetry = await settle(worker, dao, proposer.accountId, voter.accountId);
    const retryDelta = BigInt(afterRetry.proposer ?? 0) - BigInt(beforeRetry.proposer ?? 0);
    require(retryDelta === BOND, `retry proposer delta is ${retryDelta}, expected ${BOND}`);
    require(afterRetry.lockedAmount === '0', `locked liability after successful retry is ${afterRetry.lockedAmount}`);

    stage('unauthorized callback');
    const unauthorized = await voter.callRaw(dao, 'on_refund_callback', {proposal_id: id, attempt: '999'}, {gas: GAS}).then(
      (tx) => finalStatus(worker, tx, voter.accountId).then(summarize),
      (error) => ({error: String(error.message || error).slice(0, 500)}),
    );
    const afterUnauthorized = await settle(worker, dao, proposer.accountId, voter.accountId);
    require(afterUnauthorized.proposer === afterRetry.proposer, 'unauthorized callback changed proposer balance');

    stage('duplicate retry');
    const duplicate = await voter.callRaw(dao, 'act_proposal', {id, action: 'Finalize', proposal: kind}, {gas: GAS});
    const duplicateFinal = summarize(await finalStatus(worker, duplicate, voter.accountId));
    const afterDuplicate = await settle(worker, dao, proposer.accountId, voter.accountId);
    const duplicateDelta = BigInt(afterDuplicate.proposer ?? 0) - BigInt(afterRetry.proposer ?? 0);
    require(duplicateDelta === 0n, `duplicate retry paid ${duplicateDelta}`);
    require(afterDuplicate.lockedAmount === '0', `duplicate retry changed locked amount to ${afterDuplicate.lockedAmount}`);

    const report = {
      schema: 'near-rehearsal/settlement-refund/v1',
      generatedAt: new Date().toISOString(),
      source: {repository: 'https://github.com/near-daos/sputnik-dao-contract', commit: '5434a59dec23ee0c49df8c8c4350c208a7e75b0b'},
      candidate: {wasmSha256: sha256(wasm), wasmBytes: wasm.length},
      runtime: rt,
      proposalId: id,
      transactions: {deploy: deployFinal, init: initFinal, add: addFinal, upgrade, delete: deleteFinal, vote: voteFinal, retry: retryFinal, unauthorized, duplicate: duplicateFinal},
      failedRefund,
      beforeRetry,
      afterRetry,
      afterUnauthorized,
      afterDuplicate,
      deltas: {retryProposer: retryDelta.toString(), duplicateProposer: duplicateDelta.toString()},
      errors,
      ok: errors.length === 0,
      boundary: 'Local Sandbox settlement regression. No live DAO, production funds, deployment or universal recovery claim.',
    };
    fs.mkdirSync(opts.out, {recursive: true});
    fs.writeFileSync(path.join(opts.out, 'settlement-refund.json'), json(report));
    console.log(json({ok: report.ok, errors, deltas: report.deltas, failedLocked: failedRefund.lockedAmount, finalLocked: afterDuplicate.lockedAmount}));
    if (errors.length) process.exitCode = 1;
  } finally {
    await worker.tearDown?.().catch(() => {});
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
