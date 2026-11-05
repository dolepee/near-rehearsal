'use strict';
/*
 * Import the captured public child DAO into local Sandbox, preserve raw code/state
 * and exact contract balance, then run the existing expired-proposal bond refund
 * locally. Actor funding and impersonation are recorded separately.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, KeyPair, parseNEAR, hashContract } = require('near-workspaces');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
const CAPTURE = path.join(OUT, 'capture.json');
const GAS = 100_000_000_000_000n;

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

async function main() {
  const capture = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));
  const worker = await Worker.init({ network: 'sandbox' });
  const result = { schema: 'near-rehearsal/public-capture-baseline/v1', source: capture.sourceAccount, block: capture.block, captureHashes: { code: capture.code.hash, state: capture.state.hash, codeSha256: capture.code.sha256 }, checks: {}, evidence: {} };
  try {
    await worker.provider.status();
    await worker.rootAccount.accountView();
    await sleep(500);
    const localBlock = await worker.provider.sendJsonRpc('block', { finality: 'final' });
    result.execution = { rpc: assertLocal(worker), runtime: await runtimeOf(worker), localBlock: { height: localBlock.header.height, hash: localBlock.header.hash, timestamp: localBlock.header.timestamp }, capturedBlock: { height: capture.block.height, hash: capture.block.hash, timestamp: capture.block.timestamp } };

    const contract = worker.rootAccount.getAccount(capture.sourceAccount);
    const code = Buffer.from(capture.code.base64, 'base64');
    const rb = contract.recordBuilder();
    rb.account({ ...capture.account, amount: capture.account.amount });
    rb.contract(code);
    for (const item of capture.state.items) rb.data(item.key, item.value);
    await contract.patchStateRecords(rb);
    await sleep(750);
    if (!(await contract.exists().catch(() => false))) {
      await sleep(500);
      await contract.patchStateRecords(rb);
    }
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (await contract.exists()) break;
    }
    if (!await contract.exists()) throw new Error('contract account did not appear');
    const importedCode = await contract.viewCode();
    const importedState = await readState(worker, contract.accountId);
    const importedView = await contract.accountView();
    result.import = {
      codeHash: hashContract(importedCode),
      codeSha256: sha256(importedCode),
      stateHash: stateHash(importedState),
      stateBytes: b64len(importedState),
      stateCount: importedState.length,
      balance: importedView.amount,
      storageUsage: importedView.storage_usage,
      matches: hashContract(importedCode) === capture.code.hash && stateHash(importedState) === capture.state.hash,
    };
    if (!result.import.matches) throw new Error('imported code/state hash mismatch');

    const actor = worker.rootAccount.getAccount(capture.proposal.proposer);
    const actorKey = KeyPair.fromRandom('ed25519');
    const actorRb = actor.recordBuilder();
    const capturedActorAmount = BigInt(capture.proposerAccount.amount);
    const localActorAmount = parseNEAR('60');
    actorRb.account({ amount: localActorAmount.toString(), code_hash: '11111111111111111111111111111111', storage_usage: capture.proposerAccount.storage_usage, locked: '0' });
    actorRb.accessKey(actorKey.getPublicKey());
    await actor.patchStateRecords(actorRb);
    await actor.setKey(actorKey);
    result.actor = {
      account: actor.accountId,
      capturedAmount: capturedActorAmount.toString(),
      localFundingYocto: localActorAmount.toString(),
      capturedBalancePreserved: false,
      impersonation: 'Local access key created for the captured proposer/council account; no production key used.',
    };

    // Sanity: policy and proposal views survive import.
    const policyBefore = await viewJson(worker, contract.accountId, 'get_policy');
    const proposalBefore = await viewJson(worker, contract.accountId, 'get_proposal', { id: capture.proposal.id });
    result.views = { policyBefore, proposalBefore };

    const contractBefore = await contract.accountView();
    const actorBefore = await actor.accountView();
    const args = { id: capture.proposal.id, action: 'Finalize', proposal: capture.proposal.kind, memo: null };
    const tx = await actor.callRaw(contract, 'act_proposal', args, { gas: GAS });
    await sleep(1000);
    const contractAfter = await contract.accountView();
    const actorAfter = await actor.accountView();
    let txStatus = null;
    try {
      txStatus = await worker.provider.sendJsonRpc('tx', { tx_hash: tx.transactionReceipt.hash, sender_account_id: actor.accountId, wait_until: 'FINAL' });
    } catch (e) {
      result.txStatusError = e.message;
    }
    const proposalAfter = await viewJson(worker, contract.accountId, 'get_proposal', { id: capture.proposal.id });
    const stateAfter = await readState(worker, contract.accountId);
    result.baseline = {
      operation: 'Finalize on captured expired proposal',
      tx: {
        succeeded: tx.succeeded, failed: tx.failed, failure: tx.Failure ?? null,
        transactionHash: tx.transactionReceipt?.hash ?? null,
        logs: tx.logs ?? [], receiptFailures: tx.receiptFailures ?? [], receiptFailureMessages: tx.receiptFailureMessages ?? [],
      },
      balances: {
        contractBefore: contractBefore.amount, contractAfter: contractAfter.amount,
        actorBefore: actorBefore.amount, actorAfter: actorAfter.amount,
        gasBurnt: tx.gas_burnt ?? null,
      },
      proposalAfter,
      stateHashAfter: stateHash(stateAfter),
    };
    result.checks.baselineSucceeded = tx.succeeded === true && tx.failed === false;
    result.checks.proposalResolved = proposalAfter?.status === 'Expired' || proposalAfter?.status === 'Rejected';
    result.checks.contractFundsDecreased = BigInt(contractAfter.amount) < BigInt(contractBefore.amount);
    result.checks.actorFundsChanged = BigInt(actorAfter.amount) !== BigInt(actorBefore.amount);
    result.checks.stateChanged = result.baseline.stateHashAfter !== capture.state.hash;
    result.baseline.payout = { recipient: proposalAfter.proposer, declaredBond: policyBefore.proposal_bond, contractDeltaYocto: (BigInt(contractAfter.amount) - BigInt(contractBefore.amount)).toString(), actorDeltaYocto: (BigInt(actorAfter.amount) - BigInt(actorBefore.amount)).toString(), gasBurntYocto: tx.gas_burnt?.toString() ?? null };
    if (txStatus) result.baseline.txStatus = txStatus;

    // A retry must not pay again. Capture the failure and require no state change after it.
    const beforeRetryState = stateHash(await readState(worker, contract.accountId));
    const retry = await actor.callRaw(contract, 'act_proposal', args, { gas: GAS });
    await sleep(500);
    const afterRetryState = stateHash(await readState(worker, contract.accountId));
    result.retry = {
      failed: retry.failed, failure: retry.Failure ?? null, logs: retry.logs ?? [],
      stateUnchanged: beforeRetryState === afterRetryState,
    };
    result.checks.retryDidNotPayAgain = retry.failed === true && result.retry.stateUnchanged === true;

    // Unauthorized actor must fail without mutating state.
    const intruder = await worker.rootAccount.createSubAccount('intruder', { keyPair: KeyPair.fromRandom('ed25519'), initialBalance: parseNEAR('10') });
    const beforeUnauthorized = stateHash(await readState(worker, contract.accountId));
    const unauthorized = await intruder.callRaw(contract, 'act_proposal', args, { gas: GAS });
    await sleep(500);
    const afterUnauthorized = stateHash(await readState(worker, contract.accountId));
    result.unauthorized = {
      failed: unauthorized.failed, failure: unauthorized.Failure ?? null, logs: unauthorized.logs ?? [],
      stateUnchanged: beforeUnauthorized === afterUnauthorized,
    };
    result.checks.unauthorizedFailedWithoutMutation = unauthorized.failed === true && result.unauthorized.stateUnchanged === true;

    result.verdict = Object.values(result.checks).every(Boolean) ? 'capture-baseline-verified' : 'capture-baseline-incomplete';
  } catch (e) {
    result.error = { name: e.name, message: e.message, stack: e.stack };
    result.verdict = 'capture-baseline-inconclusive';
  } finally {
    await worker.tearDown();
  }
  fs.writeFileSync(path.join(OUT, 'baseline.json'), json(result) + '\n');
  console.log(json({ verdict: result.verdict, checks: result.checks, error: result.error?.message, import: result.import, baseline: result.baseline?.tx, retry: result.retry, unauthorized: result.unauthorized }));
  if (result.verdict !== 'capture-baseline-verified') process.exitCode = 1;
}

main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
