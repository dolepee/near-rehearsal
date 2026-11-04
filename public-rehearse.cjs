'use strict';
/*
 * Public-contract first supported slice:
 *   counter.testnet at a fixed final testnet block.
 *
 * Read-only capture; local Sandbox execution only. The deployed code/state are
 * authoritative. The source build is recorded as a matching provenance check.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, KeyPair, parseNEAR, hashContract } = require('near-workspaces');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
const RPC = 'https://rpc.testnet.near.org';
const SOURCE_CONTRACT = 'counter.testnet';
const LOCAL_CONTRACT = 'counter.test.near';
const GAS = 100_000_000_000_000n;
const CAPTURE_PATH = path.join(OUT, 'public-capture.json');
const REGRESSION_PATH = path.join(OUT, 'public-regression.json');
const REPORT_PATH = path.join(OUT, 'public-report.json');

class InfrastructureError extends Error {
  constructor(message) { super(message); this.name = 'InfrastructureError'; }
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const json = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const fileSha = (p) => sha256(fs.readFileSync(p));

async function rpc(method, params) {
  let res;
  try {
    res = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch (e) { throw new InfrastructureError(`RPC ${method} failed: ${e.message}`); }
  if (!res.ok) throw new InfrastructureError(`RPC ${method} HTTP ${res.status}`);
  let body;
  try { body = await res.json(); } catch (e) { throw new InfrastructureError(`RPC ${method} returned invalid JSON`); }
  if (body.error) throw new InfrastructureError(`RPC ${method}: ${JSON.stringify(body.error)}`);
  if (!body.result) throw new InfrastructureError(`RPC ${method}: missing result`);
  return body.result;
}
const sorted = (items) => items.map(({ key, value }) => ({ key, value }))
  .sort((a, b) => a.key.localeCompare(b.key));
const stateHash = (items) => sha256(JSON.stringify(sorted(items)));
const decodeCounter = (b64) => {
  let text;
  try { text = Buffer.from(b64, 'base64').toString('utf8'); } catch (e) { throw new InfrastructureError('counter bytes are not decodable'); }
  if (!/^[0-9]+$/.test(text)) throw new InfrastructureError(`counter is not decimal ASCII: ${JSON.stringify(text)}`);
  return text;
};
const runtimeOf = (status) => ({
  version: status.version?.version ?? status.version ?? null,
  build: status.version?.build ?? null,
  commit: status.version?.commit ?? null,
  protocolVersion: status.protocol_version ?? null,
  latestProtocolVersion: status.latest_protocol_version ?? null,
});

async function capturePublic() {
  const block = await rpc('block', { finality: 'final' });
  const height = block.header.height;
  const hash = block.header.hash;
  const accountView = await rpc('query', { request_type: 'view_account', block_id: height, account_id: SOURCE_CONTRACT });
  const codeResult = await rpc('query', { request_type: 'view_code', block_id: height, account_id: SOURCE_CONTRACT });
  const stateResult = await rpc('query', { request_type: 'view_state', block_id: height, account_id: SOURCE_CONTRACT, prefix_base64: '' });
  let code;
  try { code = Buffer.from(codeResult.code_base64, 'base64'); } catch (e) { throw new InfrastructureError('view_code returned invalid base64'); }
  const stateItems = sorted(stateResult.values || []);
  const counterItem = stateItems.find((x) => Buffer.from(x.key, 'base64').toString() === 'counter');
  if (!counterItem) throw new InfrastructureError('counter key not found in public state');
  const capture = {
    schema: 'near-rehearsal/public-capture/v1',
    sourceContract: SOURCE_CONTRACT,
    localContract: LOCAL_CONTRACT,
    network: 'testnet (read-only capture)',
    blockHeight: height,
    blockHash: hash,
    capturedAt: new Date().toISOString(),
    accountView,
    codeBase64: code.toString('base64'),
    codeHash: hashContract(code),
    codeSha256: sha256(code),
    stateItems,
    stateHash: stateHash(stateItems),
    stateBytes: stateItems.reduce((n, x) => n + Buffer.from(x.value, 'base64').length, 0),
    counter: decodeCounter(counterItem.value),
    counterBytes: counterItem.value,
    source: {
      repository: 'https://github.com/tansawit/near-counter-app',
      commit: 'd777350aefa1e76734cbd0ed7633bd072acd511f',
      sourceFile: 'assembly/main.ts',
      sourceBuildSha256: '5d4892a56646ca96f76a2632e7d21117ac541a4fc58f661ab2acff5bab7adcac',
      sourceBuildMatchesDeployed: sha256(code) === '5d4892a56646ca96f76a2632e7d21117ac541a4fc58f661ab2acff5bab7adcac',
      verification: 'Public source was built with near-sdk-as 0.4.2 and matched the captured deployed bytes.',
    },
    claimBoundary: 'Read-only public testnet capture at a fixed final block. No public writes, no deployment, no production authorization.',
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(CAPTURE_PATH, json(capture) + '\n');
  return capture;
}

function txEvidence(tx) {
  return {
    transactionHash: tx.transactionReceipt.hash,
    status: tx.status,
    succeeded: tx.succeeded,
    failed: tx.failed,
    failure: tx.Failure,
    receiptFailures: tx.receiptFailures,
    receiptFailureMessages: tx.receiptFailureMessages,
    logs: tx.logs,
    gasBurnt: tx.gas_burnt,
  };
}

async function currentRuntime(worker) {
  try { return runtimeOf(await worker.provider.status()); }
  catch (e) { throw new InfrastructureError(`runtime status failed: ${e.message}`); }
}

function assertLocal(worker) {
  const rpc = worker.config?.rpcAddr || worker.provider?.connection?.url;
  if (!rpc) throw new InfrastructureError('execution RPC address is missing');
  let host;
  try { host = new URL(rpc).hostname; } catch (e) { throw new InfrastructureError(`invalid execution RPC: ${rpc}`); }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new InfrastructureError(`refusing non-local execution RPC: ${rpc}`);
  }
}

async function readCounter(worker, accountId, view) {
  let r;
  try { r = await worker.provider.viewCall(accountId, view, {}, { finality: 'final' }); }
  catch (e) { throw new InfrastructureError(`${view} view failed: ${e.message}`); }
  if (!r || !Array.isArray(r.result)) throw new InfrastructureError(`${view} returned no byte array`);
  return decodeCounter(Buffer.from(r.result).toString('base64'));
}

async function readState(worker, accountId) {
  try {
    return sorted((await worker.provider.viewStateRaw(accountId, '', { finality: 'final' }))
      .map(({ key, value }) => ({ key, value })));
  } catch (e) { throw new InfrastructureError(`view_state failed: ${e.message}`); }
}

async function importPublic(capture) {
  const worker = await Worker.init({ network: 'sandbox' });
  try {
    assertLocal(worker);
    const runtime = await currentRuntime(worker);
    const keyPair = KeyPair.fromRandom('ed25519');
    const account = await worker.rootAccount.createSubAccount('counter', { keyPair, initialBalance: parseNEAR('10') });
    const rb = account.recordBuilder();
    rb.account({ ...capture.accountView, amount: parseNEAR('10').toString() });
    rb.accessKey(keyPair);
    rb.contract(Buffer.from(capture.codeBase64, 'base64'));
    for (const item of capture.stateItems) rb.data(item.key, item.value);
    try { await account.patchStateRecords(rb); } catch (e) { throw new InfrastructureError(`sandbox_patch_state failed: ${e.message}`); }

    let importedCode;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try { importedCode = await account.viewCode(); if (importedCode.length) break; } catch (e) { if (i === 19) throw new InfrastructureError(`view_code failed: ${e.message}`); }
    }
    if (!importedCode?.length) throw new InfrastructureError('public code did not import');
    let importedState;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      importedState = await readState(worker, account.accountId);
      if (stateHash(importedState) === capture.stateHash) break;
    }
    const check = {
      codeHash: hashContract(importedCode),
      codeSha256: sha256(importedCode),
      stateHash: stateHash(importedState),
      stateBytes: importedState.reduce((n, x) => n + Buffer.from(x.value, 'base64').length, 0),
      matches: hashContract(importedCode) === capture.codeHash && stateHash(importedState) === capture.stateHash,
    };
    if (!check.matches) throw new InfrastructureError(`captured state import mismatch: ${json(check)}`);
    return { worker, account, runtime, importCheck: check };
  } catch (e) {
    await worker.tearDown();
    throw e;
  }
}

async function branch(capture, spec, operation) {
  let imported;
  try { imported = await importPublic(capture); }
  catch (e) {
    return { ...spec, status: 'inconclusive', runtime: null, infrastructureError: e.message };
  }
  const { worker, account, runtime, importCheck } = imported;
  try {
    let migration = null;
    if (spec.candidate) {
      const candidateBytes = read(spec.candidate.wasm);
      const candidateSha = sha256(candidateBytes);
      if (candidateSha !== spec.candidate.sha256) throw new InfrastructureError(`candidate ${spec.candidate.wasm} hash mismatch`);
      await account.deploy(candidateBytes);
      const before = stateHash(await readState(worker, account.accountId));
      const tx = await account.callRaw(account, 'migrate', {}, { gas: GAS });
      let after = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 300));
        after = stateHash(await readState(worker, account.accountId));
        if (after !== before) break;
      }
      migration = { ...txEvidence(tx), beforeState: before, afterState: after, changedState: after !== before };
      if (!migration.succeeded) throw new InfrastructureError(`migration did not execute: ${json(migration.failure)}`);
    }

    let opResult;
    let evidence = null;
    try {
      const tx = await account.callRaw(account, operation.method, operation.args, { gas: GAS });
      evidence = txEvidence(tx);
      if (tx.failed) {
        opResult = { status: 'contract-failure', succeeded: false, tx: evidence };
      } else {
        let value = null;
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 500));
          value = await readCounter(worker, account.accountId, operation.view);
          if (BigInt(value) !== BigInt(capture.counter)) break;
        }
        opResult = { status: 'completed', succeeded: true, value, tx: evidence };
      }
    } catch (e) {
      opResult = { status: 'inconclusive', succeeded: null, tx: evidence, error: e.message };
    }
    return { ...spec, status: opResult.status, runtime, importCheck, migration, operation: opResult };
  } catch (e) {
    return { ...spec, status: 'inconclusive', runtime, importCheck, migration: null, operation: null, infrastructureError: e.message };
  } finally { await worker.tearDown(); }
}

function assertOperation(operation) {
  if (!operation || operation.method !== 'incrementCounter' || operation.view !== 'getCounter'
    || JSON.stringify(operation.args) !== JSON.stringify({ value: 1 })) {
    throw new InfrastructureError(`unsupported exported operation: ${json(operation)}; this slice supports incrementCounter({value:1})/getCounter`);
  }
}

async function runAll(capture, regression) {
  const operation = regression ? regression.operation : { method: 'incrementCounter', args: { value: 1 }, view: 'getCounter' };
  assertOperation(operation);
  const specs = regression ? regression.candidates : {
    baseline: { id: 'baseline', label: 'captured public contract', candidate: null },
    bad: { id: 'seeded-bad-v2', label: 'SEEDED bad v2 migration — writes version 1', candidate: { wasm: 'contracts/counter-v2-buggy.wasm', sha256: sha256(read('contracts/counter-v2-buggy.wasm')) } },
    corrected: { id: 'corrected-v2', label: 'corrected v2 migration — writes version 2', candidate: { wasm: 'contracts/counter-v2-fixed.wasm', sha256: sha256(read('contracts/counter-v2-fixed.wasm')) } },
  };
  const branches = {};
  for (const key of ['baseline', 'bad', 'corrected']) branches[key] = await branch(capture, specs[key], operation);
  const expected = regression ? regression.expected : {
    baseline: { succeeded: true, value: (BigInt(capture.counter) + 1n).toString() },
    bad: { succeeded: false },
    corrected: { succeeded: true, value: (BigInt(capture.counter) + 1n).toString() },
  };
  const actualRuntime = branches.baseline.runtime;
  const runtimeMatch = !regression?.runtime
    || (actualRuntime?.version === regression.runtime.version
      && actualRuntime?.protocolVersion === regression.runtime.protocolVersion
      && actualRuntime?.commit === regression.runtime.commit);
  const inconclusive = Object.values(branches).some((b) => b.status === 'inconclusive');
  // A declared runtime is part of the replay contract. A different runtime may
  // produce valid-looking transactions, so it cannot be reported as a complete
  // regression; it is a non-reproducible environment and must be inconclusive.
  const runtimeMismatch = !!regression?.runtime && !runtimeMatch;
  const status = inconclusive || runtimeMismatch ? 'inconclusive' : 'complete';
  const expectedMatches = {
    baseline: branches.baseline.status === 'completed' && branches.baseline.operation?.succeeded === expected.baseline.succeeded
      && (!expected.baseline.succeeded || branches.baseline.operation?.value === expected.baseline.value),
    bad: branches.bad.status === 'contract-failure' && branches.bad.operation?.succeeded === expected.bad.succeeded
      && branches.bad.operation?.tx?.failed === true,
    corrected: branches.corrected.status === 'completed' && branches.corrected.operation?.succeeded === expected.corrected.succeeded
      && (!expected.corrected.succeeded || branches.corrected.operation?.value === expected.corrected.value),
  };
  if (status === 'complete' && !Object.values(expectedMatches).every(Boolean)) {
    throw new Error(`replay expected outcome mismatch: ${json({ expected, expectedMatches, branches })}`);
  }
  return {
    branches,
    operation,
    expected,
    regressionRuntime: regression?.runtime ?? null,
    actualRuntime,
    runtimeMatch,
    runtimeMismatch,
    result: {
      status,
      baseline: branches.baseline.operation ?? null,
      badSucceeded: branches.bad.operation?.succeeded ?? null,
      badReceiptFailure: branches.bad.operation?.tx?.failed === true,
      corrected: branches.corrected.operation ?? null,
      regressionObserved: status === 'complete' && branches.baseline.operation?.succeeded === true
        && branches.bad.status === 'contract-failure' && branches.bad.operation?.tx?.failed === true,
      correctionObserved: status === 'complete' && branches.corrected.operation?.succeeded === true
        && branches.corrected.operation?.value === expected.corrected.value,
      sameStartingState: Object.values(branches).every((b) => b.importCheck?.matches === true),
    },
  };
}

function writeReport(capture, outcome) {
  const report = {
    schema: 'near-rehearsal/public-report/v1',
    generatedAt: new Date().toISOString(),
    sourceContract: capture.sourceContract,
    localContract: capture.localContract,
    capture: {
      blockHeight: capture.blockHeight, blockHash: capture.blockHash,
      codeHash: capture.codeHash, codeSha256: capture.codeSha256,
      stateHash: capture.stateHash, stateBytes: capture.stateBytes, counter: capture.counter,
      counterBytes: capture.counterBytes, source: capture.source,
    },
    operation: outcome.operation,
    capturedRuntime: capture.runtime ?? null,
    regressionRuntime: outcome.regressionRuntime,
    replayRuntime: outcome.actualRuntime,
    runtime: outcome.actualRuntime,
    runtimeMatch: outcome.runtimeMatch,
    runtimeMismatch: outcome.runtimeMismatch,
    status: outcome.result.status,
    expected: outcome.expected,
    branches: outcome.branches,
    result: outcome.result,
    claimBoundary: 'Read-only public testnet capture at a fixed final block; local Sandbox execution only. The bad migration is deliberately seeded. No live vulnerability or production authorization is claimed.',
  };
  fs.writeFileSync(REPORT_PATH, json(report) + '\n');
  return report;
}

function buildRegression(capture, report) {
  const regression = {
    schema: 'near-rehearsal/public-regression/v1',
    command: 'node public-rehearse.cjs --replay out/public-regression.json',
    capture: 'out/public-capture.json',
    captureSha256: fileSha(CAPTURE_PATH),
    runtime: report.replayRuntime,
    operation: { method: 'incrementCounter', args: { value: 1 }, view: 'getCounter' },
    expected: {
      baseline: { succeeded: true, value: (BigInt(capture.counter) + 1n).toString() },
      bad: { succeeded: false },
      corrected: { succeeded: true, value: (BigInt(capture.counter) + 1n).toString() },
    },
    candidates: {
      baseline: { id: 'baseline', label: 'captured public contract', candidate: null },
      bad: { id: 'seeded-bad-v2', label: 'SEEDED bad v2 migration — writes version 1', candidate: { wasm: 'contracts/counter-v2-buggy.wasm', sha256: sha256(read('contracts/counter-v2-buggy.wasm')) } },
      corrected: { id: 'corrected-v2', label: 'corrected v2 migration — writes version 2', candidate: { wasm: 'contracts/counter-v2-fixed.wasm', sha256: sha256(read('contracts/counter-v2-fixed.wasm')) } },
    },
  };
  fs.writeFileSync(REGRESSION_PATH, json(regression) + '\n');
  return regression;
}

(async () => {
  const from = process.argv.indexOf('--replay');
  let capture, regression = null, report;
  if (from !== -1) {
    const file = process.argv[from + 1] || REGRESSION_PATH;
    regression = JSON.parse(fs.readFileSync(file, 'utf8'));
    capture = JSON.parse(fs.readFileSync(path.join(ROOT, regression.capture), 'utf8'));
    if (fileSha(path.join(ROOT, regression.capture)) !== regression.captureSha256) throw new InfrastructureError('capture hash does not match regression');
    report = writeReport(capture, await runAll(capture, regression));
  } else {
    capture = await capturePublic();
    report = writeReport(capture, await runAll(capture, null));
    buildRegression(capture, report);
  }
  console.log(json({ source: report.sourceContract, block: report.capture.blockHeight, result: report.result }));
  if (report.result.status !== 'complete') process.exitCode = 1;
})().catch((e) => {
  console.error(`${e instanceof InfrastructureError ? 'INFRASTRUCTURE' : 'ERROR'}: ${e.stack || e.message}`);
  process.exitCode = 1;
});
