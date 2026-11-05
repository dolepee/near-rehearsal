'use strict';
/*
 * NEAR Rehearsal — bounded first slice.
 *
 * One deployed small-state local contract is captured at a fixed block, imported
 * into fresh Sandbox branches, and the same existing-user operation is compared
 * on baseline, a deliberately seeded bad migration, and its corrected candidate.
 *
 * This is a release-rehearsal tool, not an audit and not a claim about public
 * contracts. The marker "SEEDED" is used everywhere the bad candidate matters.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, KeyPair, parseNEAR, hashContract } = require('near-workspaces');
const {structuredTransactionFailure} = require('./scripts/transaction-classification.cjs');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
const CONTRACT = 'state.test.near';
const GAS = 100_000_000_000_000n;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const json = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const countOf = (result) => {
  const b = Buffer.from(result);
  if (b.length !== 8) throw new Error(`expected 8-byte count, got ${b.length}`);
  return b.readBigUInt64LE(0).toString();
};

function runtimeOf(status) {
  return {
    version: status.version?.version ?? status.version ?? null,
    build: status.version?.build ?? null,
    commit: status.version?.commit ?? null,
    protocolVersion: status.protocol_version ?? null,
    latestProtocolVersion: status.latest_protocol_version ?? null,
  };
}

function assertLocal(worker) {
  const rpc = worker.config?.rpcAddr || worker.provider?.connection?.url;
  if (!rpc) throw new Error('execution RPC address is missing');
  let host;
  try { host = new URL(rpc).hostname; } catch (e) { throw new Error(`invalid execution RPC: ${rpc}`); }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`refusing non-local execution RPC: ${rpc}`);
  }
}

async function stateHash(account) {
  const state = await account.viewStateRaw();
  const ordered = state.map(({ key, value }) => ({ key, value }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { stateHash: sha256(JSON.stringify(ordered)), state };
}

async function finalStateHash(worker, account) {
  const state = await worker.provider.viewStateRaw(account.accountId, '', { finality: 'final' });
  const ordered = state.map(({ key, value }) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key));
  return sha256(JSON.stringify(ordered));
}

async function captureBaseline() {
  const worker = await Worker.init({ network: 'sandbox' });
  try {
    assertLocal(worker);
    const status = await worker.provider.status();
    const account = await worker.rootAccount.createSubAccount('state', {
      initialBalance: parseNEAR('10'),
    });
    await account.deploy(read('contracts/state-v1.wasm'));
    await account.call(account, 'init', {});
    for (let i = 0; i < 5; i++) await account.call(account, 'increment', {});
    // Wait for the last increment to become visible before pinning the capture block.
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const got = await worker.provider.viewCall(account.accountId, 'get', {}, { finality: 'final' });
      if (Buffer.from(got.result).length === 8 && Buffer.from(got.result).readBigUInt64LE(0).toString() === '5') break;
    }
    const block = await worker.provider.block({ finality: 'final' });
    const blockHeight = block.header.height;
    const blockHash = block.header.hash;
    const accountView = await worker.provider.viewAccount(account.accountId, { block_id: blockHeight });
    const code = await worker.provider.viewCodeRaw(account.accountId, { block_id: blockHeight });
    const stateItems = await worker.provider.viewStateRaw(account.accountId, '', { block_id: blockHeight });
    const ordered = stateItems.map(({ key, value }) => ({ key, value }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const capture = {
      schema: 'near-rehearsal/capture/v1',
      contract: account.accountId,
      network: 'sandbox',
      blockHeight,
      blockHash,
      capturedAt: new Date().toISOString(),
      runtime: runtimeOf(status),
      accountView,
      codeBase64: code.toString('base64'),
      codeHash: hashContract(code),
      codeSha256: sha256(Buffer.isBuffer(code) ? code : Buffer.from(code, 'base64')),
      stateHash: sha256(JSON.stringify(ordered)),
      stateItems: ordered,
      stateBytes: ordered.reduce((n, x) => n + Buffer.from(x.value, 'base64').length, 0),
      count: ordered.length === 1 ? Buffer.from(ordered[0].value, 'base64').readBigUInt64LE(0).toString() : null,
      source: {
        baseline: 'contracts/state-v1.wat',
        baselineWasmSha256: sha256(read('contracts/state-v1.wasm')),
      },
      claimBoundary: 'Local Sandbox deployment captured at a fixed block. Not public-chain state. No live vulnerability.',
    };
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'capture.json'), json(capture) + '\n');
    return capture;
  } finally {
    await worker.tearDown();
  }
}

async function replayBranch(capture, candidate, operation) {
  const worker = await Worker.init({ network: 'sandbox' });
  let importCheck = null;
  let migration = null;
  let candidateHash = null;
  let runtime = null;
  try {
    assertLocal(worker);
    const status = await worker.provider.status();
    runtime = runtimeOf(status);
    const keyPair = KeyPair.fromRandom('ed25519');
    const account = await worker.rootAccount.createSubAccount('state', {
      keyPair,
      initialBalance: parseNEAR('10'),
    });
    const rb = account.recordBuilder();
    rb.account({ ...capture.accountView, amount: parseNEAR('10').toString() });
    rb.accessKey(keyPair);
    rb.contract(Buffer.from(capture.codeBase64, 'base64'));
    for (const item of capture.stateItems) rb.data(item.key, item.value);
    await account.patchStateRecords(rb);

    let importedCode;
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        importedCode = await account.viewCode();
        if (importedCode.length > 0) break;
      } catch (error) {
        if (attempt === 11) throw error;
      }
    }
    if (!importedCode?.length) throw new Error('captured contract code did not appear after patch');
    const imported = await stateHash(account);
    importCheck = {
      codeHash: hashContract(importedCode),
      codeSha256: sha256(importedCode),
      stateHash: imported.stateHash,
      stateBytes: imported.state.reduce((n, x) => n + Buffer.from(x.value, 'base64').length, 0),
      matches: hashContract(importedCode) === capture.codeHash && imported.stateHash === capture.stateHash,
    };
    if (!importCheck.matches) throw new Error(`captured state import mismatch: ${json(importCheck)}`);

    if (candidate) {
      await account.deploy(read(candidate.wasm));
    }
    candidateHash = hashContract(await account.viewCode());

    if (candidate && candidate.migrate) {
      const tx = await account.call(account, 'migrate', {}, { gas: GAS });
      let afterState = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        afterState = await finalStateHash(worker, account);
        if (candidate.id !== 'corrected-migration' || afterState !== capture.stateHash) break;
      }
      migration = {
        applied: true,
        transactionHash: tx?.transaction_outcome?.id ?? null,
        status: tx?.status ?? null,
        afterState,
        changedState: afterState !== capture.stateHash,
      };
    }

    let operationResult;
    try {
      const tx = await account.call(account, operation.method, operation.args ?? {}, { gas: GAS });
      let got;
      let value = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        got = await worker.provider.viewCall(account.accountId, operation.view, operation.args ?? {}, { finality: 'final' });
        value = countOf(got.result);
        if (value !== capture.count) break;
      }
      operationResult = {
        succeeded: true,
        value,
        transactionHash: tx?.transaction_outcome?.id ?? null,
        stateHashAfter: await finalStateHash(worker, account),
      };
    } catch (error) {
      const structured = structuredTransactionFailure(error);
      if (!structured) {
        return {
          branch: candidate ? candidate.id : 'baseline',
          label: candidate ? candidate.label : 'captured baseline',
          seeded: !!candidate?.seeded,
          candidate: candidate ? { wasm: candidate.wasm, codeHash: candidateHash } : null,
          importCheck,
          migration,
          operation: {
            succeeded: false,
            inconclusive: true,
            error: String(error?.message ?? error).split('\n')[0].slice(0, 500),
            stateHashAfter: null,
          },
          runtime,
        };
      }
      operationResult = {
        succeeded: false,
        structuredFailure: true,
        failure: structured.Failure ?? null,
        error: String(error?.message ?? error).split('\n')[0].slice(0, 500),
        stateHashAfter: (await stateHash(account)).stateHash,
      };
    }
    return {
      branch: candidate ? candidate.id : 'baseline',
      label: candidate ? candidate.label : 'captured baseline',
      seeded: !!candidate?.seeded,
      candidate: candidate ? { wasm: candidate.wasm, codeHash: candidateHash } : null,
      importCheck,
      migration,
      operation: operationResult,
      runtime,
    };
  } finally {
    await worker.tearDown();
  }
}

async function rehearse(capture) {
  const operation = { method: 'increment', args: {}, view: 'get' };
  const baseline = await replayBranch(capture, null, operation);
  const buggy = await replayBranch(capture, {
    id: 'seeded-bad-migration',
    label: 'SEEDED bad v2 migration — writes 8-byte v1 layout',
    seeded: true,
    migrate: true,
    wasm: 'contracts/state-v2-buggy.wasm',
  }, operation);
  const fixed = await replayBranch(capture, {
    id: 'corrected-migration',
    label: 'corrected v2 migration — writes version + count',
    seeded: false,
    migrate: true,
    wasm: 'contracts/state-v2-fixed.wasm',
  }, operation);
  const report = {
    schema: 'near-rehearsal/report/v1',
    generatedAt: new Date().toISOString(),
    contract: capture.contract,
    capture: {
      blockHeight: capture.blockHeight,
      blockHash: capture.blockHash,
      codeHash: capture.codeHash,
      codeSha256: capture.codeSha256,
      stateHash: capture.stateHash,
      stateBytes: capture.stateBytes,
    },
    capturedRuntime: capture.runtime,
    replayRuntime: baseline.runtime,
    runtime: baseline.runtime,
    operation: 'existing user: increment(); read: get()',
    branches: { baseline, buggy, fixed },
    result: {
      expectedAfterOneMore: (BigInt(capture.count) + 1n).toString(),
      baselineValue: baseline.operation.value,
      buggySucceeded: buggy.operation.succeeded,
      fixedValue: fixed.operation.value,
      sameStartingState: baseline.importCheck.matches && buggy.importCheck.matches && fixed.importCheck.matches,
      regressionObserved: baseline.operation.succeeded && buggy.operation.succeeded === false && buggy.operation.structuredFailure === true && buggy.operation.inconclusive !== true,
      correctionObserved: fixed.operation.succeeded && fixed.operation.value === (BigInt(capture.count) + 1n).toString(),
    },
    claimBoundary: 'Pinned local Sandbox execution only. The bad candidate is explicitly seeded. No live vulnerability, production authorization, or public-chain state capture is claimed.',
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), json(report) + '\n');
  fs.writeFileSync(path.join(OUT, 'regression.json'), json({
    schema: 'near-rehearsal/regression/v1',
    command: 'node rehearse.cjs --replay out/capture.json',
    capture: 'out/capture.json',
    captureSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(OUT, 'capture.json'))).digest('hex'),
    runtime: report.replayRuntime,
    operation,
    expected: {
      baseline: { succeeded: true, value: (BigInt(capture.count) + 1n).toString() },
      buggy: { succeeded: false },
      fixed: { succeeded: true, value: (BigInt(capture.count) + 1n).toString() },
    },
    candidates: {
      buggy: { wasm: 'contracts/state-v2-buggy.wasm', sha256: sha256(read('contracts/state-v2-buggy.wasm')), seeded: true },
      fixed: { wasm: 'contracts/state-v2-fixed.wasm', sha256: sha256(read('contracts/state-v2-fixed.wasm')) },
    },
  }, null, 2) + '\n');
  return report;
}

(async () => {
  const from = process.argv.indexOf('--replay');
  let capture;
  if (from !== -1) {
    capture = JSON.parse(fs.readFileSync(process.argv[from + 1], 'utf8'));
  } else {
    capture = await captureBaseline();
  }
  const report = await rehearse(capture);
  console.log(json({
    contract: report.contract,
    block: report.capture.blockHeight,
    baseline: report.branches.baseline.operation.value,
    buggySucceeded: report.branches.buggy.operation.succeeded,
    fixed: report.branches.fixed.operation.value,
    regressionObserved: report.result.regressionObserved,
    correctionObserved: report.result.correctionObserved,
  }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
