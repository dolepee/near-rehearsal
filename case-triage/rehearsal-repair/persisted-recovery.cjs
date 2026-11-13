'use strict';
/*
 * Persisted old-code failure -> generated-WASM recovery.
 *
 * The existing issue238-local runner proves the generated repair from two
 * equivalent fresh branches. This runner deliberately takes the harder path:
 * it fails a real proposal on the pinned old code, freezes that persisted
 * failure, then applies the exact generated WASM through the contract's
 * existing update/migrate path without calling new().
 *
 * This is a local Sandbox exercise. It is not DAO governance, public-state
 * recovery, an audit, or a production migration.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {Worker, parseNEAR, hashContract} = require('near-workspaces');

const HERE = __dirname;
const DEFAULT_BASE = path.join(HERE, 'bundle/artifacts/base.wasm');
const DEFAULT_OUT = path.join(HERE, 'out', 'persisted-recovery');
const BOND = parseNEAR('1');
const TRANSFER = parseNEAR('0.1');
const GAS = 300_000_000_000_000n;
const ACTION_GAS = 20_000_000_000_000n;
const DAO_ID = 'dao.test.near';
const PROPOSER_ID = 'proposer.test.near';
const RECIPIENT_ID = 'recipient.test.near';
const MISSING_ID = 'missing-target.test.near';
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
  if (!configured) throw new Error('NEAR_SANDBOX_BIN_PATH (or --sandbox-dir) is required; refusing an unverified runtime');
  const dir = path.resolve(configured);
  const binary = path.join(dir, 'near-sandbox');
  if (!fs.existsSync(binary)) throw new Error(`Sandbox binary not found at ${binary}`);
  const result = spawnSync(binary, ['--version'], {encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const match = output.match(/neard \(release ([^)]+)\).*?commit ([0-9a-f]+).*?\(protocol (\d+)\)/s);
  if (result.status !== 0 || !match) throw new Error(`cannot verify Sandbox binary at ${binary}: ${output}`);
  if (match[1] !== '2.14.0' || match[2] !== 'bc4e9e8cfb03d9e82f027883055624e18576993e' || Number(match[3]) !== 88) {
    throw new Error(`unexpected Sandbox runtime: ${output}`);
  }
  return {
    version: match[1],
    commit: match[2],
    protocol: Number(match[3]),
    binary,
    binarySha256: sha256(fs.readFileSync(binary)),
    targetSha256: sha256(fs.readFileSync(fs.realpathSync(binary))),
    versionOutput: output,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    } catch (error) {
      last = {error: error.message};
    }
    await sleep(500);
  }
  throw new Error(`tx ${hash} did not reach FINAL: ${JSON.stringify(last)}`);
}

function summaryGas(summary) {
  const tx = BigInt(summary?.transactionOutcome?.tokensBurntYocto ?? 0);
  const receipts = (summary?.receipts || []).reduce((sum, receipt) => sum + BigInt(receipt?.tokensBurntYocto ?? 0), 0n);
  return tx + receipts;
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
  const receiptFailure = receipts.some((receipt) => receipt.status?.Failure);
  return {
    transactionHash: final?.hash ?? null,
    finalExecutionStatus: final?.status?.final_execution_status ?? null,
    succeeded: final?.status?.final_execution_status === 'FINAL' && !final?.status?.transaction_outcome?.outcome?.status?.Failure,
    receiptFailure,
    transactionOutcomeStatus: txo?.outcome?.status ?? null,
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
        // The authority update carries the full candidate WASM as a FunctionCall
        // argument, and deploy carries it as contract code. Keep each action
        // shape and a digest, not a second copy of the bytes; the candidate file
        // itself is the byte-identity source.
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

async function viewJson(worker, id, method, args = {}) {
  const result = await worker.provider.viewCall(id, method, args, {finality: 'final'});
  if (!result || !Array.isArray(result.result)) throw new Error(`${method} returned no result`);
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

async function viewAmount(worker, id) {
  return (await worker.provider.viewAccount(id, {finality: 'final'})).amount;
}

async function viewToken(worker, id, method) {
  const result = await worker.provider.viewCall(id, method, {}, {finality: 'final'});
  if (!result || !Array.isArray(result.result)) throw new Error(`${method} returned no result`);
  const text = Buffer.from(result.result).toString('utf8');
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (value && typeof value.__near_token__ === 'string') return BigInt(value.__near_token__);
  if (value && typeof value.amount === 'string') return BigInt(value.amount);
  throw new Error(`${method} returned an unreadable NearToken: ${text.slice(0, 200)}`);
}

async function readState(worker, id) {
  return (await worker.provider.viewStateRaw(id, '', {finality: 'final'}))
    .map(({key, value}) => ({key, value}))
    .sort((a, b) => a.key.localeCompare(b.key));
}

const stateHash = (items) => sha256(JSON.stringify(items));

async function settle(worker, dao, proposer, recipient) {
  let previous = null;
  let stable = 0;
  for (let i = 0; i < 24; i += 1) {
    const observed = {
      contract: await viewAmount(worker, dao.accountId),
      proposer: await viewAmount(worker, proposer.accountId),
      recipient: await viewAmount(worker, recipient.accountId),
      state: stateHash(await readState(worker, dao.accountId)),
    };
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

async function snapshot(worker, dao, proposer, recipient, proposalId) {
  const account = await dao.accountView();
  const available = await viewToken(worker, dao.accountId, 'get_available_amount');
  const lockedStorage = await viewToken(worker, dao.accountId, 'get_locked_storage_amount');
  const balance = BigInt(account.amount);
  const locked = balance - lockedStorage - available;
  const state = await readState(worker, dao.accountId);
  return {
    codeHash: hashContract(await dao.viewCode()),
    state,
    stateHash: stateHash(state),
    policy: await viewJson(worker, dao.accountId, 'get_policy'),
    proposal: await viewJson(worker, dao.accountId, 'get_proposal', {id: proposalId}),
    contractBalance: account.amount,
    storageUsage: account.storage_usage,
    availableAmount: available.toString(),
    lockedStorageAmount: lockedStorage.toString(),
    lockedAmount: locked.toString(),
    proposerBalance: await viewAmount(worker, proposer.accountId),
    recipientBalance: await viewAmount(worker, recipient.accountId),
  };
}

async function createBase(worker) {
  const root = worker.rootAccount;
  const proposer = await root.createSubAccount('proposer', {initialBalance: parseNEAR('100')});
  const recipient = await root.createSubAccount('recipient', {initialBalance: parseNEAR('10')});
  const dao = await root.createSubAccount('dao', {initialBalance: parseNEAR('100')});
  const wasm = fs.readFileSync(DEFAULT_BASE);
  const deploy = await dao.deploy(wasm);
  const deployFinal = await finalStatus(worker, deploy, root.accountId);
  const init = await root.callRaw(dao, 'new', {
    config: {name: 'persisted-bond-recovery', purpose: 'bounded local inherited-state recovery', metadata: ''},
    policy: [proposer.accountId],
  }, {gas: GAS});
  const initFinal = await finalStatus(worker, init, root.accountId);
  for (let i = 0; i < 40; i += 1) {
    try { await viewJson(worker, dao.accountId, 'get_policy'); break; } catch { await sleep(250); }
  }
  return {root, proposer, recipient, dao, deploy: summarize(deployFinal), init: summarize(initFinal)};
}

function proposalKind() {
  return {
    FunctionCall: {
      receiver_id: MISSING_ID,
      actions: [{method_name: 'ping', args: '', deposit: '0', gas: ACTION_GAS.toString()}],
    },
  };
}

async function waitProposal(worker, dao, proposalId) {
  const deadline = Date.now() + MAX_WAIT_MS;
  let proposal;
  while (Date.now() < deadline) {
    proposal = await viewJson(worker, dao.accountId, 'get_proposal', {id: proposalId});
    if (proposal.status !== 'InProgress') return proposal;
    await sleep(500);
  }
  return proposal;
}

async function failProposal(worker, dao, proposer, recipient, kind) {
  const before = {
    contract: await viewAmount(worker, dao.accountId),
    proposer: await viewAmount(worker, proposer.accountId),
    recipient: await viewAmount(worker, recipient.accountId),
  };
  const add = await proposer.callRaw(dao, 'add_proposal', {
    proposal: {description: 'persisted-failure recovery proposal', kind},
  }, {gas: GAS, attachedDeposit: BOND});
  const addFinal = await finalStatus(worker, add, proposer.accountId);
  const proposalId = add.parseResult();
  const afterAdd = {
    contract: await viewAmount(worker, dao.accountId),
    proposer: await viewAmount(worker, proposer.accountId),
    proposal: await viewJson(worker, dao.accountId, 'get_proposal', {id: proposalId}),
  };
  const vote = await proposer.callRaw(dao, 'act_proposal', {id: proposalId, action: 'VoteApprove', proposal: kind}, {gas: GAS});
  const voteFinal = await finalStatus(worker, vote, proposer.accountId);
  const proposal = await waitProposal(worker, dao, proposalId);
  await settle(worker, dao, proposer, recipient);
  return {proposalId, before, afterAdd, add: summarize(addFinal), vote: summarize(voteFinal), proposal};
}

async function attempt(label, fn) {
  try {
    return {label, ok: true, executed: true, value: await fn()};
  } catch (error) {
    // A thrown RPC/transport error is not evidence that authority or a
    // settlement control was rejected. Acceptance must treat it as
    // inconclusive unless a final transaction outcome is present.
    return {label, ok: false, executed: false, error: String(error?.message || error).slice(0, 2000)};
  }
}

async function updateCode(worker, root, dao, wasm) {
  const result = await root.callRaw(dao, 'update', wasm, {gas: GAS});
  const final = await finalStatus(worker, result, root.accountId);
  return summarize(final);
}

async function accountDeployAndMigrate(worker, dao, wasm) {
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

async function runRecovery(worker, candidateWasm) {
  const base = await createBase(worker);
  const kind = proposalKind();
  const failed = await failProposal(worker, base.dao, base.proposer, base.recipient, kind);
  const frozen = await snapshot(worker, base.dao, base.proposer, base.recipient, failed.proposalId);
  const candidateHash = hashContract(candidateWasm);

  const unauthorizedUpdate = await attempt('unauthorized update', () => updateCode(worker, base.proposer, base.dao, candidateWasm));
  const unauthorizedUpdateRejected = unauthorizedUpdate.ok && unauthorizedUpdate.value?.receiptFailure === true;
  // An executed probe that did not fail is a demonstrated authority violation.
  // Keep it in the report so acceptance can reject it. A transport/runtime
  // failure has no executed transaction and remains inconclusive.
  if (!unauthorizedUpdate.ok) {
    throw new Error(`unauthorized update probe did not execute: ${unauthorizedUpdate.error || 'no transaction result'}`);
  }

  // The contract's factory `update` path deliberately creates a timed
  // UpgradeSelf proposal instead of deploying immediately. This runner uses
  // the account-key code-replacement path (deploy + private migrate), which is
  // the same state-preserving operation on this local account without new().
  const upgradeFinal = await accountDeployAndMigrate(worker, base.dao, candidateWasm);
  if (upgradeFinal.receiptFailure) throw new Error('account deploy/migrate receipt failed; refusing to call that recovery');
  await waitCode(worker, base.dao, candidateHash);
  const upgraded = await snapshot(worker, base.dao, base.proposer, base.recipient, failed.proposalId);

  const unauthorizedFinalize = await attempt('unauthorized finalize', async () => {
    const tx = await base.recipient.callRaw(base.dao, 'act_proposal', {id: failed.proposalId, action: 'Finalize', proposal: kind}, {gas: GAS});
    return summarize(await finalStatus(worker, tx, base.recipient.accountId));
  });
  const unauthorizedFinalizeRejected = unauthorizedFinalize.ok && unauthorizedFinalize.value?.receiptFailure === true;
  // As above: preserve an executed authority violation for the acceptance
  // report instead of turning it into a missing/inconclusive result.
  if (!unauthorizedFinalize.ok) {
    throw new Error(`unauthorized finalize probe did not execute: ${unauthorizedFinalize.error || 'no transaction result'}`);
  }

  // Authority probes can burn the probe signer's gas. Start the recovery
  // accounting after those probes so their gas is not misread as a payout.
  const preRecovery = await snapshot(worker, base.dao, base.proposer, base.recipient, failed.proposalId);

  const firstTx = await base.proposer.callRaw(base.dao, 'act_proposal', {id: failed.proposalId, action: 'Finalize', proposal: kind}, {gas: GAS});
  const firstFinal = await finalStatus(worker, firstTx, base.proposer.accountId);
  const firstProposal = await waitProposal(worker, base.dao, failed.proposalId);
  await settle(worker, base.dao, base.proposer, base.recipient);
  const first = await snapshot(worker, base.dao, base.proposer, base.recipient, failed.proposalId);

  const secondTx = await base.proposer.callRaw(base.dao, 'act_proposal', {id: failed.proposalId, action: 'Finalize', proposal: kind}, {gas: GAS});
  const secondFinal = await finalStatus(worker, secondTx, base.proposer.accountId);
  const secondProposal = await waitProposal(worker, base.dao, failed.proposalId);
  await settle(worker, base.dao, base.proposer, base.recipient);
  const second = await snapshot(worker, base.dao, base.proposer, base.recipient, failed.proposalId);

  const frozenLocked = BigInt(frozen.lockedAmount);
  const upgradedLocked = BigInt(upgraded.lockedAmount);
  const firstLocked = BigInt(first.lockedAmount);
  const secondLocked = BigInt(second.lockedAmount);
  const preRecoveryLocked = BigInt(preRecovery.lockedAmount);
  const firstDeltas = {
    contract: (BigInt(first.contractBalance) - BigInt(preRecovery.contractBalance)).toString(),
    proposer: (BigInt(first.proposerBalance) - BigInt(preRecovery.proposerBalance)).toString(),
    recipient: (BigInt(first.recipientBalance) - BigInt(preRecovery.recipientBalance)).toString(),
    locked: (firstLocked - preRecoveryLocked).toString(),
  };
  const secondDeltas = {
    contract: (BigInt(second.contractBalance) - BigInt(first.contractBalance)).toString(),
    proposer: (BigInt(second.proposerBalance) - BigInt(first.proposerBalance)).toString(),
    recipient: (BigInt(second.recipientBalance) - BigInt(first.recipientBalance)).toString(),
    locked: (secondLocked - firstLocked).toString(),
  };
  return {
    schema: 'near-rehearsal/persisted-bond-recovery/v1',
    generatedAt: new Date().toISOString(),
    caseId: 'sputnik-238-persisted-bond-recovery',
    source: {
      repository: 'https://github.com/near-daos/sputnik-dao-contract',
      commit: '5434a59dec23ee0c49df8c8c4350c208a7e75b0b',
      issue: 'https://github.com/near-daos/sputnik-dao-contract/issues/238',
      baseWasmSha256: sha256(fs.readFileSync(DEFAULT_BASE)),
      baseWasmHash: hashContract(fs.readFileSync(DEFAULT_BASE)),
    },
    candidate: {
      wasmSha256: sha256(candidateWasm),
      wasmHash: candidateHash,
      wasmBytes: candidateWasm.length,
    },
    runtime: null,
    initialization: {calls: 1, onlyOnce: true},
    accounts: {
      contract: base.dao.accountId,
      proposer: base.proposer.accountId,
      recipient: base.recipient.accountId,
      failedTarget: MISSING_ID,
      factory: base.root.accountId,
    },
    authority: {
      upgradeMethod: upgradeFinal.method,
      upgradeCaller: base.dao.accountId,
      unauthorizedUpdateRejected,
      unauthorizedUpdateError: unauthorizedUpdate.error || (unauthorizedUpdate.value?.receiptFailure ? 'update receipt failed' : null),
      unauthorizedUpdateProbe: unauthorizedUpdate,
      finalizeCaller: base.proposer.accountId,
      unauthorizedFinalizeRejected,
      unauthorizedFinalizeError: unauthorizedFinalize.error || null,
      unauthorizedFinalizeProbe: unauthorizedFinalize,
    },
    deploy: base.deploy,
    init: base.init,
    failed: {
      proposalId: failed.proposalId,
      proposal: failed.proposal,
      beforeProposal: failed.before,
      afterAdd: failed.afterAdd,
      add: failed.add,
      vote: failed.vote,
      frozen,
    },
    upgraded,
    preservation: {
      state: upgraded.stateHash === frozen.stateHash,
      policy: JSON.stringify(upgraded.policy) === JSON.stringify(frozen.policy),
      proposal: JSON.stringify(upgraded.proposal) === JSON.stringify(frozen.proposal),
      lockedAmount: upgraded.lockedAmount === frozen.lockedAmount,
      codeChanged: upgraded.codeHash === candidateHash && frozen.codeHash !== candidateHash,
      noNew: true,
    },
    upgrade: {
      final: upgradeFinal.deploy,
      migrate: upgradeFinal.migrate,
      method: upgradeFinal.method,
      codeHash: upgraded.codeHash,
      preservation: {
        state: upgraded.stateHash === frozen.stateHash,
        policy: JSON.stringify(upgraded.policy) === JSON.stringify(frozen.policy),
        proposal: JSON.stringify(upgraded.proposal) === JSON.stringify(frozen.proposal),
        lockedAmount: upgraded.lockedAmount === frozen.lockedAmount,
      },
    },
    preRecovery,
    firstRecovery: {
      final: summarize(firstFinal),
      proposal: firstProposal,
      before: preRecovery,
      after: first,
      deltas: firstDeltas,
      grossRecoveryYocto: (preRecoveryLocked - firstLocked).toString(),
      gasBurntYocto: summarize(firstFinal).gasBurntYocto,
      endedFailed: firstProposal.status === 'Failed',
      noTargetPayment: firstDeltas.recipient === '0',
    },
    secondRetry: {
      final: summarize(secondFinal),
      proposal: secondProposal,
      before: first,
      after: second,
      deltas: secondDeltas,
      grossRecoveryYocto: (firstLocked - secondLocked).toString(),
      gasBurntYocto: summarize(secondFinal).gasBurntYocto,
      endedFailed: secondProposal.status === 'Failed',
      noTargetPayment: secondDeltas.recipient === '0',
    },
    declared: {
      bondYocto: BOND.toString(),
      healthyTransferYocto: TRANSFER.toString(),
      accounting: 'gross bond recovery, gas burnt and net participant deltas are separate; raw native balances are not required to be numerically unchanged.',
    },
  };
}

async function runHealthyPreservation(worker, candidateWasm) {
  const base = await createBase(worker);
  const kind = {Transfer: {token_id: '', receiver_id: base.recipient.accountId, amount: TRANSFER.toString(), msg: null}};
  const before = {
    contract: await viewAmount(worker, base.dao.accountId),
    proposer: await viewAmount(worker, base.proposer.accountId),
    recipient: await viewAmount(worker, base.recipient.accountId),
  };
  const add = await base.proposer.callRaw(base.dao, 'add_proposal', {
    proposal: {description: 'past-settled healthy control', kind},
  }, {gas: GAS, attachedDeposit: BOND});
  const addFinal = await finalStatus(worker, add, base.proposer.accountId);
  const proposalId = add.parseResult();
  const vote = await base.proposer.callRaw(base.dao, 'act_proposal', {id: proposalId, action: 'VoteApprove', proposal: kind}, {gas: GAS});
  await finalStatus(worker, vote, base.proposer.accountId);
  await settle(worker, base.dao, base.proposer, base.recipient);
  const settled = await snapshot(worker, base.dao, base.proposer, base.recipient, proposalId);

  // A Transfer that is still InProgress on the old code. It was never approved
  // or paid before the code replacement, so this control exercises an inherited
  // pending obligation across the upgrade rather than a fresh payment.
  const pendingAdd = await base.proposer.callRaw(base.dao, 'add_proposal', {
    proposal: {description: 'inherited unpaid healthy control', kind},
  }, {gas: GAS, attachedDeposit: BOND});
  const pendingAddFinal = await finalStatus(worker, pendingAdd, base.proposer.accountId);
  const pendingId = pendingAdd.parseResult();
  const pendingBefore = await snapshot(worker, base.dao, base.proposer, base.recipient, pendingId);

  const candidateHash = hashContract(candidateWasm);
  const upgradeFinal = await accountDeployAndMigrate(worker, base.dao, candidateWasm);
  if (upgradeFinal.receiptFailure) throw new Error('past-settled control upgrade receipt failed');
  await waitCode(worker, base.dao, candidateHash);
  const afterUpgrade = await snapshot(worker, base.dao, base.proposer, base.recipient, proposalId);
  const pendingAfterUpgrade = await snapshot(worker, base.dao, base.proposer, base.recipient, pendingId);
  const finalizeAttempt = await attempt('finalize past-settled proposal', async () => {
    const tx = await base.proposer.callRaw(base.dao, 'act_proposal', {id: proposalId, action: 'Finalize', proposal: kind}, {gas: GAS});
    return summarize(await finalStatus(worker, tx, base.proposer.accountId));
  });
  const afterAttempt = await snapshot(worker, base.dao, base.proposer, base.recipient, proposalId);
  const pendingBeforePayout = await snapshot(worker, base.dao, base.proposer, base.recipient, pendingId);

  const pendingTx = await base.proposer.callRaw(base.dao, 'act_proposal', {id: pendingId, action: 'VoteApprove', proposal: kind}, {gas: GAS});
  const pendingFinal = await finalStatus(worker, pendingTx, base.proposer.accountId);
  const pendingProposal = await waitProposal(worker, base.dao, pendingId);
  await settle(worker, base.dao, base.proposer, base.recipient);
  const pendingAfter = await snapshot(worker, base.dao, base.proposer, base.recipient, pendingId);
  const pendingGas = summarize(pendingFinal).gasBurntYocto;
  const pendingDeltas = {
    contract: (BigInt(pendingAfter.contractBalance) - BigInt(pendingBeforePayout.contractBalance)).toString(),
    proposer: (BigInt(pendingAfter.proposerBalance) - BigInt(pendingBeforePayout.proposerBalance)).toString(),
    recipient: (BigInt(pendingAfter.recipientBalance) - BigInt(pendingBeforePayout.recipientBalance)).toString(),
    locked: (BigInt(pendingAfter.lockedAmount) - BigInt(pendingBeforePayout.lockedAmount)).toString(),
  };
  // Paying the inherited pending proposal once is not proof against a second
  // payout. Retry the now-Approved proposal and recompute its deltas after the
  // first payment has settled.
  const pendingRetry = await attempt('retry paid pending proposal', async () => {
    const tx = await base.proposer.callRaw(base.dao, 'act_proposal', {id: pendingId, action: 'Finalize', proposal: kind}, {gas: GAS});
    return summarize(await finalStatus(worker, tx, base.proposer.accountId));
  });
  await settle(worker, base.dao, base.proposer, base.recipient);
  const pendingRetryAfter = await snapshot(worker, base.dao, base.proposer, base.recipient, pendingId);
  const pendingRetryGas = pendingRetry.ok ? summaryGas(pendingRetry.value) : 0n;
  const pendingRetryDeltas = {
    contract: (BigInt(pendingRetryAfter.contractBalance) - BigInt(pendingAfter.contractBalance)).toString(),
    proposer: (BigInt(pendingRetryAfter.proposerBalance) - BigInt(pendingAfter.proposerBalance)).toString(),
    recipient: (BigInt(pendingRetryAfter.recipientBalance) - BigInt(pendingAfter.recipientBalance)).toString(),
    locked: (BigInt(pendingRetryAfter.lockedAmount) - BigInt(pendingAfter.lockedAmount)).toString(),
  };
  return {
    proposalId,
    before,
    add: summarize(addFinal),
    settled,
    pending: {
      proposalId: pendingId,
      add: summarize(pendingAddFinal),
      before: pendingBefore,
      afterUpgrade: pendingAfterUpgrade,
      beforePayout: pendingBeforePayout,
      final: summarize(pendingFinal),
      proposal: pendingProposal,
      after: pendingAfter,
      deltas: pendingDeltas,
      gasBurntYocto: pendingGas,
      retry: pendingRetry,
      retryAfter: pendingRetryAfter,
      retryDeltas: pendingRetryDeltas,
      retryGasBurntYocto: pendingRetryGas.toString(),
    },
    upgrade: upgradeFinal.deploy,
    migrate: upgradeFinal.migrate,
    upgradeMethod: upgradeFinal.method,
    afterUpgrade,
    finalizeAttempt,
    afterAttempt,
    checks: {
      settledApproved: settled.proposal.status === 'Approved',
      settledPayout: (BigInt(settled.recipientBalance) - BigInt(before.recipient)).toString(),
      upgradeCode: afterUpgrade.codeHash === candidateHash,
      proposalPreserved: JSON.stringify(afterUpgrade.proposal) === JSON.stringify(settled.proposal),
      recipientPreserved: afterUpgrade.recipientBalance === settled.recipientBalance,
      lockedCleared: settled.lockedAmount === '0' && pendingAfter.lockedAmount === '0',
      noFurtherPayout: afterAttempt.recipientBalance === settled.recipientBalance,
      pendingPreserved: JSON.stringify(pendingAfterUpgrade.proposal) === JSON.stringify(pendingBefore.proposal)
        && pendingAfterUpgrade.lockedAmount === pendingBefore.lockedAmount
        && pendingAfterUpgrade.codeHash === candidateHash,
      pendingPayout: pendingDeltas.recipient === TRANSFER.toString(),
      pendingBondReturned: BigInt(pendingDeltas.proposer) + BigInt(pendingGas) === BOND,
      pendingNoSecondPayout: pendingRetry.ok && pendingRetryDeltas.recipient === '0' && pendingRetryDeltas.contract === '0' && pendingRetryDeltas.locked === '0' && pendingRetryAfter.proposal?.status === 'Approved',
    },
  };
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(opts.out || DEFAULT_OUT);
  const candidatePath = opts.candidateWasm ? path.resolve(opts.candidateWasm) : null;
  if (!candidatePath) throw new Error('--candidate-wasm is required; do not use the authored control');
  const candidateWasm = fs.readFileSync(candidatePath);
  const candidateSha = sha256(candidateWasm);
  if (opts.expectedWasmSha256 && opts.expectedWasmSha256 !== candidateSha) throw new Error('candidate WASM SHA-256 mismatch');
  let identity = null;
  if (opts.candidateIdentity) {
    identity = JSON.parse(fs.readFileSync(path.resolve(opts.candidateIdentity), 'utf8'));
    if (identity?.wasm?.sha256 && identity.wasm.sha256 !== candidateSha) throw new Error('candidate identity WASM SHA-256 mismatch');
    if (identity?.patch?.sha256 && opts.candidatePatch) {
      const patchSha = sha256(fs.readFileSync(path.resolve(opts.candidatePatch)));
      if (patchSha !== identity.patch.sha256) throw new Error('candidate patch SHA-256 mismatch');
    }
    if (identity?.source?.sha256 && opts.candidateSource) {
      const sourceSha = sha256(fs.readFileSync(path.resolve(opts.candidateSource)));
      if (sourceSha !== identity.source.sha256) throw new Error('candidate source SHA-256 mismatch');
    }
  }
  const runtime = actualSandboxRuntime(opts);
  process.env.NEAR_SANDBOX_BIN_PATH = path.dirname(runtime.binary);
  process.env.NEAR_SANDBOX_BINARY_PATH = path.dirname(runtime.binary);
  process.env.NEAR_SANDBOX_VERSION = runtime.version;
  fs.mkdirSync(outDir, {recursive: true});
  const worker = await initWorker();
  let report;
  try {
    assertLocal(worker);
    report = await runRecovery(worker, candidateWasm);
    runtime.sandbox = runtime.version;
    report.runtime = runtime;
    const healthyWorker = await initWorker();
    try {
      assertLocal(healthyWorker);
      report.healthyPreservation = await runHealthyPreservation(healthyWorker, candidateWasm);
    } finally {
      await healthyWorker.tearDown?.().catch(() => {});
    }
  } finally {
    await worker.tearDown?.().catch(() => {});
  }
  report.identity = identity;
  const outFile = path.join(outDir, 'persisted-recovery.json');
  fs.writeFileSync(outFile, json(report));
  console.log(json({
    schema: 'near-rehearsal/persisted-bond-recovery-run/v1',
    out: outFile,
    candidateWasmSha256: report.candidate.wasmSha256,
    preservation: report.preservation,
    firstRecovery: report.firstRecovery && {grossRecoveryYocto: report.firstRecovery.grossRecoveryYocto, endedFailed: report.firstRecovery.endedFailed},
    secondRetry: report.secondRetry && {grossRecoveryYocto: report.secondRetry.grossRecoveryYocto, endedFailed: report.secondRetry.endedFailed},
  }));
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
