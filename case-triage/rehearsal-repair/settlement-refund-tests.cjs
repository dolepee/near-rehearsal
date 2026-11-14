'use strict';
/*
 * Local-chain settlement regression for the #238 repair.
 *
 * Two scenarios run in one report, because they fail differently:
 *   fresh     - the candidate is deployed from genesis and records the bond itself.
 *   inherited - the proposal and its bond are created on the pinned base artifact,
 *               then the candidate is installed by upgrade and must settle the
 *               inherited debt without any local bond/refund history.
 * In both, the proposer account is deleted before the failed action's callback,
 * so the refund transfer fails. The debt must remain locked; after the proposer
 * is recreated and the proposal is finalised by two independently signed council
 * transactions, exactly one bond must be paid, and a further finalise must not
 * pay a second time.
 *
 * usage: NEAR_SANDBOX_BIN_PATH=/workspace/tools/near-sandbox-2.14-wrapper \
 *   node settlement-refund-tests.cjs --wasm <candidate.wasm> \
 *     --base-wasm <pinned-base.wasm> --out <dir>
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
    if (argv[i] === '--wasm' || argv[i] === '--candidate-wasm') opts.wasm = path.resolve(argv[++i]);
    else if (argv[i] === '--base-wasm') opts.baseWasm = path.resolve(argv[++i]);
    else if (argv[i] === '--out') opts.out = path.resolve(argv[++i]);
    else if (argv[i] === '--sandbox-dir') opts.sandboxDir = path.resolve(argv[++i]);
    else if (argv[i] === '--mode') opts.mode = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!opts.wasm || !opts.out) throw new Error('--wasm and --out are required');
  if (opts.sandboxDir) {
    process.env.NEAR_SANDBOX_BIN_PATH = opts.sandboxDir;
    process.env.NEAR_SANDBOX_BINARY_PATH = opts.sandboxDir;
  }
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

async function withHeight(worker, summary, label) {
  if (!summary?.blockHash) throw new Error(`required chronology capture for ${label} has no block hash`);
  let block;
  try {
    block = await worker.provider.sendJsonRpc('block', {block_id: summary.blockHash});
  } catch (error) {
    throw new Error(`required chronology capture for ${label} failed: ${error.message}`);
  }
  const returnedHash = block?.header?.hash ?? block?.hash;
  if (!returnedHash || returnedHash !== summary.blockHash) {
    throw new Error(`required chronology capture for ${label} returned a different block hash`);
  }
  if (!Number.isInteger(block?.header?.height)) {
    throw new Error(`required chronology capture for ${label} has no block height`);
  }
  summary.blockHeight = block.header.height;
  return summary;
}

function summarize(final) {
  const txo = final?.status?.transaction_outcome;
  const receipts = (final?.status?.receipts_outcome || []).map((r) => ({
    id: r.id,
    blockHash: r.block_hash ?? null,
    receiptIds: r.outcome?.receipt_ids ?? [],
    executorId: r.outcome?.executor_id ?? null,
    status: r.outcome?.status ?? null,
    logs: r.outcome?.logs ?? [],
    tokensBurntYocto: r.outcome?.tokens_burnt?.toString() ?? '0',
  }));
  return {
    transactionHash: final?.hash ?? null,
    blockHash: txo?.block_hash ?? null,
    blockHeight: txo?.block_height ?? null,
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

async function viewCallRetry(worker, id, method, args = {}, blockId = null) {
  let last;
  for (let i = 0; i < 8; i += 1) {
    try { return await worker.provider.viewCall(id, method, args, blockId ? {blockId} : {finality: 'final'}); }
    catch (error) { last = error; await sleep(300); }
  }
  throw last;
}

async function viewJson(worker, id, method, args = {}, blockId = null) {
  const result = await viewCallRetry(worker, id, method, args, blockId);
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

async function snapshot(worker, dao, proposerId, voter, proposalId = 0) {
  const block = await worker.provider.sendJsonRpc('block', {finality: 'final'});
  const blockId = block?.header?.hash;
  const account = await worker.provider.viewAccount(dao.accountId, {blockId});
  const available = await viewCallRetry(worker, dao.accountId, 'get_available_amount', {}, blockId);
  const lockedStorage = await viewCallRetry(worker, dao.accountId, 'get_locked_storage_amount', {}, blockId);
  const proposal = await viewJson(worker, dao.accountId, 'get_proposal', {id: proposalId}, blockId);
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

async function settle(worker, dao, proposerId, voter, proposalId = 0) {
  let last = null;
  let stable = 0;
  for (let i = 0; i < 24; i += 1) {
    const snap = await snapshot(worker, dao, proposerId, voter, proposalId);
    const key = JSON.stringify({locked: snap.lockedAmount, balance: snap.contractBalance, proposer: snap.proposer, status: snap.proposal.status, receipts: snap.proposal.last_actions_log?.length});
    if (key === last) stable += 1; else { stable = 0; last = key; }
    if (stable >= 3) return snap;
    await sleep(500);
  }
  return snapshot(worker, dao, proposerId, voter, proposalId);
}

async function runScenario({worker, tag, prefix, wasm, baseWasm}) {
  const errors = [];
  const label = (name) => `${tag}: ${name}`;
  const fail = (condition, message) => { if (!condition) errors.push(message); };
  const root = worker.rootAccount;
  const proposerId = `${prefix}-proposer`;
  const proposer = await root.createSubAccount(proposerId, {initialBalance: parseNEAR('20')});
  const voter = await root.createSubAccount(`${prefix}-voter`, {initialBalance: parseNEAR('20')});
  const voter2 = await root.createSubAccount(`${prefix}-voter2`, {initialBalance: parseNEAR('20')});
  const dao = await root.createSubAccount(`${prefix}-dao`, {initialBalance: parseNEAR('100')});

  stage(`${tag} deploy ${baseWasm ? 'pinned base' : 'candidate'}`);
  const deployedBytes = baseWasm || wasm;
  const deploy = await dao.deploy(deployedBytes);
  const deployFinal = summarize(await finalStatus(worker, deploy, root.accountId));
  const deployedCodeHash = hashContract(deployedBytes);
  const init = await root.callRaw(dao, 'new', {
    config: {name: `settlement ${tag}`, purpose: 'bounded refund settlement', metadata: ''},
    policy: [voter.accountId, voter2.accountId],
  }, {gas: GAS});
  const initFinal = summarize(await finalStatus(worker, init, root.accountId));

  const kind = {FunctionCall: {receiver_id: 'missing-target.test.near', actions: [{method_name: 'ping', args: '', deposit: '0', gas: ACTION_GAS.toString()}]}};
  stage(`${tag} add`);
  const add = await proposer.callRaw(dao, 'add_proposal', {proposal: {description: 'deleted proposer refund', kind}}, {gas: GAS, attachedDeposit: BOND.toString()});
  const addFinal = await withHeight(worker, summarize(await finalStatus(worker, add, proposer.accountId)), 'add proposal');
  const id = add.parseResult();
  let upgrade = null;
  let deleteFinal = null;

  if (!baseWasm) {
    stage(`${tag} delete proposer before the failed action`);
    const deleted = await proposer.delete(root.accountId);
    deleteFinal = {transactionHash: deleted?.transactionReceipt?.hash || null, transactionOutcome: {status: 'DeleteAccount submitted'}};
  }

  stage(`${tag} vote`);
  const vote = await voter.callRaw(dao, 'act_proposal', {id, action: 'VoteApprove', proposal: kind}, {gas: GAS});
  const voteFinal = summarize(await finalStatus(worker, vote, voter.accountId));
  const vote2 = await voter2.callRaw(dao, 'act_proposal', {id, action: 'VoteApprove', proposal: kind}, {gas: GAS});
  const vote2Final = await withHeight(worker, summarize(await finalStatus(worker, vote2, voter2.accountId)), 'second approval');
  const failedProposal = await waitProposal(worker, dao, id, 'Failed');

  if (baseWasm) {
    stage(`${tag} upgrade to the candidate`);
    const codeHash = hashContract(wasm);
    const upgradeDeploy = await dao.deploy(wasm);
    const upgradeDeployFinal = await withHeight(worker, summarize(await finalStatus(worker, upgradeDeploy, root.accountId)), 'candidate upgrade');
    upgradeDeployFinal.wasmSha256 = sha256(wasm);
    upgradeDeployFinal.codeHash = codeHash;
    const migrate = await dao.callRaw(dao, 'migrate', {}, {gas: GAS});
    const migrateFinal = await withHeight(worker, summarize(await finalStatus(worker, migrate, root.accountId)), 'migrate');
    let installed = false;
    for (let i = 0; i < 40; i += 1) {
      const code = await dao.viewCode();
      if (code?.length && hashContract(code) === codeHash) { installed = true; break; }
      await sleep(250);
    }
    fail(installed, 'candidate code was not installed on the inherited DAO');
    upgrade = {deploy: upgradeDeployFinal, migrate: migrateFinal, codeHash, candidateWasmSha256: sha256(wasm)};
    stage(`${tag} delete proposer after the upgrade`);
    const deleted = await proposer.delete(root.accountId);
    deleteFinal = {transactionHash: deleted?.transactionReceipt?.hash || null, transactionOutcome: {status: 'DeleteAccount submitted'}};
    stage(`${tag} legacy finalize while the proposer is deleted`);
    const legacyFinalize = await voter.callRaw(dao, 'act_proposal', {id, action: 'Finalize', proposal: kind}, {gas: GAS});
    const legacyFinalizeFinal = await withHeight(worker, summarize(await finalStatus(worker, legacyFinalize, voter.accountId)), 'legacy finalize');
    await waitProposal(worker, dao, id, 'Failed');
    upgrade.legacyFinalize = legacyFinalizeFinal;
  }

  const failedRefund = await settle(worker, dao, proposer.accountId, voter.accountId);
  fail(failedRefund.lockedAmount === BOND.toString(), `locked liability after failed refund is ${failedRefund.lockedAmount}, expected ${BOND}`);
  fail(failedRefund.proposal.status === 'Failed', `proposal after failed refund is ${failedRefund.proposal.status}`);

  stage(`${tag} recreate proposer`);
  await root.createSubAccount(proposerId, {initialBalance: parseNEAR('10')});
  const recreatedBalance = await viewAmount(worker, proposer.accountId);
  stage(`${tag} recreated balance ${recreatedBalance}`);
  const beforeRetry = await snapshot(worker, dao, proposer.accountId, voter.accountId);
  stage(`${tag} concurrent retry`);
  // Two independently signed council transactions. Both approve the original
  // proposal, so each is authorized; the concurrent Finalize submissions have
  // distinct signers, nonces, transaction hashes and receipts.
  const retryFinals = [];
  const submitted = await Promise.allSettled([
    voter.callRaw(dao, 'act_proposal', {id, action: 'Finalize', proposal: kind}, {gas: GAS}),
    voter2.callRaw(dao, 'act_proposal', {id, action: 'Finalize', proposal: kind}, {gas: GAS}),
  ]);
  for (const [index, entry] of submitted.entries()) {
    if (entry.status !== 'fulfilled') {
      throw new Error(`required retry ${index + 1} submission failed: ${String(entry.reason?.message || entry.reason)}`);
    }
    try {
      const signer = entry.value?.transaction?.signerId || null;
      const summarized = await withHeight(worker, summarize(await finalStatus(worker, entry.value, signer || voter.accountId)), `retry ${index + 1}`);
      retryFinals.push({...summarized, signerId: summarized.transaction?.signerId || null});
    } catch (error) {
      throw new Error(`required retry ${index + 1} capture failed: ${error.message}`);
    }
  }
  await waitProposal(worker, dao, id, 'Failed');
  await settle(worker, dao, proposer.accountId, voter.accountId);
  const retryFinal = retryFinals.find((value) => value && value.finalExecutionStatus === 'FINAL') || retryFinals[0] || null;
  const afterRetry = await settle(worker, dao, proposer.accountId, voter.accountId);
  const retryDelta = BigInt(afterRetry.proposer ?? 0) - BigInt(beforeRetry.proposer ?? 0);
  fail(retryDelta === BOND, `retry proposer delta is ${retryDelta}, expected ${BOND}`);
  fail(afterRetry.lockedAmount === '0', `locked liability after successful retry is ${afterRetry.lockedAmount}`);

  stage(`${tag} unauthorized callback`);
  const unauthorizedArgs = {proposal_id: id, attempt: 999};
  let unauthorized;
  try {
    const unauthorizedTx = await voter.callRaw(dao, 'on_refund_callback', unauthorizedArgs, {gas: GAS});
    const unauthorizedFinal = await finalStatus(worker, unauthorizedTx, voter.accountId);
    const unauthorizedValue = await withHeight(worker, summarize(unauthorizedFinal), 'unauthorized callback root');
    const callbackReceiptId = unauthorizedValue.transactionOutcome?.status?.SuccessReceiptId;
    if (!callbackReceiptId) throw new Error('unauthorized callback has no linked first receipt');
    const callbackReceipt = (unauthorizedValue.receipts || []).find((receipt) => receipt.id === callbackReceiptId);
    if (!callbackReceipt) throw new Error('unauthorized callback linked first receipt is missing');
    await withHeight(worker, callbackReceipt, 'unauthorized callback receipt');
    unauthorized = {ok: false, value: unauthorizedValue};
  } catch (error) {
    throw new Error(`required unauthorized callback capture failed: ${String(error?.message || error)}`);
  }
  const afterUnauthorized = await settle(worker, dao, proposer.accountId, voter.accountId);
  fail(afterUnauthorized.proposer === afterRetry.proposer, 'unauthorized callback changed proposer balance');
  fail(afterUnauthorized.lockedAmount === '0', 'unauthorized callback changed locked debt');

  stage(`${tag} duplicate retry`);
  const duplicate = await voter.callRaw(dao, 'act_proposal', {id, action: 'Finalize', proposal: kind}, {gas: GAS});
  const duplicateFinal = await withHeight(worker, summarize(await finalStatus(worker, duplicate, voter.accountId)), 'duplicate retry');
  const afterDuplicate = await settle(worker, dao, proposer.accountId, voter.accountId);
  const duplicateDelta = BigInt(afterDuplicate.proposer ?? 0) - BigInt(afterRetry.proposer ?? 0);
  fail(duplicateDelta === 0n, `duplicate retry paid ${duplicateDelta}`);
  fail(afterDuplicate.lockedAmount === '0', `duplicate retry changed locked amount to ${afterDuplicate.lockedAmount}`);

  const hashes = retryFinals.map((value) => value.transactionHash).filter(Boolean);
  const signers = retryFinals.map((value) => value.signerId).filter(Boolean);
  const bothFinal = retryFinals.every((value) => value.finalExecutionStatus === 'FINAL');
  const receiptBacked = retryFinals.every((value) => (value.receipts || []).length > 0);
  const overlapOk = retryFinals.length === 2
    && new Set(hashes).size === 2
    && new Set(signers).size === 2
    && bothFinal
    && receiptBacked
    && retryDelta === BOND
    && afterRetry.lockedAmount === '0';
  fail(overlapOk, 'concurrent retry evidence did not produce two distinct, independently signed, receipt-backed executions');

  return {
    proposalId: id,
    deploy: {...deployFinal, codeHash: deployedCodeHash, wasmSha256: sha256(deployedBytes)},
    transactions: {deploy: deployFinal, init: initFinal, add: addFinal, upgrade, delete: deleteFinal, vote: voteFinal, vote2: vote2Final, failedProposal, retries: retryFinals, retry: retryFinal, unauthorized, duplicate: duplicateFinal},
    legacy: baseWasm ? {
      baseWasmSha256: sha256(baseWasm),
      candidateWasmSha256: sha256(wasm),
      upgradeCodeHash: upgrade?.codeHash || null,
      proposalCreatedBeforeUpgrade: true,
      legacyFinalize: upgrade?.legacyFinalize || null,
    } : null,
    unauthorized,
    unauthorizedArgs,
    overlap: {
      kind: 'concurrent-submission',
      ok: overlapOk,
      distinctHashes: new Set(hashes).size === 2,
      distinctSigners: new Set(signers).size === 2,
      bothFinal,
      receiptBacked,
      attempts: retryFinals.map((value) => ({
        finalExecutionStatus: value.finalExecutionStatus || null,
        error: value.error || null,
        transactionHash: value.transactionHash || null,
        signerId: value.signerId || null,
        receiptIds: (value.receipts || []).map((receipt) => receipt.id),
        blockHash: value.blockHash || null,
      })),
      delta: retryDelta.toString(),
      lockedAfter: afterRetry.lockedAmount,
    },
    failedRefund,
    beforeRetry,
    afterRetry,
    afterUnauthorized,
    afterDuplicate,
    deltas: {retryProposer: retryDelta.toString(), duplicateProposer: duplicateDelta.toString()},
    errors,
    ok: errors.length === 0,
  };
}


async function runBountyDoneScenario({worker, tag, prefix, wasm, failPath}) {
  const errors = [];
  const label = (name) => `${tag}: ${name}`;
  const fail = (condition, message) => { if (!condition) errors.push(message); };
  const root = worker.rootAccount;
  const workerId = `${prefix}-worker`;
  const proposer = await root.createSubAccount(workerId, {initialBalance: parseNEAR('50')});
  const voter = await root.createSubAccount(`${prefix}-voter`, {initialBalance: parseNEAR('20')});
  const dao = await root.createSubAccount(`${prefix}-dao`, {initialBalance: parseNEAR('100')});
  const bountyAmount = BigInt(parseNEAR('3'));
  const expectedSettlement = bountyAmount + BOND * 2n;

  stage(`${tag} deploy candidate and initialise`);
  const deploy = await dao.deploy(wasm);
  const deployFinal = summarize(await finalStatus(worker, deploy, root.accountId));
  const init = await root.callRaw(dao, 'new', {
    config: {name: `bounty ${tag}`, purpose: 'failed BountyDone payout', metadata: ''},
    policy: [voter.accountId],
  }, {gas: GAS});
  const initFinal = summarize(await finalStatus(worker, init, root.accountId));

  stage(`${tag} create bounty`);
  const bountyKind = {AddBounty: {bounty: {
    description: 'bounded bounty',
    token: '',
    amount: bountyAmount.toString(),
    times: 1,
    max_deadline: '1000000000000',
  }}};
  const addBounty = await proposer.callRaw(dao, 'add_proposal', {
    proposal: {description: 'create bounty', kind: bountyKind},
  }, {gas: GAS, attachedDeposit: BOND.toString()});
  const addBountyFinal = summarize(await finalStatus(worker, addBounty, proposer.accountId));
  const addBountyId = addBounty.parseResult();
  await voter.callRaw(dao, 'act_proposal', {id: addBountyId, action: 'VoteApprove', proposal: bountyKind}, {gas: GAS});
  await waitProposal(worker, dao, addBountyId, 'Approved');

  stage(`${tag} claim and report bounty done`);
  const claim = await proposer.callRaw(dao, 'bounty_claim', {
    id: 0,
    deadline: '1000000000000',
  }, {gas: GAS, attachedDeposit: BOND.toString()});
  const claimFinal = summarize(await finalStatus(worker, claim, proposer.accountId));
  const done = await proposer.callRaw(dao, 'bounty_done', {
    id: 0,
    account_id: null,
    description: 'bounded delivery',
  }, {gas: GAS, attachedDeposit: BOND.toString()});
  const doneFinal = summarize(await finalStatus(worker, done, proposer.accountId));
  const proposalId = 1;
  const proposal = await viewJson(worker, dao.accountId, 'get_proposal', {id: proposalId});
  const bountyDoneKind = {BountyDone: {bounty_id: 0, receiver_id: proposer.accountId}};
  fail(proposal.status === 'InProgress', `BountyDone proposal status after creation is ${proposal.status}`);
  const beforeVote = failPath ? null : await snapshot(worker, dao, proposer.accountId, voter.accountId, proposalId);

  let deleteFinal = null;
  if (failPath) {
    stage(`${tag} delete proposer/receiver before failed payout`);
    const deleted = await proposer.delete(root.accountId);
    deleteFinal = {transactionHash: deleted?.transactionReceipt?.hash || null, transactionOutcome: {status: 'DeleteAccount submitted'}};
  }

  stage(`${tag} approve BountyDone`);
  const vote = await voter.callRaw(dao, 'act_proposal', {id: proposalId, action: 'VoteApprove', proposal: bountyDoneKind}, {gas: GAS});
  const voteFinal = summarize(await finalStatus(worker, vote, voter.accountId));
  if (failPath) {
    const failedProposal = await waitProposal(worker, dao, proposalId, 'Failed');
    const failed = await settle(worker, dao, proposer.accountId, voter.accountId, proposalId);
    fail(failedProposal.status === 'Failed', `proposal after failed BountyDone is ${failedProposal.status}`);
    fail(failed.lockedAmount === (BOND * 2n).toString(), `failed BountyDone retained ${failed.lockedAmount} locked, expected ${BOND * 2n}`);
    stage(`${tag} recreate proposer; retry is blocked by the upstream claim lifecycle`);
    await root.createSubAccount(workerId, {initialBalance: parseNEAR('10')});
    const beforeRetry = await snapshot(worker, dao, proposer.accountId, voter.accountId, proposalId);
    const retry = await voter.callRaw(dao, 'act_proposal', {id: proposalId, action: 'Finalize', proposal: bountyDoneKind}, {gas: GAS});
    const retryFinal = summarize(await finalStatus(worker, retry, voter.accountId));
    const retryStatus = JSON.stringify({transaction: retryFinal.transactionOutcome?.status || {}, receipts: (retryFinal.receipts || []).map((receipt) => receipt.status)});
    fail(retryStatus.includes('ERR_NO_BOUNTY_CLAIMS'), `BountyDone retry did not expose the upstream ERR_NO_BOUNTY_CLAIMS limitation: ${retryStatus}`);
    const afterRetry = await settle(worker, dao, proposer.accountId, voter.accountId, proposalId);
    const retryDelta = BigInt(afterRetry.proposer ?? 0) - BigInt(beforeRetry.proposer ?? 0);
    fail(retryDelta === 0n, `blocked BountyDone retry changed proposer balance by ${retryDelta}`);
    fail(afterRetry.lockedAmount === (BOND * 2n).toString(), `blocked BountyDone retry changed locked debt to ${afterRetry.lockedAmount}`);
    fail(afterRetry.proposal.status === 'Failed', `blocked BountyDone retry changed proposal status to ${afterRetry.proposal.status}`);
    return {
      proposalId,
      deploy: {...deployFinal, codeHash: hashContract(wasm), wasmSha256: sha256(wasm)},
      transactions: {deploy: deployFinal, init: initFinal, addBounty: addBountyFinal, claim: claimFinal, done: doneFinal, delete: deleteFinal, vote: voteFinal, retry: retryFinal},
      failed,
      beforeRetry,
      afterRetry,
      retryUnsupported: true,
      retryLimitation: 'Upstream internal_execute_bounty_payout removes the claim before its asynchronous payout; after the failed payout the proposal can be finalized but the claim is gone. Recovered debt remains locked, and this PR does not change bounties.rs or claim semantics.',
      retryStatus,
      deltas: {retryProposer: retryDelta.toString()},
      errors,
      ok: errors.length === 0,
    };
  }

  await waitProposal(worker, dao, proposalId, 'Approved');
  const settled = await settle(worker, dao, proposer.accountId, voter.accountId, proposalId);
  const settledDelta = BigInt(settled.proposer ?? 0) - BigInt(beforeVote.proposer ?? 0);
  fail(settledDelta === expectedSettlement, `successful bounty delta is ${settledDelta}, expected ${expectedSettlement}`);
  fail(settled.lockedAmount === '0', `successful bounty control retained ${settled.lockedAmount} locked`);
  fail(settled.proposal.status === 'Approved', `successful bounty control status is ${settled.proposal.status}`);
  const transferEvidence = (voteFinal.receipts || []).find((receipt) => (
    receipt.executorId === proposer.accountId
    && receipt.status
    && Object.prototype.hasOwnProperty.call(receipt.status, 'SuccessValue')
  ));
  fail(voteFinal.finalExecutionStatus === 'FINAL', `successful bounty vote is ${voteFinal.finalExecutionStatus}, not FINAL`);
  fail(Boolean(transferEvidence), 'successful bounty vote has no linked successful transfer receipt to the receiver');
  return {
    proposalId,
    deploy: {...deployFinal, codeHash: hashContract(wasm), wasmSha256: sha256(wasm)},
    transactions: {deploy: deployFinal, init: initFinal, addBounty: addBountyFinal, claim: claimFinal, done: doneFinal, vote: voteFinal},
    beforeVote,
    settled,
    successDelta: settledDelta.toString(),
    successEvidence: {
      transactionHash: voteFinal.transactionHash,
      finalExecutionStatus: voteFinal.finalExecutionStatus,
      receipt: transferEvidence || null,
    },
    errors,
    ok: errors.length === 0,
  };
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const rt = runtime();
  process.env.NEAR_SANDBOX_BIN_PATH = path.dirname(rt.binary);
  process.env.NEAR_SANDBOX_BINARY_PATH = path.dirname(rt.binary);
  process.env.NEAR_SANDBOX_VERSION = rt.version;
  const wasm = fs.readFileSync(opts.wasm);
  const baseWasm = opts.baseWasm ? fs.readFileSync(opts.baseWasm) : null;
  if (!baseWasm) throw new Error('--base-wasm is required: accepted settlement evidence must cover both the fresh candidate and the inherited pinned-base proposal');
  const mode = opts.mode || 'settlement';
  if (!['settlement', 'bounty'].includes(mode)) throw new Error('--mode must be settlement or bounty');
  const worker = await Worker.init({network: 'sandbox'});
  try {
    assertLocal(worker);
    if (mode === 'bounty') {
      const bountyFailure = await runBountyDoneScenario({worker, tag: 'bounty-failure', prefix: 'bounty-failure', wasm, failPath: true});
      const bountySuccess = await runBountyDoneScenario({worker, tag: 'bounty-success', prefix: 'bounty-success', wasm, failPath: false});
      const errors = [
        ...bountyFailure.errors.map((error) => `bounty-failure: ${error}`),
        ...bountySuccess.errors.map((error) => `bounty-success: ${error}`),
      ];
      const report = {
        schema: 'near-rehearsal/bounty-done/v1',
        generatedAt: new Date().toISOString(),
        source: {repository: 'https://github.com/near-daos/sputnik-dao-contract', commit: '5434a59dec23ee0c49df8c8c4350c208a7e75b0b'},
        candidate: {wasmSha256: sha256(wasm), wasmBytes: wasm.length},
        baseWasmSha256: sha256(baseWasm),
        runtime: rt,
        failure: bountyFailure,
        success: bountySuccess,
        errors,
        ok: bountyFailure.ok && bountySuccess.ok,
        boundary: 'Local Sandbox BountyDone regression. No live DAO, production funds, deployment or universal recovery claim. Retry is explicitly unsupported upstream because the claim is removed before the asynchronous payout.',
      };
      fs.mkdirSync(opts.out, {recursive: true});
      fs.writeFileSync(path.join(opts.out, 'bounty-done.json'), json(report));
      console.log(json({
        ok: report.ok,
        errors,
        failure: {locked: bountyFailure.failed?.lockedAmount, delta: bountyFailure.deltas?.retryProposer, finalLocked: bountyFailure.afterRetry?.lockedAmount, retryStatus: bountyFailure.retryStatus},
        success: {delta: bountySuccess.successDelta, locked: bountySuccess.settled?.lockedAmount, receipt: bountySuccess.successEvidence?.receipt?.id || null, finalExecutionStatus: bountySuccess.successEvidence?.finalExecutionStatus},
      }));
      if (!report.ok) process.exitCode = 1;
      return;
    }
    const fresh = await runScenario({worker, tag: 'fresh', prefix: 'fresh', wasm, baseWasm: null});
    const inherited = await runScenario({worker, tag: 'inherited', prefix: 'inherited', wasm, baseWasm});
    const errors = [
      ...fresh.errors.map((error) => `fresh: ${error}`),
      ...inherited.errors.map((error) => `inherited: ${error}`),
    ];
    const report = {
      schema: 'near-rehearsal/settlement-refund/v2',
      generatedAt: new Date().toISOString(),
      source: {repository: 'https://github.com/near-daos/sputnik-dao-contract', commit: '5434a59dec23ee0c49df8c8c4350c208a7e75b0b'},
      candidate: {wasmSha256: sha256(wasm), wasmBytes: wasm.length},
      baseWasmSha256: sha256(baseWasm),
      runtime: rt,
      fresh: {...fresh, mode: 'candidate-only'},
      inherited: {...inherited, mode: 'legacy-upgrade'},
      errors,
      ok: fresh.ok && inherited.ok,
      boundary: 'Local Sandbox settlement regression. No live DAO, production funds, deployment or universal recovery claim.',
    };
    fs.mkdirSync(opts.out, {recursive: true});
    fs.writeFileSync(path.join(opts.out, 'settlement-refund.json'), json(report));
    console.log(json({
      ok: report.ok,
      errors,
      fresh: {locked: fresh.failedRefund?.lockedAmount, delta: fresh.deltas?.retryProposer, finalLocked: fresh.afterDuplicate?.lockedAmount},
      inherited: {locked: inherited.failedRefund?.lockedAmount, delta: inherited.deltas?.retryProposer, finalLocked: inherited.afterDuplicate?.lockedAmount},
    }));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await worker.tearDown?.().catch(() => {});
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
