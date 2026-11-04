'use strict';
// Local experiment with an explicitly seeded callback regression, not an audit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, parseNEAR } = require('near-workspaces');
// Historical Sandbox predates send_tx. Keep the serialized signed transaction
// unchanged and use its documented legacy wait-for-completion RPC instead.
if (process.env.REHEARSAL_LEGACY_RPC === '1') {
  const { JsonRpcProvider } = require('@near-js/providers');
  const { encodeTransaction } = require('@near-js/transactions');
  JsonRpcProvider.prototype.sendTransactionUntil = function (signedTransaction, waitUntil) {
    assert.notEqual(waitUntil, 'NONE', 'This probe only supports completed transactions');
    return this.sendJsonRpc('broadcast_tx_commit', [Buffer.from(encodeTransaction(signedTransaction)).toString('base64')]);
  };
}
const { patchExportToTrap } = require('./patch-wasm.cjs');
const dir = __dirname;
const original = fs.readFileSync(path.join(dir, 'fixtures/fungible_token.wasm'));
const receiverWasm = fs.readFileSync(path.join(dir, 'fixtures/defi.wasm'));
const patched = patchExportToTrap(original, 'ft_resolve_transfer');
assert(WebAssembly.validate(patched.output));
fs.writeFileSync(path.join(dir, 'fixtures/fungible_token_callback_trap.wasm'), patched.output);
const gas = 150000000000000n;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
async function snapshot(ft) {
  const [code, state] = await Promise.all([ft.viewCode(), ft.viewStateRaw()]);
  const orderedState = state.map(s => ({ key: s.key, value: s.value })).sort((a, b) => a.key.localeCompare(b.key));
  return { codeSha256: hash(code), stateSha256: hash(JSON.stringify(orderedState)), state: orderedState };
}
async function ledger(ft, owner, receiver) {
  const [a, b, s] = await Promise.all([
    ft.view('ft_balance_of', { account_id: owner.accountId }),
    ft.view('ft_balance_of', { account_id: receiver.accountId }),
    ft.view('ft_total_supply', {}),
  ]);
  return { owner: String(a), receiver: String(b), supply: String(s) };
}
async function run(id, options = {}) {
  console.log(`Starting ${id}`);
  const worker = await Worker.init();
  try {
    const runtime = await worker.provider.status();
    const owner = worker.rootAccount;
    const ft = await owner.createSubAccount('token', { initialBalance: BigInt(parseNEAR('10')) });
    const receiver = await owner.createSubAccount('receiver', { initialBalance: BigInt(parseNEAR('10')) });
    await ft.deploy(original);
    await receiver.deploy(receiverWasm);
    await owner.call(ft, 'new_default_meta', { owner_id: owner.accountId, total_supply: '10000' });
    await receiver.call(receiver, 'new', { fungible_token_account_id: ft.accountId });
    await owner.call(ft, 'storage_deposit', { account_id: receiver.accountId }, { attachedDeposit: BigInt(parseNEAR('0.0015')) });
    const before = await ledger(ft, owner, receiver);
    const snapshotBefore = await snapshot(ft);
    assert.deepEqual(before, { owner: '10000', receiver: '0', supply: '10000' });
    const deployments = [{ role: 'upstream_baseline', sha256: hash(original) }];
    if (options.upgrade) {
      await ft.deploy(patched.output);
      deployments.push({ role: 'deliberately_seeded_callback_regression', sha256: hash(patched.output) });
      assert.deepEqual(await ledger(ft, owner, receiver), before);
      assert.equal((await snapshot(ft)).stateSha256, snapshotBefore.stateSha256, 'Code-only candidate upgrade preserves full contract storage');
    }
    if (options.repair) {
      await ft.deploy(original);
      deployments.push({ role: 'restore_upstream_original_before_transaction', sha256: hash(original) });
      assert.deepEqual(await ledger(ft, owner, receiver), before);
    }
    const snapshotAfterDeployment = await snapshot(ft);
    // A normal transfer still works in the candidate; only its callback was changed.
    const controlOut = await owner.callRaw(ft, 'ft_transfer', { receiver_id: receiver.accountId, amount: '1' }, { attachedDeposit: 1n, gas });
    const controlBack = await receiver.callRaw(ft, 'ft_transfer', { receiver_id: owner.accountId, amount: '1' }, { attachedDeposit: 1n, gas });
    assert.equal(controlOut.succeeded, true);
    assert.equal(controlBack.succeeded, true);
    assert.deepEqual(await ledger(ft, owner, receiver), before);
    const args = { receiver_id: receiver.accountId, amount: '100', msg: options.reject ? "this won't parse as an integer" : 'take-my-money' };
    const tx = await owner.callRaw(ft, 'ft_transfer_call', args, { attachedDeposit: 1n, gas });
    const after = await ledger(ft, owner, receiver);
    const out = {
      id, execution: 'real NEAR Sandbox, local only',
      runtime: { version: runtime.version, protocolVersion: runtime.protocol_version, latestProtocolVersion: runtime.latest_protocol_version },
      seededFault: options.upgrade ? patched.metadata : null,
      repairAppliedBeforeTest: !!options.repair,
      accounts: { owner: owner.accountId, token: ft.accountId, receiver: receiver.accountId },
      deployments, before, beforeLedgerDigest: hash(JSON.stringify(before)),
      snapshotBefore, snapshotAfterDeployment,
      ordinaryTransferControl: { outSucceeded: controlOut.succeeded, backSucceeded: controlBack.succeeded, outHash: controlOut.result.transaction.hash, backHash: controlBack.result.transaction.hash },
      invocation: { method: 'ft_transfer_call', args, attachedDepositYoctoNEAR: '1', prepaidGas: gas.toString() },
      transactionHash: tx.result.transaction.hash,
      finalStatus: tx.result.status, finalSucceeded: tx.succeeded,
      receiptFailureMessages: tx.receiptFailureMessages,
      receipts: tx.result.receipts_outcome.map(r => ({
        id: r.id, blockHash: r.block_hash, executor: r.outcome.executor_id,
        spawnedReceipts: r.outcome.receipt_ids, status: r.outcome.status,
        logs: r.outcome.logs, gasBurnt: String(r.outcome.gas_burnt),
      })),
      after,
      tokenDelta: { owner: (BigInt(after.owner) - BigInt(before.owner)).toString(), receiver: (BigInt(after.receiver) - BigInt(before.receiver)).toString() },
      invariant: {
        totalSupplyUnchanged: after.supply === before.supply,
        balancesConserved: BigInt(after.owner) + BigInt(after.receiver) === BigInt(after.supply),
        rejectedTransferRefunded: options.reject ? after.owner === before.owner && after.receiver === before.receiver : null,
      }, rawOutcomeFile: `raw/${id}.json`,
    };
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
    fs.writeFileSync(path.join(dir, out.rawOutcomeFile), json(tx.result) + '\n');
    console.log(json({ id, finalSucceeded: out.finalSucceeded, before, after, failedReceipts: out.receiptFailureMessages.length }));
    return out;
  } finally { await worker.tearDown(); }
}
async function main() {
  const scenarios = [];
  scenarios.push(await run('accepted_transfer'));
  scenarios.push(await run('receiver_rejects_baseline', { reject: true }));
  scenarios.push(await run('receiver_rejects_seeded_upgrade', { reject: true, upgrade: true }));
  scenarios.push(await run('receiver_rejects_repaired_upgrade', { reject: true, upgrade: true, repair: true }));
  assert.deepEqual(scenarios[0].after, { owner: '9900', receiver: '100', supply: '10000' });
  assert.deepEqual(scenarios[1].after, { owner: '10000', receiver: '0', supply: '10000' });
  assert.equal(scenarios[1].finalSucceeded, true);
  assert(scenarios[1].receiptFailureMessages.some(m => m.includes('ParseIntError')));
  assert.deepEqual(scenarios[2].after, { owner: '9900', receiver: '100', supply: '10000' });
  assert.equal(scenarios[2].finalSucceeded, false);
  assert.equal(scenarios[2].invariant.rejectedTransferRefunded, false);
  assert.deepEqual(scenarios[3].after, scenarios[1].after);
  assert.equal(scenarios[3].finalSucceeded, true);
  assert(scenarios.every(s => s.beforeLedgerDigest === scenarios[0].beforeLedgerDigest));
  assert(scenarios.every(s => s.snapshotBefore.stateSha256 === scenarios[0].snapshotBefore.stateSha256), 'All branches must begin from byte-identical FT storage');
  const report = {
    generatedAt: new Date().toISOString(),
    clientCompatibility: { nearWorkspaces: '5.0.0', loopbackHealthCheckFix: true, circularDiagnosticFix: true, legacyBroadcastRpc: process.env.REHEARSAL_LEGACY_RPC === '1' },
    purpose: 'Distinguish receipt failure, final status, and actual token balance consequences across a real locally deployed candidate upgrade.',
    claims: [
      'Upstream test Wasm contracts have pinned provenance.',
      'Each fresh Sandbox scenario starts from identical observed FT balances and supply.',
      'The candidate is deployed onto an initialized FT contract, preserving its prior observed ledger.',
      'The callback trap is deliberately seeded, not a newly discovered vulnerability.',
      'No mainnet or public testnet writes or user assets are involved.',
    ],
    limits: [
      'Controlled fixture, not historical live-chain state replay.',
      'Matching initial FT ledger does not assert identical global chain state or gas.',
      process.env.REHEARSAL_LEGACY_RPC === '1' ? 'The execution environment caps file descriptors at 16384; current Sandbox requires 65535. This run uses an unmodified official1.29.0 Sandbox binary (protocol56), not current protocol parity. Rerun on current Sandbox is required before a release-readiness claim.' : 'The runtime version in each scenario is authoritative. Local Sandbox is not a universal guarantee of live-network behavior.',
      'Repair occurs before the new test transaction and does not recover an already completed failing transfer.',
      'No arbitrary migrations, universal safety, or human usability is established.',
    ],
    provenance: JSON.parse(fs.readFileSync(path.join(dir, 'provenance.json'), 'utf8')),
    mutation: patched.metadata, scenarios, assertionsPassed: true,
  };
  fs.writeFileSync(path.join(dir, 'report.json'), json(report) + '\n');
  console.log(`PASS: ${scenarios.length} real local Sandbox scenarios; report.json written`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
