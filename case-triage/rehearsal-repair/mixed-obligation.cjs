'use strict';
/*
 * Same-DAO mixed-obligation scenario for the pinned Sputnik #238 case.
 *
 * One local DAO holds three obligations created under the old code:
 *   - Alice: a Failed async proposal whose 1 NEAR bond is still stranded.
 *   - Bob:   a healthy InProgress Transfer with its own 1 NEAR bond.
 *   - Carol: an already-paid Transfer.
 * The candidate is deployed once without new(), then the same state is used
 * for Alice recovery, Bob settlement and the retry probes. This is a local
 * Sandbox exercise, not DAO governance or a production migration.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {Worker, parseNEAR, hashContract} = require('near-workspaces');

const HERE = __dirname;
const BASE = path.join(HERE, 'bundle/artifacts/base.wasm');
const BOND = BigInt(parseNEAR('1'));
const TRANSFER = BigInt(parseNEAR('0.1'));
const GAS = 300_000_000_000_000n;
const ACTION_GAS = 20_000_000_000_000n;
const MAX_WAIT_MS = 90_000;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const json = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2) + '\n';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    opts[key] = value;
  }
  return opts;
}

function actualSandboxRuntime(opts = {}) {
  const configured = opts.sandboxDir || process.env.NEAR_SANDBOX_BIN_PATH || process.env.NEAR_SANDBOX_BINARY_PATH;
  if (!configured) throw new Error('NEAR_SANDBOX_BIN_PATH (or --sandbox-dir) is required');
  const dir = path.resolve(configured);
  const binary = path.join(dir, 'near-sandbox');
  if (!fs.existsSync(binary)) throw new Error(`Sandbox binary not found at ${binary}`);
  const result = spawnSync(binary, ['--version'], {encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024});
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const match = output.match(/neard \(release ([^)]+)\).*?commit ([0-9a-f]+).*?\(protocol (\d+)\)/s);
  if (result.status !== 0 || !match) throw new Error(`cannot verify Sandbox binary at ${binary}: ${output}`);
  if (match[1] !== '2.14.0' || match[2] !== 'bc4e9e8cfb03d9e82f027883055624e18576993e' || Number(match[3]) !== 88) {
    throw new Error(`unexpected Sandbox runtime: ${output}`);
  }
  return {version: match[1], commit: match[2], protocol: Number(match[3]), binary, binarySha256: sha256(fs.readFileSync(binary)), versionOutput: output};
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stage = (name) => process.stderr.write(`[mixed] ${name}\n`);

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
    gasBurntUnits: r.outcome?.gas_burnt?.toString() ?? null,
    tokensBurntYocto: r.outcome?.tokens_burnt?.toString() ?? null,
    logs: r.outcome?.logs ?? [],
  }));
  const txTokens = BigInt(txo?.outcome?.tokens_burnt ?? 0);
  const receiptTokens = receipts.reduce((sum, receipt) => sum + BigInt(receipt.tokensBurntYocto ?? 0), 0n);
  return {
    transactionHash: final?.hash ?? null,
    finalExecutionStatus: final?.status?.final_execution_status ?? null,
    succeeded: final?.status?.final_execution_status === 'FINAL' && !txo?.outcome?.status?.Failure,
    receiptFailure: receipts.some((receipt) => receipt.status?.Failure),
    transactionOutcome: {
      status: txo?.outcome?.status ?? null,
      gasBurntUnits: txo?.outcome?.gas_burnt?.toString() ?? null,
      tokensBurntYocto: txo?.outcome?.tokens_burnt?.toString() ?? null,
      rootReceiptIds: txo?.outcome?.receipt_ids ?? [],
    },
    transactionTokensBurntYocto: txTokens.toString(),
    receiptTokensBurntYocto: receiptTokens.toString(),
    gasBurntYocto: (txTokens + receiptTokens).toString(),
    receipts,
    transaction: {
      signerId: final?.status?.transaction?.signer_id ?? null,
      receiverId: final?.status?.transaction?.receiver_id ?? null,
      actions: (final?.status?.transaction?.actions ?? []).map((action) => {
        if (action?.DeployContract && String(action.DeployContract.code || '').length > 2048) {
          const bytes = Buffer.from(action.DeployContract.code, 'base64');
          return {DeployContract: {...action.DeployContract, code: null, codeBytes: bytes.length, codeSha256: sha256(bytes)}};
        }
        if (!action?.FunctionCall || String(action.FunctionCall.args || '').length <= 2048) return action;
        const bytes = Buffer.from(action.FunctionCall.args, 'base64');
        return {FunctionCall: {...action.FunctionCall, args: null, argsBytes: bytes.length, argsSha256: sha256(bytes)}};
      }),
    },
  };
}

const summaryGas = (summary) => BigInt(summary?.transactionOutcome?.tokensBurntYocto ?? 0) +
  (summary?.receipts || []).reduce((sum, receipt) => sum + BigInt(receipt?.tokensBurntYocto ?? 0), 0n);

async function viewJson(worker, id, method, args = {}, blockId = null) {
  const result = await worker.provider.viewCall(id, method, args, blockId ? {blockId} : {finality: 'final'});
  if (!result || !Array.isArray(result.result)) throw new Error(`${method} returned no result`);
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

async function viewAmount(worker, id, blockId = null) {
  return (await worker.provider.viewAccount(id, blockId ? {blockId} : {finality: 'final'})).amount;
}

async function viewToken(worker, id, method, blockId = null) {
  const result = await worker.provider.viewCall(id, method, {}, blockId ? {blockId} : {finality: 'final'});
  if (!result || !Array.isArray(result.result)) throw new Error(`${method} returned no result`);
  const text = Buffer.from(result.result).toString('utf8');
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (value && typeof value.__near_token__ === 'string') return BigInt(value.__near_token__);
  if (value && typeof value.amount === 'string') return BigInt(value.amount);
  throw new Error(`${method} returned an unreadable NearToken: ${text.slice(0, 200)}`);
}

async function readState(worker, id, blockId = null) {
  return (await worker.provider.viewStateRaw(id, '', blockId ? {blockId} : {finality: 'final'}))
    .map(({key, value}) => ({key, value}))
    .sort((a, b) => a.key.localeCompare(b.key));
}

const stateHash = (items) => sha256(JSON.stringify(items));

async function settle(worker, accounts) {
  let previous = null;
  let stable = 0;
  for (let i = 0; i < 24; i += 1) {
    const observed = Object.fromEntries(await Promise.all(accounts.map(async (account) => [account.accountId, await viewAmount(worker, account.accountId)])));
    const daoId = accounts.find((account) => account.label === 'dao')?.accountId || accounts[0].accountId;
    observed.state = stateHash(await readState(worker, daoId));
    const key = JSON.stringify(observed);
    if (key === previous) stable += 1;
    else { stable = 0; previous = key; }
    if (stable >= 3) return observed;
    await sleep(500);
  }
  return previous ? JSON.parse(previous) : null;
}

async function initWorker() {
  let last;
  for (let i = 0; i < 3; i += 1) {
    try { return await Worker.init({network: 'sandbox'}); }
    catch (error) { last = error; await sleep(2000); }
  }
  throw last;
}

async function snapshot(worker, dao, accounts, proposals) {
  // Pin every read in a snapshot to one final block. Without this, a later
  // account view can include a receipt that the earlier contract view did not,
  // which makes derived locked amounts look inconsistent.
  const block = await worker.provider.sendJsonRpc('block', {finality: 'final'});
  const blockId = block?.header?.hash;
  if (!blockId) throw new Error('could not read a final block for snapshot');
  const account = await worker.provider.viewAccount(dao.accountId, {blockId});
  const available = await viewToken(worker, dao.accountId, 'get_available_amount', blockId);
  const lockedStorage = await viewToken(worker, dao.accountId, 'get_locked_storage_amount', blockId);
  const balance = BigInt(account.amount);
  const state = await readState(worker, dao.accountId, blockId);
  return {
    blockHeight: block.header.height,
    blockHash: blockId,
    codeHash: hashContract(await worker.provider.viewCode(dao.accountId, {blockId})),
    state,
    stateHash: stateHash(state),
    policy: await viewJson(worker, dao.accountId, 'get_policy', {}, blockId),
    proposals: Object.fromEntries(await Promise.all(proposals.map(async (proposal) => [proposal.label, await viewJson(worker, dao.accountId, 'get_proposal', {id: proposal.id}, blockId)]))),
    contractBalance: account.amount,
    storageUsage: account.storage_usage,
    availableAmount: available.toString(),
    lockedStorageAmount: lockedStorage.toString(),
    lockedAmount: (balance - lockedStorage - available).toString(),
    balances: Object.fromEntries(await Promise.all(accounts.map(async (account) => [account.label, await viewAmount(worker, account.accountId, blockId)]))),
  };
}

async function createBase(worker) {
  const root = worker.rootAccount;
  const accounts = {
    alice: await root.createSubAccount('alice', {initialBalance: parseNEAR('100')}),
    bob: await root.createSubAccount('bob', {initialBalance: parseNEAR('100')}),
    carol: await root.createSubAccount('carol', {initialBalance: parseNEAR('100')}),
    aliceRecipient: await root.createSubAccount('alice-recipient', {initialBalance: parseNEAR('10')}),
    bobRecipient: await root.createSubAccount('bob-recipient', {initialBalance: parseNEAR('10')}),
    carolRecipient: await root.createSubAccount('carol-recipient', {initialBalance: parseNEAR('10')}),
  };
  const dao = await root.createSubAccount('dao', {initialBalance: parseNEAR('100')});
  const wasm = fs.readFileSync(BASE);
  const deploy = await dao.deploy(wasm);
  const deployFinal = await finalStatus(worker, deploy, root.accountId);
  const init = await root.callRaw(dao, 'new', {
    config: {name: 'mixed-obligation-recovery', purpose: 'bounded same-DAO mixed obligations', metadata: ''},
    policy: [accounts.alice.accountId],
  }, {gas: GAS});
  const initFinal = await finalStatus(worker, init, root.accountId);
  for (let i = 0; i < 40; i += 1) {
    try { await viewJson(worker, dao.accountId, 'get_policy'); break; } catch { await sleep(250); }
  }
  return {root, dao, accounts, deploy: summarize(deployFinal), init: summarize(initFinal)};
}

const transferKind = (recipient) => ({Transfer: {token_id: '', receiver_id: recipient.accountId, amount: TRANSFER.toString(), msg: null}});
const failedKind = () => ({FunctionCall: {receiver_id: 'missing-target.test.near', actions: [{method_name: 'ping', args: '', deposit: '0', gas: ACTION_GAS.toString()}]}});

async function addProposal(worker, proposer, dao, kind, description) {
  try {
    const add = await proposer.callRaw(dao, 'add_proposal', {proposal: {description, kind}}, {gas: GAS, attachedDeposit: BOND.toString()});
    const addFinal = await finalStatus(worker, add, proposer.accountId);
    return {id: add.parseResult(), add: summarize(addFinal)};
  } catch (error) {
    process.stderr.write(`[mixed] addProposal ${description} failed: ${JSON.stringify({message: error.message, type: error.type, data: error.data, context: error.context})}\n`);
    throw error;
  }
}

async function vote(worker, voter, dao, id, kind) {
  try {
    const tx = await voter.callRaw(dao, 'act_proposal', {id, action: 'VoteApprove', proposal: kind}, {gas: GAS});
    return summarize(await finalStatus(worker, tx, voter.accountId));
  } catch (error) {
    process.stderr.write(`[mixed] vote failed id=${id}: ${JSON.stringify({message: error.message, type: error.type, data: error.data, context: error.context})}\n`);
    throw error;
  }
}

async function waitProposal(worker, dao, id, terminal = null) {
  const deadline = Date.now() + MAX_WAIT_MS;
  let proposal;
  while (Date.now() < deadline) {
    proposal = await viewJson(worker, dao.accountId, 'get_proposal', {id});
    if (!terminal || proposal.status === terminal) return proposal;
    await sleep(500);
  }
  return proposal;
}

async function attempt(label, fn) {
  try { return {label, ok: true, executed: true, value: await fn()}; }
  catch (error) { return {label, ok: false, executed: false, error: String(error?.message || error).slice(0, 2000)}; }
}

async function deployAndMigrate(worker, dao, wasm) {
  const deploy = await dao.deploy(wasm);
  const deployFinal = await finalStatus(worker, deploy, dao.accountId);
  const migrate = await dao.callRaw(dao, 'migrate', {}, {gas: GAS});
  const migrateFinal = await finalStatus(worker, migrate, dao.accountId);
  return {
    method: 'account-key deploy + private migrate',
    deploy: summarize(deployFinal),
    migrate: summarize(migrateFinal),
    receiptFailure: summarize(deployFinal).receiptFailure || summarize(migrateFinal).receiptFailure,
  };
}

async function waitCode(worker, dao, expectedHash) {
  const deadline = Date.now() + MAX_WAIT_MS;
  let code;
  while (Date.now() < deadline) {
    code = await dao.viewCode();
    if (code?.length && hashContract(code) === expectedHash) return code;
    await sleep(250);
  }
  throw new Error(`code hash did not become ${expectedHash}; last length ${code?.length ?? 0}`);
}

async function runMixed(worker, candidateWasm) {
  stage('base');
  const base = await createBase(worker);
  const {accounts, dao} = base;
  const allAccounts = [
    {label: 'alice', accountId: accounts.alice.accountId},
    {label: 'bob', accountId: accounts.bob.accountId},
    {label: 'carol', accountId: accounts.carol.accountId},
    {label: 'aliceRecipient', accountId: accounts.aliceRecipient.accountId},
    {label: 'bobRecipient', accountId: accounts.bobRecipient.accountId},
    {label: 'carolRecipient', accountId: accounts.carolRecipient.accountId},
    {label: 'dao', accountId: dao.accountId},
  ];
  const carolKind = transferKind(accounts.carolRecipient);
  stage('carolAdd');
  const carolAdd = await addProposal(worker, accounts.carol, dao, carolKind, 'carol already paid');
  stage('carolAdded');
  await vote(worker, accounts.alice, dao, carolAdd.id, carolKind);
  stage('carolVoted');
  stage('carolSettling');
  await settle(worker, allAccounts);
  stage('carolSettled');
  const carolAfter = await snapshot(worker, dao, allAccounts, [{label: 'carol', id: carolAdd.id}]);
  stage('carolSnapshot');

  const aliceKind = failedKind();
  stage('aliceAdd');
  const aliceAdd = await addProposal(worker, accounts.alice, dao, aliceKind, 'alice failed async');
  stage('aliceAdded');
  await vote(worker, accounts.alice, dao, aliceAdd.id, aliceKind);
  stage('aliceVoted');
  await waitProposal(worker, dao, aliceAdd.id, 'Failed');
  await settle(worker, allAccounts);
  const aliceFailed = await snapshot(worker, dao, allAccounts, [{label: 'alice', id: aliceAdd.id}]);

  const bobKind = transferKind(accounts.bobRecipient);
  stage('bobAdd');
  const bobAdd = await addProposal(worker, accounts.bob, dao, bobKind, 'bob healthy pending');
  await settle(worker, allAccounts);
  const before = await snapshot(worker, dao, allAccounts, [
    {label: 'alice', id: aliceAdd.id},
    {label: 'bob', id: bobAdd.id},
    {label: 'carol', id: carolAdd.id},
  ]);

  const candidateHash = hashContract(candidateWasm);
  stage('upgrade');
  const upgrade = await deployAndMigrate(worker, dao, candidateWasm);
  if (upgrade.receiptFailure) throw new Error('candidate deploy/migrate receipt failed');
  await waitCode(worker, dao, candidateHash);
  const afterUpgrade = await snapshot(worker, dao, allAccounts, [
    {label: 'alice', id: aliceAdd.id},
    {label: 'bob', id: bobAdd.id},
    {label: 'carol', id: carolAdd.id},
  ]);

  stage('aliceRecovery');
  const aliceRecovery = await attempt('alice recovery', async () => {
    const tx = await accounts.alice.callRaw(dao, 'act_proposal', {id: aliceAdd.id, action: 'Finalize', proposal: aliceKind}, {gas: GAS});
    return summarize(await finalStatus(worker, tx, accounts.alice.accountId));
  });
  await waitProposal(worker, dao, aliceAdd.id, 'Failed');
  await settle(worker, allAccounts);
  const aliceAfter = await snapshot(worker, dao, allAccounts, [{label: 'alice', id: aliceAdd.id}, {label: 'bob', id: bobAdd.id}, {label: 'carol', id: carolAdd.id}]);

  const aliceRetry = await attempt('alice retry', async () => {
    const tx = await accounts.alice.callRaw(dao, 'act_proposal', {id: aliceAdd.id, action: 'Finalize', proposal: aliceKind}, {gas: GAS});
    return summarize(await finalStatus(worker, tx, accounts.alice.accountId));
  });
  await settle(worker, allAccounts);
  const aliceRetryAfter = await snapshot(worker, dao, allAccounts, [{label: 'alice', id: aliceAdd.id}, {label: 'bob', id: bobAdd.id}, {label: 'carol', id: carolAdd.id}]);

  stage('bobPayout');
  const bobPayout = await attempt('bob payout', async () => {
    const tx = await accounts.alice.callRaw(dao, 'act_proposal', {id: bobAdd.id, action: 'VoteApprove', proposal: bobKind}, {gas: GAS});
    return summarize(await finalStatus(worker, tx, accounts.alice.accountId));
  });
  await waitProposal(worker, dao, bobAdd.id, 'Approved');
  await settle(worker, allAccounts);
  const bobAfter = await snapshot(worker, dao, allAccounts, [{label: 'alice', id: aliceAdd.id}, {label: 'bob', id: bobAdd.id}, {label: 'carol', id: carolAdd.id}]);

  stage('bobRetry');
  const bobRetry = await attempt('bob retry', async () => {
    const tx = await accounts.alice.callRaw(dao, 'act_proposal', {id: bobAdd.id, action: 'Finalize', proposal: bobKind}, {gas: GAS});
    return summarize(await finalStatus(worker, tx, accounts.alice.accountId));
  });
  await settle(worker, allAccounts);
  const bobRetryAfter = await snapshot(worker, dao, allAccounts, [{label: 'bob', id: bobAdd.id}, {label: 'carol', id: carolAdd.id}]);

  stage('carolRetry');
  const carolRetry = await attempt('carol retry', async () => {
    const tx = await accounts.alice.callRaw(dao, 'act_proposal', {id: carolAdd.id, action: 'Finalize', proposal: carolKind}, {gas: GAS});
    return summarize(await finalStatus(worker, tx, accounts.alice.accountId));
  });
  await settle(worker, allAccounts);
  const carolRetryAfter = await snapshot(worker, dao, allAccounts, [{label: 'carol', id: carolAdd.id}]);

  const delta = (after, before, key) => (BigInt(after?.[key] ?? 0) - BigInt(before?.[key] ?? 0)).toString();
  const aliceRecoveryDeltas = {};
  // Use the pre-recovery snapshot for Alice, not the post-recovery snapshot.
  const ar = afterUpgrade;
  aliceRecoveryDeltas.contract = delta(aliceAfter, ar, 'contractBalance');
  aliceRecoveryDeltas.recipient = (BigInt(aliceAfter.balances.aliceRecipient) - BigInt(ar.balances.aliceRecipient)).toString();
  aliceRecoveryDeltas.proposer = (BigInt(aliceAfter.balances.alice) - BigInt(ar.balances.alice)).toString();
  aliceRecoveryDeltas.locked = (BigInt(aliceAfter.lockedAmount) - BigInt(ar.lockedAmount)).toString();
  const aliceRetryDeltas = {
    contract: delta(aliceRetryAfter, aliceAfter, 'contractBalance'),
    proposer: delta(aliceRetryAfter.balances.alice, aliceAfter.balances.alice, 'balance'),
    recipient: (BigInt(aliceRetryAfter.balances.aliceRecipient) - BigInt(aliceAfter.balances.aliceRecipient)).toString(),
    locked: (BigInt(aliceRetryAfter.lockedAmount) - BigInt(aliceAfter.lockedAmount)).toString(),
  };
  const bobPayoutDeltas = {
    contract: delta(bobAfter, aliceRetryAfter, 'contractBalance'),
    proposer: (BigInt(bobAfter.balances.bob) - BigInt(aliceRetryAfter.balances.bob)).toString(),
    recipient: (BigInt(bobAfter.balances.bobRecipient) - BigInt(aliceRetryAfter.balances.bobRecipient)).toString(),
    locked: (BigInt(bobAfter.lockedAmount) - BigInt(aliceRetryAfter.lockedAmount)).toString(),
  };
  const bobRetryDeltas = {
    contract: delta(bobRetryAfter, bobAfter, 'contractBalance'),
    proposer: delta(bobRetryAfter.balances.bob, bobAfter.balances.bob, 'balance'),
    recipient: (BigInt(bobRetryAfter.balances.bobRecipient) - BigInt(bobAfter.balances.bobRecipient)).toString(),
    locked: (BigInt(bobRetryAfter.lockedAmount) - BigInt(bobAfter.lockedAmount)).toString(),
  };
  const carolRetryDeltas = {
    contract: delta(carolRetryAfter, bobRetryAfter, 'contractBalance'),
    proposer: delta(carolRetryAfter.balances.carol, bobRetryAfter.balances.carol, 'balance'),
    recipient: (BigInt(carolRetryAfter.balances.carolRecipient) - BigInt(bobRetryAfter.balances.carolRecipient)).toString(),
    locked: (BigInt(carolRetryAfter.lockedAmount) - BigInt(bobRetryAfter.lockedAmount)).toString(),
  };

  const aliceRecoveryGas = aliceRecovery.ok ? summaryGas(aliceRecovery.value) : 0n;
  const bobPayoutGas = bobPayout.ok ? summaryGas(bobPayout.value) : 0n;
  const beforeAlice = afterUpgrade;
  return {
    schema: 'near-rehearsal/mixed-obligation/v1',
    generatedAt: new Date().toISOString(),
    caseId: 'sputnik-238-same-dao-mixed',
    source: {
      repository: 'https://github.com/near-daos/sputnik-dao-contract',
      commit: '5434a59dec23ee0c49df8c8c4350c208a7e75b0b',
      issue: 'https://github.com/near-daos/sputnik-dao-contract/issues/238',
      baseWasmSha256: sha256(fs.readFileSync(BASE)),
      baseWasmHash: hashContract(fs.readFileSync(BASE)),
    },
    candidate: {wasmSha256: sha256(candidateWasm), wasmHash: candidateHash, wasmBytes: candidateWasm.length},
    accounts: {
      contract: dao.accountId,
      alice: accounts.alice.accountId,
      bob: accounts.bob.accountId,
      carol: accounts.carol.accountId,
      aliceRecipient: accounts.aliceRecipient.accountId,
      bobRecipient: accounts.bobRecipient.accountId,
      carolRecipient: accounts.carolRecipient.accountId,
    },
    deploy: base.deploy,
    init: base.init,
    carol: {proposalId: carolAdd.id, add: carolAdd.add, after: carolAfter},
    alice: {proposalId: aliceAdd.id, add: aliceAdd.add, failed: aliceFailed},
    bob: {proposalId: bobAdd.id, add: bobAdd.add},
    beforeUpgrade: before,
    upgrade,
    afterUpgrade,
    aliceRecovery: {
      attempt: aliceRecovery,
      after: aliceAfter,
      deltas: aliceRecoveryDeltas,
      gasBurntYocto: aliceRecoveryGas.toString(),
      before: beforeAlice,
    },
    aliceRetry: {attempt: aliceRetry, after: aliceRetryAfter, deltas: aliceRetryDeltas},
    bobPayout: {attempt: bobPayout, after: bobAfter, deltas: bobPayoutDeltas, gasBurntYocto: bobPayoutGas.toString()},
    bobRetry: {attempt: bobRetry, after: bobRetryAfter, deltas: bobRetryDeltas},
    carolRetry: {attempt: carolRetry, after: carolRetryAfter, deltas: carolRetryDeltas},
    checks: {
      beforeLockedTwoBonds: BigInt(before.lockedAmount) === BOND * 2n,
      aliceFailedBeforeUpgrade: before.proposals.alice.status === 'Failed',
      bobPendingBeforeUpgrade: before.proposals.bob.status === 'InProgress',
      carolPaidBeforeUpgrade: before.proposals.carol.status === 'Approved',
      upgradePreservedLocked: BigInt(afterUpgrade.lockedAmount) === BOND * 2n,
      upgradePreservedProposals: ['alice', 'bob', 'carol'].every((name) => JSON.stringify(afterUpgrade.proposals[name]) === JSON.stringify(before.proposals[name])),
      aliceRecoveredOnce: aliceRecovery.ok && aliceRecovery.value.receiptFailure === true && aliceAfter.proposals.alice.status === 'Failed'
        && aliceRecoveryDeltas.locked === (-BOND).toString() && aliceRecoveryDeltas.recipient === '0'
        && BigInt(aliceRecoveryDeltas.contract) === -BOND,
      aliceRetryNoExtra: aliceRetry.ok && aliceRetry.value.receiptFailure === true && aliceRetryDeltas.locked === '0'
        && aliceRetryDeltas.contract === '0' && aliceRetryDeltas.recipient === '0',
      bobPaidOnce: bobPayout.ok && bobPayout.value.receiptFailure === false && bobAfter.proposals.bob.status === 'Approved'
        && bobPayoutDeltas.recipient === TRANSFER.toString() && bobPayoutDeltas.locked === (-BOND).toString()
        && BigInt(bobPayoutDeltas.contract) === -(BOND + TRANSFER),
      bobRetryNoExtra: bobRetry.ok && bobRetry.value.receiptFailure === true && bobRetryDeltas.recipient === '0'
        && bobRetryDeltas.contract === '0' && bobRetryDeltas.locked === '0',
      carolRetryNoExtra: carolRetry.ok && carolRetry.value.receiptFailure === true && carolRetryDeltas.recipient === '0'
        && carolRetryDeltas.contract === '0' && carolRetryDeltas.locked === '0',
    },
    boundary: 'Local Sandbox evidence for the pinned Sputnik #238 case. No live DAO recovery, deployment, audit, universal safety claim, signature or merge enforcement.',
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.candidateWasm) throw new Error('--candidate-wasm is required');
  if (!opts.out) throw new Error('--out is required');
  const runtime = actualSandboxRuntime(opts);
  process.env.NEAR_SANDBOX_BIN_PATH = path.dirname(runtime.binary);
  process.env.NEAR_SANDBOX_BINARY_PATH = path.dirname(runtime.binary);
  process.env.NEAR_SANDBOX_VERSION = runtime.version;
  const candidateWasm = fs.readFileSync(path.resolve(opts.candidateWasm));
  const worker = await initWorker();
  let report;
  try {
    assertLocal(worker);
    report = await runMixed(worker, candidateWasm);
    report.runtime = runtime;
    fs.mkdirSync(path.resolve(opts.out), {recursive: true});
    fs.writeFileSync(path.join(path.resolve(opts.out), 'mixed-obligation.json'), json(report));
  } finally {
    await worker.tearDown?.().catch(() => {});
  }
  console.log(json({candidate: report.candidate, checks: report.checks, alice: report.aliceRecovery.deltas, bob: report.bobPayout.deltas, bobRetry: report.bobRetry.deltas, carolRetry: report.carolRetry.deltas}));
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = {runMixed, actualSandboxRuntime, parseArgs, BOND, TRANSFER, summaryGas};
