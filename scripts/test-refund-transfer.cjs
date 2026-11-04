'use strict';
/*
 * Reproducible local-Sandbox check for the supported funded-refund case.
 *
 * This is not a public-chain claim. It exercises the actual transfer action:
 * a contract holding 1.00 sandbox NEAR pays an existing user's 0.10 NEAR
 * refund entitlement and clears that entitlement.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {Worker, parseNEAR} = require('near-workspaces');

const ROOT = path.join(__dirname, '..');
const GAS = 100_000_000_000_000n;
const REFUND = 100_000_000_000_000_000_000_000n; // 0.10 NEAR
const read = (file) => fs.readFileSync(path.join(ROOT, file));

function assertLocal(worker) {
  const rpc = worker.config?.rpcAddr || worker.provider?.connection?.url;
  let host;
  try { host = new URL(rpc).hostname; } catch { throw new Error(`invalid execution RPC: ${rpc}`); }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`refusing non-local execution RPC: ${rpc}`);
}


async function waitForBalance(worker, accountId, predicate, attempts = 40) {
  let view;
  for (let i = 0; i < attempts; i++) {
    view = await waitForAccount(worker, accountId);
    if (predicate(balanceOf(view))) return view;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return view;
}

async function waitForAccount(worker, accountId, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try { return await worker.provider.viewAccount(accountId, {finality: 'final'}); }
    catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error(`account did not appear: ${accountId}`);
}

function amountOf(stateResult) {
  const bytes = Buffer.from(stateResult.result);
  assert.equal(bytes.length, 16, `expected a 16-byte refund entitlement, got ${bytes.length}`);
  return bytes.readBigUInt64LE(0) + (bytes.readBigUInt64LE(8) << 64n);
}

function balanceOf(view) {
  return BigInt(view.amount);
}

(async () => {
  let worker;
  try {
    worker = await Worker.init({network: 'sandbox'});
    assertLocal(worker);
    const runtime = await worker.provider.status();

    const contract = await worker.rootAccount.createSubAccount('refund', {initialBalance: parseNEAR('1')});
    await contract.deploy(read('contracts/refund-v1.wasm'));
    await contract.call(contract, 'init', {}, {gas: GAS});
    await waitForAccount(worker, contract.accountId);

    const user = await worker.rootAccount.createSubAccount('refunduser', {initialBalance: parseNEAR('10')});
    const userBefore = await waitForAccount(worker, user.accountId);
    const contractBefore = await waitForAccount(worker, contract.accountId);

    const entitlementBefore = amountOf(await worker.provider.viewCall(contract.accountId, 'get_refundable', {}, {finality: 'final'}));
    assert.equal(entitlementBefore, REFUND, 'initial entitlement must be 0.10 NEAR');

    const tx = await user.callRaw(contract, 'claim_refund', {}, {gas: GAS});
    assert.equal(tx.succeeded, true, 'claim transaction must succeed');
    assert.equal(tx.failed, false, 'claim transaction must not fail');
    assert.ok(Array.isArray(tx.result.receipts_outcome) && tx.result.receipts_outcome.length > 0, 'claim must produce receipts');

    let entitlementAfter = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      entitlementAfter = amountOf(await worker.provider.viewCall(contract.accountId, 'get_refundable', {}, {finality: 'final'}));
      if (entitlementAfter === 0n) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(entitlementAfter, 0n, 'claim must clear the entitlement');

    const contractAfter = await waitForBalance(worker, contract.accountId, (balance) => balance < balanceOf(contractBefore));
    const userAfter = await waitForBalance(worker, user.accountId, (balance) => balance > balanceOf(userBefore));
    const userDelta = balanceOf(userAfter) - balanceOf(userBefore);
    const contractDelta = balanceOf(contractAfter) - balanceOf(contractBefore);
    assert.ok(userDelta > 0n, 'user balance must increase after the refund transfer');
    assert.ok(contractDelta < 0n, 'contract balance must decrease after the refund transfer');
    assert.ok(userDelta < REFUND, 'net user increase must be below the gross refund after signer gas');

    const receiptStatuses = tx.result.receipts_outcome.map((r) => ({
      id: r.id,
      executorId: r.outcome.executor_id,
      status: r.outcome.status,
      logs: r.outcome.logs,
    }));
    const transactionHash = tx.result.transaction_outcome?.id ?? tx.result.transaction?.hash ?? null;

    console.log(JSON.stringify({
      check: 'funded refund claim transfers in local Sandbox',
      runtime: {
        version: runtime.version?.version ?? runtime.version ?? null,
        protocolVersion: runtime.protocol_version ?? null,
        commit: runtime.version?.commit ?? null,
      },
      contract: contract.accountId,
      user: user.accountId,
      transactionHash,
      entitlement: {before: entitlementBefore.toString(), after: entitlementAfter.toString()},
      balances: {
        contract: {before: balanceOf(contractBefore).toString(), after: balanceOf(contractAfter).toString(), delta: contractDelta.toString()},
        user: {before: balanceOf(userBefore).toString(), after: balanceOf(userAfter).toString(), delta: userDelta.toString()},
      },
      receiptStatuses,
    }, null, 2));
  } finally {
    if (worker) await worker.tearDown();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
