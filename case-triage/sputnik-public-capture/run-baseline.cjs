'use strict';
/*
 * Import the captured public child DAO into local Sandbox, preserve raw code/state
 * and exact contract balance, then run the existing expired-proposal bond refund
 * locally. Evidence is captured after a finality barrier, not after a fixed sleep.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, KeyPair, parseNEAR, hashContract } = require('near-workspaces');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
const CAPTURE = path.join(OUT, 'capture.json');
const GAS = 100_000_000_000_000n;
const MAX_WAIT_MS = 60_000;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const json = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sorted = (items) => items.map(({ key, value }) => ({ key, value }))
  .sort((a, b) => a.key.localeCompare(b.key));
const stateHash = (items) => sha256(JSON.stringify(sorted(items)));
const b64len = (items) => items.reduce((n, x) => n + Buffer.from(x.value, 'base64').length, 0);

function assertLocal(worker) {
  const rpc = worker.config?.rpcAddr || worker.provider?.connection?.url;
  if (!rpc) throw new Error('execution RPC address is missing');
  const host = new URL(rpc).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`refusing non-local execution RPC: ${rpc}`);
  return rpc;
}
async function runtimeOf(worker) {
  const s = await worker.provider.status();
  return {
    version: s.version?.version ?? s.version ?? null,
    build: s.version?.build ?? null,
    commit: s.version?.commit ?? null,
    protocolVersion: s.protocol_version ?? null,
    latestProtocolVersion: s.latest_protocol_version ?? null,
  };
}
async function readState(worker, accountId) {
  return sorted((await worker.provider.viewStateRaw(accountId, '', { finality: 'final' }))
    .map(({ key, value }) => ({ key, value })));
}
async function viewJson(worker, accountId, method, args = {}) {
  const r = await worker.provider.viewCall(accountId, method, args, { finality: 'final' });
  if (!r || !Array.isArray(r.result)) throw new Error(`${method} returned no byte array`);
  return JSON.parse(Buffer.from(r.result).toString('utf8'));
}
async function finalStatus(worker, tx, senderAccountId) {
  const hash = tx?.transactionReceipt?.hash;
  if (!hash) throw new Error('transaction has no receipt hash');
  const started = Date.now();
  let last;
  while (Date.now() - started < MAX_WAIT_MS) {
    try {
      const status = await worker.provider.sendJsonRpc('tx', {
        tx_hash: hash, sender_account_id: senderAccountId, wait_until: 'FINAL',
      });
      if (status?.final_execution_status === 'FINAL') return status;
      last = status;
    } catch (e) { last = { error: e.message }; }
    await sleep(500);
  }
  throw new Error(`transaction ${hash} did not reach FINAL: ${JSON.stringify(last)}`);
}
function summarizeTx(tx, status) {
  const txOutcome = status?.transaction_outcome;
  const outcome = txOutcome?.outcome;
  const receipts = (status?.receipts_outcome || []).map((r) => ({
    id: r.id,
    executorId: r.outcome?.executor_id ?? null,
    gasBurntUnits: r.outcome?.gas_burnt?.toString() ?? null,
    tokensBurntYocto: r.outcome?.tokens_burnt?.toString() ?? null,
    status: r.outcome?.status ?? null,
    logs: r.outcome?.logs ?? [],
  }));
  const txTokens = BigInt(outcome?.tokens_burnt ?? 0);
  const receiptTokens = receipts.reduce((n, r) => n + BigInt(r.tokensBurntYocto ?? 0), 0n);
  return {
    succeeded: tx?.succeeded === true,
    failed: tx?.failed === true,
    failure: tx?.Failure ?? null,
    transactionHash: tx?.transactionReceipt?.hash ?? null,
    finalExecutionStatus: status?.final_execution_status ?? null,
    transaction: {
      signerId: status?.transaction?.signer_id ?? null,
      receiverId: status?.transaction?.receiver_id ?? null,
      actions: status?.transaction?.actions ?? [],
      transactionOutcomeBlockHash: txOutcome?.block_hash ?? null,
    },
    receiptIds: outcome?.receipt_ids ?? [],
    gasBurntUnits: outcome?.gas_burnt?.toString() ?? null,
    transactionOutcomeTokensBurntYocto: txTokens.toString(),
    receiptTokensBurntYocto: receiptTokens.toString(),
    totalTokensBurntYocto: (txTokens + receiptTokens).toString(),
    receipts,
    transactionOutcomeStatus: outcome?.status ?? null,
    logs: outcome?.logs ?? tx?.logs ?? [],
    receiptFailures: tx?.receiptFailures ?? [],
    receiptFailureMessages: tx?.receiptFailureMessages ?? [],
  };
}
async function importCapture(worker, capture) {
  const contract = worker.rootAccount.getAccount(capture.sourceAccount);
  const code = Buffer.from(capture.code.base64, 'base64');
  const rb = contract.recordBuilder();
  rb.account({ ...capture.account, amount: capture.account.amount });
  rb.contract(code);
  for (const item of capture.state.items) rb.data(item.key, item.value);
  await contract.patchStateRecords(rb);
  await sleep(750);
  if (!(await contract.exists().catch(() => false))) {
    await contract.patchStateRecords(rb);
    await sleep(750);
  }
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await contract.exists()) break;
  }
  if (!(await contract.exists())) throw new Error('captured contract account did not import');
  const importedCode = await contract.viewCode();
  const importedState = await readState(worker, contract.accountId);
  const importedView = await contract.accountView();
  const check = {
    codeHash: hashContract(importedCode),
    codeSha256: sha256(importedCode),
    stateHash: stateHash(importedState),
    stateBytes: b64len(importedState),
    stateCount: importedState.length,
    balance: importedView.amount,
    storageUsage: importedView.storage_usage,
    matches: hashContract(importedCode) === capture.code.hash && stateHash(importedState) === capture.state.hash,
  };
  if (!check.matches) throw new Error('imported code/state hash mismatch');
  if (check.balance !== capture.account.amount) throw new Error('captured contract balance mismatch');
  return { contract, check };
}
async function setupActor(worker, capture) {
  const actor = worker.rootAccount.getAccount(capture.proposal.proposer);
  const actorKey = KeyPair.fromRandom('ed25519');
  const actorRb = actor.recordBuilder();
  actorRb.account({
    amount: parseNEAR('60').toString(),
    code_hash: '11111111111111111111111111111111',
    storage_usage: capture.proposerAccount.storage_usage,
    locked: '0',
  });
  actorRb.accessKey(actorKey.getPublicKey());
  await actor.patchStateRecords(actorRb);
  await sleep(750);
  if (!(await actor.exists().catch(() => false))) {
    await actor.patchStateRecords(actorRb);
    await sleep(750);
  }
  await actor.setKey(actorKey);
  const actorPub = actorKey.getPublicKey().toString();
  const storedKey = await actor.getKey();
  let accessKeyView;
  for (let i = 0; i < 40; i++) {
    try {
      accessKeyView = await worker.provider.viewAccessKey(actor.accountId, actorPub, { finality: 'final' });
      break;
    } catch (e) {
      if (i === 39) throw new Error(`actor access key did not appear: ${e.message}`);
      await sleep(250);
    }
  }
  return {
    actor,
    evidence: {
      account: actor.accountId,
      capturedAmountYocto: capture.proposerAccount.amount,
      localFundingYocto: parseNEAR('60').toString(),
      capturedBalancePreserved: false,
      publicKey: actorPub,
      keyStorePublicKey: storedKey.getPublicKey().toString(),
      accessKeyView,
      impersonation: 'Local access key created for the captured proposer/council account; no production key used.',
    },
  };
}

async function main() {
  const capture = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));
  const worker = await Worker.init({ network: 'sandbox' });
  const result = {
    schema: 'near-rehearsal/public-capture-baseline/v2',
    source: capture.sourceAccount,
    block: capture.block,
    captureHashes: { code: capture.code.hash, state: capture.state.hash, codeSha256: capture.code.sha256 },
    checks: {},
    evidence: {},
  };
  try {
    await worker.provider.status();
    await worker.rootAccount.accountView();
    await sleep(500);
    const localBlock = await worker.provider.sendJsonRpc('block', { finality: 'final' });
    result.execution = {
      rpc: assertLocal(worker),
      runtime: await runtimeOf(worker),
      localBlock: { height: localBlock.header.height, hash: localBlock.header.hash, timestamp: String(localBlock.header.timestamp_nanosec ?? localBlock.header.timestamp) },
      capturedBlock: { height: capture.block.height, hash: capture.block.hash, timestamp: String(capture.block.timestamp_nanosec ?? capture.block.timestamp) },
    };

    const imported = await importCapture(worker, capture);
    result.import = imported.check;
    const { actor, evidence: actorEvidence } = await setupActor(worker, capture);
    result.actor = actorEvidence;

    const policyBefore = await viewJson(worker, imported.contract.accountId, 'get_policy');
    const proposalBefore = await viewJson(worker, imported.contract.accountId, 'get_proposal', { id: capture.proposal.id });
    result.views = { policyBefore, proposalBefore };

    const contractBefore = await imported.contract.accountView();
    const actorBefore = await actor.accountView();
    const args = { id: capture.proposal.id, action: 'Finalize', proposal: capture.proposal.kind, memo: null };

    const tx = await actor.callRaw(imported.contract, 'act_proposal', args, { gas: GAS });
    const txStatus = await finalStatus(worker, tx, actor.accountId);
    const contractAfter = await imported.contract.accountView();
    const actorAfter = await actor.accountView();
    const proposalAfter = await viewJson(worker, imported.contract.accountId, 'get_proposal', { id: capture.proposal.id });
    const stateAfter = await readState(worker, imported.contract.accountId);
    result.baseline = {
      operation: 'Finalize on captured expired proposal',
      tx: summarizeTx(tx, txStatus),
      balances: {
        contractBefore: contractBefore.amount,
        contractAfter: contractAfter.amount,
        actorBefore: actorBefore.amount,
        actorAfter: actorAfter.amount,
      },
      proposalAfter,
      stateHashAfter: stateHash(stateAfter),
      payout: {
        recipient: proposalAfter.proposer,
        declaredBondYocto: policyBefore.proposal_bond,
        contractDeltaYocto: (BigInt(contractAfter.amount) - BigInt(contractBefore.amount)).toString(),
        actorDeltaYocto: (BigInt(actorAfter.amount) - BigInt(actorBefore.amount)).toString(),
        gasBurntUnits: txStatus?.transaction_outcome?.outcome?.gas_burnt?.toString() ?? null,
        transactionOutcomeTokensBurntYocto: txStatus?.transaction_outcome?.outcome?.tokens_burnt?.toString() ?? null,
        receiptTokensBurntYocto: summarizeTx(tx, txStatus).receiptTokensBurntYocto,
        totalTokensBurntYocto: summarizeTx(tx, txStatus).totalTokensBurntYocto,
      },
    };
    result.checks.baselineSucceeded = tx.succeeded === true && tx.failed === false && txStatus?.transaction_outcome?.outcome?.status !== undefined;
    result.checks.proposalResolved = proposalAfter?.status === 'Expired' || proposalAfter?.status === 'Rejected';
    result.checks.contractFundsDecreased = BigInt(contractAfter.amount) < BigInt(contractBefore.amount);
    result.checks.actorFundsChanged = BigInt(actorAfter.amount) !== BigInt(actorBefore.amount);
    result.checks.stateChanged = result.baseline.stateHashAfter !== capture.state.hash;

    const beforeRetryState = stateHash(await readState(worker, imported.contract.accountId));
    const beforeRetryContract = await imported.contract.accountView();
    const beforeRetryActor = await actor.accountView();
    const retry = await actor.callRaw(imported.contract, 'act_proposal', args, { gas: GAS });
    const retryStatus = await finalStatus(worker, retry, actor.accountId);
    const afterRetryState = stateHash(await readState(worker, imported.contract.accountId));
    const afterRetryContract = await imported.contract.accountView();
    const afterRetryActor = await actor.accountView();
    result.retry = {
      tx: summarizeTx(retry, retryStatus),
      stateUnchanged: beforeRetryState === afterRetryState,
      contractBefore: beforeRetryContract.amount,
      contractAfter: afterRetryContract.amount,
      contractDeltaYocto: (BigInt(afterRetryContract.amount) - BigInt(beforeRetryContract.amount)).toString(),
      actorDeltaYocto: (BigInt(afterRetryActor.amount) - BigInt(beforeRetryActor.amount)).toString(),
      stateHashBefore: beforeRetryState,
      stateHashAfter: afterRetryState,
    };
    result.checks.retryDidNotPayAgain = retry.failed === true && result.retry.tx.finalExecutionStatus === 'FINAL' && result.retry.stateUnchanged && BigInt(result.retry.contractDeltaYocto) > -BigInt(policyBefore.proposal_bond) / 2n && BigInt(result.retry.actorDeltaYocto) <= 0n;

    const intruder = await worker.rootAccount.createSubAccount('intruder', { keyPair: KeyPair.fromRandom('ed25519'), initialBalance: parseNEAR('10') });
    const beforeUnauthorizedState = stateHash(await readState(worker, imported.contract.accountId));
    const beforeUnauthorizedContract = await imported.contract.accountView();
    const beforeUnauthorizedActor = await actor.accountView();
    const unauthorized = await intruder.callRaw(imported.contract, 'act_proposal', args, { gas: GAS });
    const unauthorizedStatus = await finalStatus(worker, unauthorized, intruder.accountId);
    const afterUnauthorizedState = stateHash(await readState(worker, imported.contract.accountId));
    const afterUnauthorizedContract = await imported.contract.accountView();
    const afterUnauthorizedActor = await actor.accountView();
    result.unauthorized = {
      tx: summarizeTx(unauthorized, unauthorizedStatus),
      stateUnchanged: beforeUnauthorizedState === afterUnauthorizedState,
      contractBefore: beforeUnauthorizedContract.amount,
      contractAfter: afterUnauthorizedContract.amount,
      contractDeltaYocto: (BigInt(afterUnauthorizedContract.amount) - BigInt(beforeUnauthorizedContract.amount)).toString(),
      proposerUnchanged: beforeUnauthorizedActor.amount === afterUnauthorizedActor.amount,
      stateHashBefore: beforeUnauthorizedState,
      stateHashAfter: afterUnauthorizedState,
    };
    result.checks.unauthorizedFailedWithoutMutation = unauthorized.failed === true && result.unauthorized.tx.finalExecutionStatus === 'FINAL' && result.unauthorized.stateUnchanged && BigInt(result.unauthorized.contractDeltaYocto) > -BigInt(policyBefore.proposal_bond) / 2n && result.unauthorized.proposerUnchanged;

    result.verdict = Object.values(result.checks).every(Boolean) ? 'capture-baseline-verified' : 'capture-baseline-incomplete';
  } catch (e) {
    result.error = { name: e.name, message: e.message, stack: e.stack };
    result.verdict = 'capture-baseline-inconclusive';
  } finally {
    await worker.tearDown();
  }
  const output = path.join(OUT, result.verdict === 'capture-baseline-verified' ? 'baseline.json' : 'baseline-failure.json');
  fs.writeFileSync(output, json(result) + '\n');
  console.log(json({ verdict: result.verdict, checks: result.checks, error: result.error?.message, import: result.import, baseline: result.baseline?.tx, retry: result.retry?.tx, unauthorized: result.unauthorized?.tx }));
  if (result.verdict !== 'capture-baseline-verified') process.exitCode = 1;
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
