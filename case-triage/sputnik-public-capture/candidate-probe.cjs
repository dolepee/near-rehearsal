'use strict';
/*
 * Candidate compatibility probe against the captured 2.0.0 layout.
 * Uses the contract's declared governance UpgradeSelf route:
 * store_blob -> add_proposal(UpgradeSelf) -> VoteApprove -> upgrade_self -> migrate.
 * No direct deployment/patch of the candidate is used.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, KeyPair, parseNEAR, hashContract } = require('near-workspaces');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
const CAPTURE = path.join(OUT, 'capture.json');
const CANDIDATE = path.resolve(process.env.CANDIDATE_WASM || path.join(ROOT, '..', 'sputnik-226', 'verified-case', 'candidate.wasm'));
const GAS = 300_000_000_000_000n;
const BOND = parseNEAR('1');
const STORE_DEPOSIT = BigInt(process.env.STORE_DEPOSIT || '4306210000000000000000000');
const json = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sorted = (items) => items.map(({ key, value }) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key));
const stateHash = (items) => sha256(JSON.stringify(sorted(items)));

function assertLocal(worker) {
  const rpc = worker.config?.rpcAddr || worker.provider?.connection?.url;
  const host = new URL(rpc).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`refusing non-local execution RPC: ${rpc}`);
  return rpc;
}
async function readState(worker, id) {
  return sorted((await worker.provider.viewStateRaw(id, '', { finality: 'final' })).map(({ key, value }) => ({ key, value })));
}
async function viewJson(worker, id, method, args = {}) {
  const r = await worker.provider.viewCall(id, method, args, { finality: 'final' });
  return JSON.parse(Buffer.from(r.result).toString('utf8'));
}
function txSummary(tx) {
  return {
    succeeded: tx.succeeded, failed: tx.failed, failure: tx.Failure ?? null,
    logs: tx.logs ?? [], receiptFailures: tx.receiptFailures ?? [], receiptFailureMessages: tx.receiptFailureMessages ?? [],
    transactionHash: tx.transactionReceipt?.hash ?? null,
  };
}
async function main() {
  const capture = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));
  const candidate = fs.readFileSync(CANDIDATE);
  const result = {
    schema: 'near-rehearsal/public-candidate-probe/v1',
    status: 'running',
    source: capture.sourceAccount,
    capturedBlock: capture.block,
    candidate: { path: CANDIDATE, sha256: sha256(candidate), bytes: candidate.length, codeHash: hashContract(candidate) },
    route: 'governance UpgradeSelf: store_blob -> add_proposal -> VoteApprove -> upgrade_self -> migrate',
    steps: {},
  };
  const worker = await Worker.init({ network: 'sandbox' });
  try {
    result.runtime = { rpc: assertLocal(worker), status: await worker.provider.status() };
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
      if (await contract.exists().catch(() => false)) break;
    }
    if (!(await contract.exists().catch(() => false))) throw new Error('captured contract account did not import');
    result.import = {
      codeHash: hashContract(await contract.viewCode()),
      stateHash: stateHash(await readState(worker, contract.accountId)),
      balance: (await contract.accountView()).amount,
    };
    if (result.import.codeHash !== capture.code.hash || result.import.stateHash !== capture.state.hash) throw new Error('captured code/state identity mismatch');
    if (result.import.balance !== capture.account.amount) throw new Error('captured contract balance mismatch');

    const actor = worker.rootAccount.getAccount(capture.proposal.proposer);
    const actorKey = KeyPair.fromRandom('ed25519');
    const actorRb = actor.recordBuilder();
    actorRb.account({ amount: capture.proposerAccount.amount, code_hash: '11111111111111111111111111111111', storage_usage: capture.proposerAccount.storage_usage, locked: '0' });
    actorRb.accessKey(actorKey.getPublicKey());
    await actor.patchStateRecords(actorRb);
    await sleep(750);
    if (!(await actor.exists().catch(() => false))) {
      await actor.patchStateRecords(actorRb);
      await sleep(750);
    }
    await actor.setKey(actorKey);
    const actorPub = actorKey.getPublicKey().toString();
    let accessKeyView;
    for (let i = 0; i < 40; i++) {
      try { accessKeyView = await worker.provider.viewAccessKey(actor.accountId, actorPub, { finality: 'final' }); break; }
      catch (e) { if (i === 39) throw new Error(`actor access key did not appear: ${e.message}`); await sleep(250); }
    }
    result.actor = { account: actor.accountId, localFundingYocto: capture.proposerAccount.amount, capturedAmountYocto: capture.proposerAccount.amount, capturedBalancePreserved: true, publicKey: actorPub, accessKeyView, storeDepositYocto: STORE_DEPOSIT.toString() };

    const store = await actor.callRaw(contract, 'store_blob', candidate, { gas: GAS, attachedDeposit: STORE_DEPOSIT });
    result.steps.storeBlob = txSummary(store);
    if (store.failed) throw new Error(`store_blob failed: ${JSON.stringify(store.Failure)}`);
    const hash = store.parseResult();
    result.steps.storeBlob.hash = hash;
    if (typeof hash !== 'string' || !hash.length) throw new Error(`store_blob returned no hash: ${JSON.stringify(hash)}`);

    const kind = { UpgradeSelf: { hash } };
    const add = await actor.callRaw(contract, 'add_proposal', { proposal: { description: 'local candidate upgrade probe', kind } }, { gas: GAS, attachedDeposit: BOND });
    result.steps.addProposal = txSummary(add);
    if (add.failed) throw new Error(`add_proposal failed: ${JSON.stringify(add.Failure)}`);
    const id = add.parseResult();
    result.steps.addProposal.id = id;

    const approve = await actor.callRaw(contract, 'act_proposal', { id, action: 'VoteApprove', proposal: kind, memo: null }, { gas: GAS });
    result.steps.approve = txSummary(approve);
    if (approve.failed) throw new Error(`approve failed: ${JSON.stringify(approve.Failure)}`);
    await sleep(2000);

    result.after = {
      codeHash: hashContract(await contract.viewCode()),
      version: await viewJson(worker, contract.accountId, 'version'),
      policy: await viewJson(worker, contract.accountId, 'get_policy'),
      proposal0: await viewJson(worker, contract.accountId, 'get_proposal', { id: 0 }),
      proposal2: await viewJson(worker, contract.accountId, 'get_proposal', { id: Number(id) }).catch((e) => ({ error: e.message })),
      stateHash: stateHash(await readState(worker, contract.accountId)),
    };
    result.checks = {
      candidateDeployed: result.after.codeHash === result.candidate.codeHash,
      proposal0Preserved: result.after.proposal0?.status === 'InProgress',
      upgradeProposalResolved: result.after.proposal2?.status === 'Approved' || result.after.proposal2?.status === 'Executed',
    };
    result.status = Object.values(result.checks).every(Boolean) ? 'compatible' : 'incompatible';
  } catch (e) {
    result.status = 'incompatible';
    result.error = { name: e.name, message: e.message, stack: e.stack };
  } finally {
    await worker.tearDown();
  }
  fs.writeFileSync(path.join(OUT, 'candidate-probe.json'), json(result) + '\n');
  console.log(json({ status: result.status, source: result.source, candidate: result.candidate, steps: result.steps, after: result.after, checks: result.checks, error: result.error?.message }));
  if (result.status !== 'compatible') process.exitCode = 1;
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
