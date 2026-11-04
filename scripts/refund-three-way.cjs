'use strict';
/*
 * Supported funded-refund release case.
 *
 * One frozen local-Sandbox capture, three fresh branches:
 *   baseline: claim_refund()
 *   seeded bad v2: deploy + migrate(), then claim_refund()
 *   corrected v2: deploy + migrate(), then claim_refund()
 *
 * The bad branch must fail with the contract's structured NO_REFUND receipt,
 * not with a transport/read/deploy error. All branches use the same captured
 * state and the same named user/action.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Worker, KeyPair, parseNEAR, hashContract} = require('near-workspaces');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const GAS = 100_000_000_000_000n;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const read = (file) => fs.readFileSync(path.join(ROOT, file));
const safeCasePath = (file) => {
  const resolved = path.resolve(ROOT, file);
  if (!resolved.startsWith(ROOT + path.sep)) throw new Error(`case path escapes repository: ${file}`);
  return resolved;
};

class Inconclusive extends Error {
  constructor(message) { super(message); this.name = 'Inconclusive'; }
}

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
  let host;
  try { host = new URL(rpc).hostname; } catch { throw new Inconclusive(`invalid execution RPC: ${rpc}`); }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Inconclusive(`refusing non-local execution RPC: ${rpc}`);
}

const sorted = (items) => items.map(({key, value}) => ({key, value}))
  .sort((a, b) => a.key.localeCompare(b.key));
const stateHash = (items) => sha256(JSON.stringify(sorted(items)));
const balanceOf = (view) => BigInt(view.amount);
const entitlementOf = (result) => {
  const bytes = Buffer.from(result.result);
  if (bytes.length !== 16) throw new Inconclusive(`expected 16-byte refund entitlement, got ${bytes.length}`);
  return bytes.readBigUInt64LE(0) + (bytes.readBigUInt64LE(8) << 64n);
};

async function waitForAccount(worker, accountId, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try { return await worker.provider.viewAccount(accountId, {finality: 'final'}); }
    catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Inconclusive(`account did not appear: ${accountId}`);
}

async function waitFor(worker, accountId, predicate, attempts = 60) {
  let value;
  for (let i = 0; i < attempts; i++) {
    value = await worker.provider.viewStateRaw(accountId, '', {finality: 'final'});
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return value;
}

async function waitForEntitlement(worker, accountId, predicate, attempts = 60) {
  let entitlement = null;
  for (let i = 0; i < attempts; i++) {
    entitlement = entitlementOf(await worker.provider.viewCall(accountId, 'get_refundable', {}, {finality: 'final'}));
    if (predicate(entitlement)) return entitlement;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return entitlement;
}


async function waitForStableAccount(worker, accountId, attempts = 20) {
  let previous = null;
  for (let i = 0; i < attempts; i++) {
    const current = await waitForAccount(worker, accountId);
    if (previous && current.amount === previous.amount) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return previous;
}

async function waitForBalance(worker, accountId, predicate, attempts = 60) {
  let view = null;
  for (let i = 0; i < attempts; i++) {
    view = await waitForAccount(worker, accountId);
    if (predicate(balanceOf(view))) return view;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return view;
}

function txEvidence(tx) {
  if (!tx) return null;
  const receipts = (tx.result?.receipts_outcome || []).map((receipt) => ({
    id: receipt.id,
    executorId: receipt.outcome?.executor_id,
    status: receipt.outcome?.status,
    gasBurnt: receipt.outcome?.gas_burnt ?? null,
    tokensBurnt: receipt.outcome?.tokens_burnt ?? null,
    logs: receipt.outcome?.logs || [],
  }));
  return {
    transactionHash: tx.result?.transaction_outcome?.id ?? tx.result?.transaction?.hash ?? null,
    succeeded: tx.succeeded === true,
    failed: tx.failed === true,
    status: tx.status ?? null,
    gasBurnt: tx.result?.transaction_outcome?.outcome?.gas_burnt ?? null,
    tokensBurnt: tx.result?.transaction_outcome?.outcome?.tokens_burnt ?? null,
    receiptFailures: tx.receiptFailureMessages || [],
    receipts,
  };
}

function failureText(tx) {
  return JSON.stringify(tx?.receiptFailureMessages || tx?.Failure || '');
}

function validateCase(caseFile) {
  const config = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
  if (config.schema !== 'near-rehearsal/release-case/v1') throw new Error('unsupported case schema');
  if (config.id !== 'refund-v1') throw new Error(`unsupported case: ${config.id}`);
  if (!config.baselineWasm || !config.capture) throw new Error('case must declare baselineWasm and capture');
  if (!config.operation || config.operation.method !== 'claim_refund' || JSON.stringify(config.operation.args) !== '{}' || config.operation.view !== 'get_refundable') {
    throw new Error('this supported case only accepts claim_refund({})/get_refundable');
  }
  if (!config.migration || config.migration.method !== 'migrate' || JSON.stringify(config.migration.args) !== '{}') {
    throw new Error('this supported case only accepts migrate({})');
  }
  for (const name of ['bad', 'corrected']) {
    const candidate = config.candidates?.[name];
    if (!candidate?.wasm || !/^[a-f0-9]{64}$/.test(candidate.sha256 || '')) throw new Error(`invalid ${name} candidate`);
    if (!fs.existsSync(safeCasePath(candidate.wasm))) throw new Error(`missing ${name} candidate: ${candidate.wasm}`);
    if (sha256(read(candidate.wasm)) !== candidate.sha256) throw new Error(`${name} candidate hash mismatch`);
  }
  return config;
}

async function captureBaseline() {
  const worker = await Worker.init({network: 'sandbox'});
  try {
    assertLocal(worker);
    const runtime = runtimeOf(await worker.provider.status());
    const account = await worker.rootAccount.createSubAccount('refund', {initialBalance: parseNEAR('1')});
    await account.deploy(read('contracts/refund-v1.wasm'));
    await account.call(account, 'init', {}, {gas: GAS});
    await waitForAccount(worker, account.accountId);

    let state;
    for (let i = 0; i < 40; i++) {
      state = await worker.provider.viewStateRaw(account.accountId, '', {finality: 'final'});
      if (state.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (state.length !== 1) throw new Inconclusive('baseline state did not settle');
    const block = await worker.provider.block({finality: 'final'});
    const height = block.header.height;
    const accountView = await worker.provider.viewAccount(account.accountId, {block_id: height});
    const code = await worker.provider.viewCodeRaw(account.accountId, {block_id: height});
    const stateItems = sorted(await worker.provider.viewStateRaw(account.accountId, '', {block_id: height}));
    const capture = {
      schema: 'near-rehearsal/refund-capture/v1',
      label: 'Local Sandbox authored funded-refund example',
      contract: account.accountId,
      network: 'sandbox',
      blockHeight: height,
      blockHash: block.header.hash,
      capturedAt: new Date().toISOString(),
      runtime,
      accountView,
      codeBase64: code.toString('base64'),
      codeHash: hashContract(code),
      codeSha256: sha256(code),
      stateHash: stateHash(stateItems),
      stateItems,
      stateBytes: stateItems.reduce((n, item) => n + Buffer.from(item.value, 'base64').length, 0),
      entitlement: entitlementOf(await worker.provider.viewCall(account.accountId, 'get_refundable', {}, {finality: 'final'})).toString(),
      beneficiary: 'refunduser.test.near',
      fundedNear: '1',
      grossEntitlementNear: '0.1',
      claimBoundary: 'Local Sandbox only. Authored seeded migration example; not a public-chain capture, upgrade authorization, or production custody claim.',
    };
    fs.mkdirSync(OUT, {recursive: true});
    fs.writeFileSync(path.join(OUT, 'refund-capture.json'), json(capture) + '\n');
    return capture;
  } finally {
    await worker.tearDown();
  }
}

async function runBranch(capture, config, candidate, expected) {
  const worker = await Worker.init({network: 'sandbox'});
  const result = {
    branch: candidate?.id || 'baseline',
    expected,
    status: 'inconclusive',
    runtime: null,
    importCheck: null,
    migration: null,
    claim: null,
    controls: {outsiderDenied: null, migrationAuthorityDenied: null, secondClaimDenied: null},
    entitlement: {beforeMigration: null, afterMigration: null, afterClaim: null},
    balances: {contract: null, user: null},
    error: null,
  };
  try {
    assertLocal(worker);
    result.runtime = runtimeOf(await worker.provider.status());
    const keyPair = KeyPair.fromRandom('ed25519');
    const contract = await worker.rootAccount.createSubAccount('refund', {keyPair, initialBalance: parseNEAR('1')});
    const rb = contract.recordBuilder();
    rb.account({...capture.accountView});
    rb.accessKey(keyPair);
    rb.contract(Buffer.from(capture.codeBase64, 'base64'));
    for (const item of capture.stateItems) rb.data(item.key, item.value);
    await contract.patchStateRecords(rb);

    let importedCode;
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try { importedCode = await contract.viewCode(); if (importedCode.length) break; } catch {}
    }
    const importedState = await waitFor(worker, contract.accountId, (state) => stateHash(state) === capture.stateHash);
    result.importCheck = {
      codeHash: importedCode ? hashContract(importedCode) : null,
      stateHash: stateHash(importedState),
      matches: !!importedCode && hashContract(importedCode) === capture.codeHash && stateHash(importedState) === capture.stateHash,
    };
    if (!result.importCheck.matches) throw new Inconclusive('captured code/state did not import identically');

    const user = await worker.rootAccount.createSubAccount('refunduser', {initialBalance: parseNEAR('10')});
    const userBefore = await waitForAccount(worker, user.accountId);
    const contractBefore = await waitForAccount(worker, contract.accountId);
    result.balances = {
      contract: {initial: balanceOf(contractBefore).toString(), beforeClaim: null, after: null, delta: null},
      user: {initial: balanceOf(userBefore).toString(), beforeClaim: null, after: null, delta: null},
    };
    result.entitlement.beforeMigration = (await waitForEntitlement(worker, contract.accountId, () => true)).toString();

    if (candidate) {
      await contract.deploy(read(candidate.wasm));
      const beforeMigrationState = await waitFor(worker, contract.accountId, () => true);
      const unauthorizedMigration = await user.callRaw(contract, config.migration.method, config.migration.args, {gas: GAS});
      result.controls.migrationAuthorityDenied = unauthorizedMigration.failed === true && /MIGRATION/.test(failureText(unauthorizedMigration));
      if (!result.controls.migrationAuthorityDenied) throw new Error('non-owner migration was not denied');
      if (stateHash(await waitFor(worker, contract.accountId, () => true)) !== stateHash(beforeMigrationState)) throw new Error('denied migration changed state');
      const migrationTx = await contract.callRaw(contract, config.migration.method, config.migration.args, {gas: GAS});
      const afterMigrationState = await waitFor(worker, contract.accountId, (state) => stateHash(state) !== stateHash(beforeMigrationState));
      result.migration = {
        ...txEvidence(migrationTx),
        beforeStateHash: stateHash(beforeMigrationState),
        afterStateHash: stateHash(afterMigrationState),
        changedState: stateHash(beforeMigrationState) !== stateHash(afterMigrationState),
      };
      if (migrationTx.failed) throw new Inconclusive(`migration failed unexpectedly: ${failureText(migrationTx)}`);
      result.entitlement.afterMigration = (await waitForEntitlement(worker, contract.accountId, () => true)).toString();
    } else {
      result.entitlement.afterMigration = result.entitlement.beforeMigration;
    }

    // Capture the post-migration, pre-claim balances. Migration gas belongs to
    // the upgrade, not to the user's claim.
    const outsider = await worker.rootAccount.createSubAccount('outsider', {initialBalance: parseNEAR('10')});
    await waitForAccount(worker, outsider.accountId);
    const outsiderClaim = await outsider.callRaw(contract, config.operation.method, config.operation.args, {gas: GAS});
    result.controls.outsiderDenied = outsiderClaim.failed === true && /OUTSIDER/.test(failureText(outsiderClaim));
    if (!result.controls.outsiderDenied) throw new Error('outsider claim was not denied by the contract');

    const contractBeforeClaim = await waitForStableAccount(worker, contract.accountId);
    const userBeforeClaim = await waitForStableAccount(worker, user.accountId);
    result.balances.contract.beforeClaim = balanceOf(contractBeforeClaim).toString();
    result.balances.user.beforeClaim = balanceOf(userBeforeClaim).toString();

    let claimTx;
    try {
      claimTx = await user.callRaw(contract, config.operation.method, config.operation.args, {gas: GAS});
    } catch (error) {
      throw new Inconclusive(`claim transport failed: ${error.message}`);
    }
    result.claim = txEvidence(claimTx);
    result.entitlement.afterClaim = (await waitForEntitlement(worker, contract.accountId, (value) => expected === 'success' ? value === 0n : true)).toString();

    const contractAfter = await waitForBalance(worker, contract.accountId, (balance) => expected === 'success' ? balance < BigInt(result.balances.contract.beforeClaim) : true);
    const userAfter = await waitForBalance(worker, user.accountId, (balance) => expected === 'success' ? balance > BigInt(result.balances.user.beforeClaim) : true);
    result.balances.contract.after = balanceOf(contractAfter).toString();
    result.balances.contract.delta = (balanceOf(contractAfter) - BigInt(result.balances.contract.beforeClaim)).toString();
    result.balances.user.after = balanceOf(userAfter).toString();
    result.balances.user.delta = (balanceOf(userAfter) - BigInt(result.balances.user.beforeClaim)).toString();

    // Run the second-claim control after recording the first claim's balance
    // delta, so control gas cannot be mistaken for a payout.
    const secondClaim = await user.callRaw(contract, config.operation.method, config.operation.args, {gas: GAS});
    result.controls.secondClaimDenied = secondClaim.failed === true && /NO_REFUND/.test(failureText(secondClaim));
    if (!result.controls.secondClaimDenied) throw new Error('second claim was not denied');

    if (expected === 'success') {
      if (!claimTx.succeeded) throw new Error(`expected successful claim, got failure: ${failureText(claimTx)}`);
      if (BigInt(result.balances.user.delta) <= 0n) throw new Error('successful claim did not increase user balance');
      if (BigInt(result.balances.contract.delta) >= 0n) throw new Error('successful claim did not decrease contract balance');
      if (result.entitlement.afterClaim !== '0') throw new Error('successful claim did not clear entitlement');
      result.status = 'completed';
    } else if (expected === 'NO_REFUND') {
      if (!claimTx.failed) throw new Error('seeded bad branch did not fail');
      if (!/NO_REFUND/.test(failureText(claimTx))) throw new Inconclusive(`claim failed for a non-NO_REFUND reason: ${failureText(claimTx)}`);
      if (result.entitlement.afterMigration !== '0') throw new Error('bad migration did not clear entitlement');
      // Contract balance can move while migration gas/refunds settle; the claim
      // itself is proven not to transfer by the structured failure and absence
      // of any successful transfer receipt, not by a raw end-balance equality.
      if (result.claim.receipts.some((receipt) => receipt.status?.SuccessValue !== undefined)) throw new Error('failed claim produced a successful receipt');
      result.status = 'expected-failure';
    } else {
      throw new Error(`unsupported expectation: ${expected}`);
    }
    return result;
  } catch (error) {
    result.status = error instanceof Inconclusive ? 'inconclusive' : 'error';
    result.error = error.message;
    return result;
  } finally {
    await worker.tearDown();
  }
}

(async () => {
  const caseArgIndex = process.argv.indexOf('--case');
  const caseFile = path.resolve(ROOT, caseArgIndex >= 0 ? (process.argv[caseArgIndex + 1] || 'cases/refund-v1/case.json') : 'cases/refund-v1/case.json');
  const config = validateCase(caseFile);
  const capturePath = path.resolve(ROOT, config.capture);
  let capture;
  if (fs.existsSync(capturePath)) capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  else capture = await captureBaseline();

  if (!capture || capture.codeHash === undefined) throw new Error('capture is missing code identity');
  const baseline = await runBranch(capture, config, null, 'success');
  const bad = await runBranch(capture, config, {id: 'seeded-bad-v2', ...config.candidates.bad}, 'NO_REFUND');
  const corrected = await runBranch(capture, config, {id: 'corrected-v2', ...config.candidates.corrected}, 'success');

  const report = {
    schema: 'near-rehearsal/refund-report/v1',
    case: config.id,
    label: config.label,
    generatedAt: new Date().toISOString(),
    capture: {
      contract: capture.contract,
      blockHeight: capture.blockHeight,
      blockHash: capture.blockHash,
      codeHash: capture.codeHash,
      codeSha256: capture.codeSha256,
      stateHash: capture.stateHash,
      stateBytes: capture.stateBytes,
      entitlement: capture.entitlement,
      runtime: capture.runtime,
      claimBoundary: capture.claimBoundary,
    },
    operation: config.operation,
    migration: config.migration,
    branches: {baseline, bad, corrected},
    result: {
      status: [baseline, bad, corrected].every((branch) => branch.expected === 'success' ? branch.status === 'completed' : branch.status === 'expected-failure') ? 'complete' : 'incomplete',
      expected: {baseline: 'success', bad: 'NO_REFUND', corrected: 'success'},
      sameStartingState: [baseline, bad, corrected].every((branch) => branch.importCheck?.matches === true),
      controls: [baseline, bad, corrected].every((branch) => branch.controls.outsiderDenied === true && branch.controls.secondClaimDenied === true) && bad.controls.migrationAuthorityDenied === true && corrected.controls.migrationAuthorityDenied === true,
      badFailureIsStructured: bad.status === 'expected-failure' && /NO_REFUND/.test(failureText({receiptFailureMessages: bad.claim?.receiptFailures || []})),
      claimTransferToBeneficiary: [baseline, corrected].every((branch) => branch.status === 'completed' && branch.claim?.receipts?.some((receipt) => receipt.executorId === capture.beneficiary) && BigInt(branch.balances.user.delta) > 0n),
    },
  };
  fs.mkdirSync(OUT, {recursive: true});
  fs.writeFileSync(path.join(OUT, 'refund-report.json'), json(report) + '\n');
  console.log(json(report));
  if (report.result.status !== 'complete') process.exitCode = 1;
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
