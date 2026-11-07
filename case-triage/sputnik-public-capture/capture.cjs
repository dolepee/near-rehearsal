'use strict';
/*
 * Read-only capture feasibility probe for one public Sputnik child DAO.
 * No public writes, no production keys, local Sandbox only.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, KeyPair, parseNEAR, hashContract } = require('near-workspaces');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
const RPC = process.env.NEAR_RPC || 'https://rpc.testnet.fastnear.com';
const SOURCE = process.env.SOURCE_ACCOUNT || 'aya.sputnikv2.testnet';
const PROPOSER = process.env.PROPOSER_ACCOUNT || 'nima.testnet';
const GAS = 100_000_000_000_000n;
const MAX_STATE_BYTES = 600_000;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const json = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  let last;
  for (let i = 0; i < 8; i++) {
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (res.status === 429) throw new Error('HTTP 429');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) {
        const msg = JSON.stringify(body.error);
        if (/Rate limits|429/i.test(msg)) throw new Error(msg);
        throw new Error(`${method}: ${msg}`);
      }
      return body.result;
    } catch (e) {
      last = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`RPC ${method} failed after retries: ${last?.message}`);
}

async function viewCall(accountId, method, args, blockId) {
  const r = await rpc('query', {
    request_type: 'call_function', finality: 'final', account_id: accountId,
    method_name: method, args_base64: Buffer.from(JSON.stringify(args || {})).toString('base64'),
    ...(blockId ? { block_id: blockId } : {}),
  });
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return JSON.parse(Buffer.from(r.result).toString('utf8'));
}

const sorted = (items) => items.map(({ key, value }) => ({ key, value }))
  .sort((a, b) => a.key.localeCompare(b.key));
const stateHash = (items) => sha256(JSON.stringify(sorted(items)));

async function capture() {
  const block = await rpc('block', { finality: 'final' });
  const height = block.header.height;
  const hash = block.header.hash;
  const account = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: SOURCE, block_id: height });
  const codeResult = await rpc('query', { request_type: 'view_code', finality: 'final', account_id: SOURCE, block_id: height });
  const stateResult = await rpc('query', { request_type: 'view_state', finality: 'final', account_id: SOURCE, block_id: height, prefix_base64: '' });
  const code = Buffer.from(codeResult.code_base64, 'base64');
  const stateItems = sorted(stateResult.values || []);
  const stateBytes = stateItems.reduce((n, x) => n + Buffer.from(x.value, 'base64').length, 0);
  if (stateBytes > MAX_STATE_BYTES) throw new Error(`state too large: ${stateBytes} > ${MAX_STATE_BYTES}`);
  const policy = await viewCall(SOURCE, 'get_policy', {}, height);
  const lastProposal = await viewCall(SOURCE, 'get_last_proposal_id', {}, height);
  const proposals = await viewCall(SOURCE, 'get_proposals', { from_index: 0, limit: Math.min(20, Math.max(1, lastProposal)) }, height);
  const proposal = proposals.find((p) => p.status === 'InProgress' && p.kind?.FunctionCall) || null;
  if (!proposal) throw new Error('no InProgress FunctionCall proposal found');
  const proposerView = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: proposal.proposer, block_id: height }).catch(() => null);
  const version = await viewCall(SOURCE, 'version', {}, height).catch((e) => ({ error: e.message }));
  const data = {
    schema: 'near-rehearsal/public-capture-probe/v1',
    sourceAccount: SOURCE,
    network: 'testnet',
    capturedAt: new Date().toISOString(),
    block: { height, hash, timestamp: String(block.header.timestamp_nanosec ?? block.header.timestamp), timestampNanosec: String(block.header.timestamp_nanosec ?? block.header.timestamp), epochId: block.header.epoch_id },
    account,
    code: { hash: hashContract(code), sha256: sha256(code), bytes: code.length, base64: code.toString('base64') },
    state: { hash: stateHash(stateItems), bytes: stateBytes, count: stateItems.length, items: stateItems },
    policy,
    version,
    proposal,
    proposals,
    proposerAccount: proposerView,
    claimBoundary: 'Read-only public testnet capture at a fixed final block; local Sandbox execution only. No public writes, no production keys, no production recovery. A successful operation is local evidence only.',
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'capture.json'), json(data) + '\n');
  return data;
}

async function main() {
  const data = await capture();
  console.log(json({ source: data.sourceAccount, block: data.block, code: data.code.hash, state: data.state, proposal: { id: data.proposal.id, proposer: data.proposal.proposer, kind: data.proposal.kind, status: data.proposal.status }, policy: data.policy }));
}

main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
