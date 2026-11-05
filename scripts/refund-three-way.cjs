'use strict';
/*
 * Supported funded-refund release case.
 *
 * One frozen local-Sandbox capture, three fresh branches:
 *   baseline: claim_refund()
 *   seeded bad v2: deploy + migrate(), then claim_refund()
 *   corrected v2: deploy + migrate(), then claim_refund()
 *
 * Completion is gated on the contract's SuccessReceiptId linking to a
 * beneficiary SuccessValue receipt, not on any receipt executed by that account.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Worker, KeyPair, parseNEAR, hashContract} = require('near-workspaces');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const GAS = 100_000_000_000_000n;
const CASE_SCHEMA = 'near-rehearsal/release-case/v1';
const CAPTURE_SCHEMA = 'near-rehearsal/refund-capture/v1';
const REPORT_SCHEMA = 'near-rehearsal/refund-report/v1';
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

function parseCaptureState(capture) {
  if (!Array.isArray(capture?.stateItems) || capture.stateItems.length !== 1) {
    throw new Error('capture must contain exactly one state item');
  }
  const item = capture.stateItems[0];
  if (Buffer.from(item.key, 'base64').toString('utf8') !== 'r') throw new Error('capture state key must be r');
  const value = Buffer.from(item.value, 'base64');
  if (value.length !== 96) throw new Error(`capture state must be 96 bytes, got ${value.length}`);
  const version = value.readBigUInt64LE(0);
  const length = Number(value.readBigUInt64LE(8));
  if (version !== 1n) throw new Error(`capture state version must be 1, got ${version}`);
  if (length < 1 || length > 64 || 16 + length > 80) throw new Error(`invalid captured beneficiary length: ${length}`);
  return {
    version,
    length,
    beneficiary: value.subarray(16, 16 + length).toString('utf8'),
    amount: value.readBigUInt64LE(80) + (value.readBigUInt64LE(88) << 64n),
    value,
  };
}

function runtimePinMatches(actual, pin) {
  if (!actual || !pin) return false;
  return String(actual.version) === String(pin.version)
    && String(actual.protocolVersion) === String(pin.protocolVersion)
    && String(actual.commit) === String(pin.commit);
}

const CASE_FIELDS = new Set([
  'schema', 'id', 'label', 'baselineWasm', 'capture', 'migration', 'operation',
  'candidates', 'expected', 'boundary', 'beneficiary', 'fundedNear',
  'grossEntitlementNear', 'runtimePin',
]);
const MIGRATION_FIELDS = new Set(['method', 'args']);
const OPERATION_FIELDS = new Set(['method', 'args', 'view']);
const CANDIDATE_FIELDS = new Set(['id', 'label', 'wasm', 'sha256']);
const EXPECTED_FIELDS = new Set(['baseline', 'bad', 'corrected']);
const RUNTIME_FIELDS = new Set(['version', 'protocolVersion', 'commit']);

function assertFields(object, allowed, label) {
  const extra = Object.keys(object || {}).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`unsupported ${label} field(s): ${extra.join(', ')}`);
}

function validateCaseConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('case must be an object');
  assertFields(config, CASE_FIELDS, 'case');
  if (config.schema !== CASE_SCHEMA) throw new Error('unsupported case schema');
  if (config.id !== 'refund-v1') throw new Error(`unsupported case: ${config.id}`);
  for (const field of ['label', 'baselineWasm', 'capture', 'boundary', 'beneficiary']) {
    if (typeof config[field] !== 'string' || !config[field].trim()) throw new Error(`case must declare ${field}`);
  }
  if (!fs.existsSync(safeCasePath(config.baselineWasm))) throw new Error(`missing baseline wasm: ${config.baselineWasm}`);
  if (BigInt(parseNEAR(config.fundedNear)) <= 0n) throw new Error('fundedNear must be positive');
  if (BigInt(parseNEAR(config.grossEntitlementNear)) <= 0n) throw new Error('grossEntitlementNear must be positive');

  assertFields(config.migration, MIGRATION_FIELDS, 'migration');
  if (config.migration.method !== 'migrate' || JSON.stringify(config.migration.args) !== '{}') {
    throw new Error('this supported case only accepts migrate({})');
  }
  assertFields(config.operation, OPERATION_FIELDS, 'operation');
  if (config.operation.method !== 'claim_refund' || JSON.stringify(config.operation.args) !== '{}' || config.operation.view !== 'get_refundable') {
    throw new Error('this supported case only accepts claim_refund({})/get_refundable');
  }
  assertFields(config.expected, EXPECTED_FIELDS, 'expected');
  if (config.expected.baseline !== 'success' || !['NO_REFUND', 'candidate'].includes(config.expected.bad) || config.expected.corrected !== 'success') {
    throw new Error('unsupported expected outcomes');
  }
  if (!config.candidates || Object.keys(config.candidates).sort().join(',') !== 'bad,corrected') {
    throw new Error('case must declare exactly bad and corrected candidates');
  }
  for (const name of ['bad', 'corrected']) {
    const candidate = config.candidates[name];
    assertFields(candidate, CANDIDATE_FIELDS, `${name} candidate`);
    if (typeof candidate.id !== 'string' || typeof candidate.label !== 'string') throw new Error(`${name} candidate needs id and label`);
    if (typeof candidate.wasm !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.sha256 || '')) throw new Error(`invalid ${name} candidate`);
    if (!fs.existsSync(safeCasePath(candidate.wasm))) throw new Error(`missing ${name} candidate: ${candidate.wasm}`);
    if (sha256(read(candidate.wasm)) !== candidate.sha256) throw new Error(`${name} candidate hash mismatch`);
  }
  assertFields(config.runtimePin, RUNTIME_FIELDS, 'runtimePin');
  if (!/^[0-9a-f]{40}$/.test(config.runtimePin.commit || '')) throw new Error('runtimePin.commit must be a 40-character commit');
  if (!config.runtimePin.version || config.runtimePin.protocolVersion === undefined) throw new Error('runtimePin needs version and protocolVersion');
  return config;
}

function validateCase(caseFile) {
  return validateCaseConfig(JSON.parse(fs.readFileSync(caseFile, 'utf8')));
}

function validateCapture(capture, config, actualRuntime = null) {
  if (!capture || capture.schema !== CAPTURE_SCHEMA) throw new Error('unsupported capture schema');
  if (!capture.runtime || typeof capture.runtime !== 'object') throw new Error('capture is missing runtime identity');
  if (!runtimePinMatches(capture.runtime, config.runtimePin)) throw new Error('captured runtime does not match the declared runtime pin');
  if (actualRuntime && !runtimePinMatches(actualRuntime, config.runtimePin)) throw new Error('actual runtime does not match the declared runtime pin');
  const parsed = parseCaptureState(capture);
  if (capture.beneficiary !== parsed.beneficiary) throw new Error('capture.beneficiary does not match stored beneficiary bytes');
  if (capture.beneficiary !== config.beneficiary) throw new Error('capture.beneficiary does not match the case beneficiary');
  if (BigInt(capture.entitlement) !== parsed.amount) throw new Error('capture.entitlement does not match stored amount');
  if (parsed.amount !== BigInt(parseNEAR(config.grossEntitlementNear))) throw new Error('captured entitlement does not match the case gross entitlement');
  if (capture.fundedNear !== config.fundedNear) throw new Error('capture.fundedNear does not match the case');
  if (capture.grossEntitlementNear !== config.grossEntitlementNear) throw new Error('capture gross entitlement does not match the case');
  if (capture.claimBoundary !== config.boundary) throw new Error('capture boundary does not match the case');
  const code = Buffer.from(capture.codeBase64, 'base64');
  if (!code.length) throw new Error('capture code is empty');
  if (capture.codeHash !== hashContract(code)) throw new Error('capture.codeHash does not match its code');
  if (capture.codeSha256 !== sha256(code)) throw new Error(`capture.codeSha256 does not match its code: declared ${capture.codeSha256}, computed ${sha256(code)}, bytes ${code.length}`);
  if (capture.stateHash !== stateHash(capture.stateItems)) throw new Error('capture.stateHash does not match its state');
  if (capture.stateBytes !== parsed.value.length) throw new Error('capture.stateBytes does not match its state');
  if (!Number.isInteger(capture.blockHeight) || capture.blockHeight < 1) throw new Error('capture blockHeight is invalid');
  if (typeof capture.blockHash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(capture.blockHash)) throw new Error('capture blockHash is invalid');
  if (!capture.accountView || BigInt(capture.accountView.amount) <= 0n) throw new Error('capture accountView is invalid');
  return parsed;
}

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

async function waitForEntitlement(worker, accountId, predicate, viewMethod = 'get_refundable', attempts = 60) {
  let entitlement = null;
  for (let i = 0; i < attempts; i++) {
    entitlement = entitlementOf(await worker.provider.viewCall(accountId, viewMethod, {}, {finality: 'final'}));
    if (predicate(entitlement)) return entitlement;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return entitlement;
}

async function waitForStableAccount(worker, accountId, attempts = 40) {
  let previous = null;
  let stable = 0;
  for (let i = 0; i < attempts; i++) {
    const current = await waitForAccount(worker, accountId);
    if (previous && current.amount === previous.amount) stable += 1;
    else stable = 0;
    if (stable >= 3) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 500));
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

function extractTransfers(status, contractId, beneficiary) {
  const receipts = Array.isArray(status?.receipts) ? status.receipts : [];
  const transfers = [];
  for (const receipt of receipts) {
    const actions = receipt?.receipt?.Action?.actions || [];
    for (const action of actions) {
      const deposit = action?.Transfer?.deposit;
      if (deposit === undefined) continue;
      if (receipt.predecessor_id !== contractId || receipt.receiver_id !== beneficiary) continue;
      transfers.push({
        receiptId: receipt.receipt_id || null,
        predecessorId: receipt.predecessor_id,
        receiverId: receipt.receiver_id,
        amount: String(deposit),
      });
    }
  }
  return transfers;
}

function failureText(tx) {
  return JSON.stringify(tx?.receiptFailureMessages || tx?.Failure || '');
}

function transferEvidence(claim, beneficiary, obligation = null, transfers = null) {
  if (!claim?.receipts?.length) return {beneficiary, linked: false, links: [], transfers: transfers || [], amount: null, amountMatches: false};
  const links = [];
  for (const receipt of claim.receipts) {
    const next = receipt.status?.SuccessReceiptId;
    if (!next) continue;
    const linked = claim.receipts.find((item) => item.id === next);
    if (linked?.executorId === beneficiary && linked.status?.SuccessValue !== undefined) {
      links.push({
        contractReceiptId: receipt.id,
        beneficiaryReceiptId: linked.id,
        beneficiaryExecutorId: linked.executorId,
        beneficiaryStatus: linked.status,
        gasBurnt: linked.gasBurnt,
        tokensBurnt: linked.tokensBurnt,
      });
    }
  }
  const amountTransfers = Array.isArray(transfers) ? transfers : [];
  const ambiguous = links.length !== 1 || amountTransfers.length !== 1;
  const linkedTransfer = !ambiguous
    ? amountTransfers.find((transfer) => transfer.receiptId === links[0].beneficiaryReceiptId)
    : null;
  const amount = linkedTransfer?.amount ?? null;
  return {
    beneficiary,
    linked: links.length === 1,
    ambiguous,
    links,
    transfers: amountTransfers,
    amount,
    obligation: obligation === null ? null : String(obligation),
    amountMatches: !ambiguous && amount !== null && obligation !== null && BigInt(amount) === BigInt(obligation),
    note: links.length > 1 ? 'multiple beneficiary links; refusing to pick one' : amountTransfers.length > 1 ? 'multiple contract-to-beneficiary transfers; refusing to sum' : !linkedTransfer && links.length === 1 ? 'linked beneficiary receipt has no matching transfer action' : undefined,
  };
}

async function captureBaseline(config) {
  const worker = await Worker.init({network: 'sandbox'});
  try {
    assertLocal(worker);
    const runtime = runtimeOf(await worker.provider.status());
    if (!runtimePinMatches(runtime, config.runtimePin)) throw new Inconclusive('runtime does not match the declared pin before capture');
    const account = await worker.rootAccount.createSubAccount('refund', {initialBalance: parseNEAR(config.fundedNear)});
    await account.deploy(read(config.baselineWasm));
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
    const codeRaw = await worker.provider.viewCodeRaw(account.accountId, {block_id: height});
    const code = Buffer.isBuffer(codeRaw) ? codeRaw : Buffer.from(codeRaw, 'base64');
    const stateItems = sorted(await worker.provider.viewStateRaw(account.accountId, '', {block_id: height}));
    const capture = {
      schema: CAPTURE_SCHEMA,
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
      entitlement: entitlementOf(await worker.provider.viewCall(account.accountId, config.operation.view, {}, {finality: 'final'})).toString(),
      beneficiary: config.beneficiary,
      fundedNear: config.fundedNear,
      grossEntitlementNear: config.grossEntitlementNear,
      claimBoundary: config.boundary,
    };
    validateCapture(capture, config, runtime);
    const capturePath = path.resolve(ROOT, config.capture);
    fs.mkdirSync(path.dirname(capturePath), {recursive: true});
    fs.writeFileSync(capturePath, json(capture) + '\n');
    return capture;
  } finally {
    await worker.tearDown();
  }
}

async function runBranch(capture, config, candidate, expected) {
  const worker = await Worker.init({network: 'sandbox'});
  const result = {
    branch: candidate?.id || 'baseline',
    candidateLabel: candidate?.label || null,
    candidateSha256: candidate ? sha256(read(candidate.wasm)) : null,
    candidateCodeHash: null,
    deployedCodeHash: null,
    expected,
    status: 'inconclusive',
    runtime: null,
    runtimePinMatched: false,
    importCheck: null,
    migration: null,
    claim: null,
    transfer: null,
    controls: {outsiderDenied: null, migrationAuthorityDenied: null, secondClaimDenied: null},
    entitlement: {beforeMigration: null, afterMigration: null, afterClaim: null},
    balances: {status: null, contract: null, user: null},
    error: null,
  };
  try {
    assertLocal(worker);
    result.runtime = runtimeOf(await worker.provider.status());
    const parsedCapture = validateCapture(capture, config, result.runtime);
    result.runtimePinMatched = true;
    result.beneficiary = parsedCapture.beneficiary;

    const keyPair = KeyPair.fromRandom('ed25519');
    const contract = await worker.rootAccount.createSubAccount('refund', {keyPair, initialBalance: parseNEAR(config.fundedNear)});
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
    result.deployedCodeHash = result.importCheck.codeHash;
    if (candidate) result.candidateCodeHash = null;

    const user = await worker.rootAccount.createSubAccount(parsedCapture.beneficiary.split('.')[0], {initialBalance: parseNEAR('10')});
    if (user.accountId !== parsedCapture.beneficiary) throw new Error(`executed user ${user.accountId} does not match captured beneficiary ${parsedCapture.beneficiary}`);
    const userBefore = await waitForAccount(worker, user.accountId);
    const contractBefore = await waitForAccount(worker, contract.accountId);
    result.balances = {
      status: expected === 'NO_REFUND' ? 'interim' : 'final',
      contract: {initial: balanceOf(contractBefore).toString(), beforeClaim: null, after: null, delta: null},
      user: {initial: balanceOf(userBefore).toString(), beforeClaim: null, after: null, delta: null},
    };
    result.entitlement.beforeMigration = (await waitForEntitlement(worker, contract.accountId, () => true, config.operation.view)).toString();

    if (candidate) {
      await contract.deploy(read(candidate.wasm));
      result.candidateCodeHash = hashContract(await contract.viewCode());
      result.deployedCodeHash = result.candidateCodeHash;
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
      result.entitlement.afterMigration = (await waitForEntitlement(worker, contract.accountId, () => true, config.operation.view)).toString();
    } else {
      result.entitlement.afterMigration = result.entitlement.beforeMigration;
    }

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
    let rawClaimStatus = null;
    if (result.claim?.transactionHash) {
      try {
        rawClaimStatus = await worker.provider.sendJsonRpc('EXPERIMENTAL_tx_status', {
          tx_hash: result.claim.transactionHash,
          sender_account_id: user.accountId,
        });
      } catch (error) {
        throw new Inconclusive(`transfer amount status failed: ${error.message}`);
      }
    }
    const transfers = extractTransfers(rawClaimStatus, contract.accountId, parsedCapture.beneficiary);
    result.claim.transfers = transfers;
    result.transfer = transferEvidence(result.claim, parsedCapture.beneficiary, parsedCapture.amount, transfers);
    const expectsPayout = expected === 'success' || (expected === 'candidate' && claimTx.succeeded === true);
    result.entitlement.afterClaim = (await waitForEntitlement(worker, contract.accountId, (value) => expectsPayout ? value === 0n : true, config.operation.view)).toString();

    const contractAfter = await waitForBalance(worker, contract.accountId, (balance) => expectsPayout ? balance < BigInt(result.balances.contract.beforeClaim) : true);
    const userAfter = await waitForBalance(worker, user.accountId, (balance) => expectsPayout ? balance > BigInt(result.balances.user.beforeClaim) : true);
    result.balances.contract.after = balanceOf(contractAfter).toString();
    result.balances.contract.delta = (balanceOf(contractAfter) - BigInt(result.balances.contract.beforeClaim)).toString();
    result.balances.user.after = balanceOf(userAfter).toString();
    result.balances.user.delta = (balanceOf(userAfter) - BigInt(result.balances.user.beforeClaim)).toString();
    if (claimTx.failed) {
      result.balances.status = 'interim';
      result.balances.note = 'Failed claim: signer gas may settle after this read; this is not a final net payout measurement.';
    }

    const secondClaim = await user.callRaw(contract, config.operation.method, config.operation.args, {gas: GAS});
    result.controls.secondClaimDenied = secondClaim.failed === true && /NO_REFUND/.test(failureText(secondClaim));
    if (!result.controls.secondClaimDenied) throw new Error('second claim was not denied');

    if (expected === 'success' || (expected === 'candidate' && claimTx.succeeded === true)) {
      if (!claimTx.succeeded) throw new Error(`expected successful claim, got failure: ${failureText(claimTx)}`);
      if (!result.transfer.linked) throw new Error('successful claim lacks a contract SuccessReceiptId -> beneficiary SuccessValue link');
      if (result.transfer.amount === null) throw new Inconclusive('successful claim transfer amount is unverified');
      if (!result.transfer.amountMatches) {
        result.status = 'amount-regression';
        result.outcome = 'amount-regression';
        result.error = `paid ${result.transfer.amount} yocto, inherited obligation ${result.transfer.obligation} yocto`;
        return result;
      }
      if (BigInt(result.balances.user.delta) <= 0n) throw new Error('successful claim did not increase beneficiary balance');
      if (BigInt(result.balances.contract.delta) >= 0n) throw new Error('successful claim did not decrease contract balance');
      if (result.entitlement.afterClaim !== '0') throw new Error('successful claim did not clear entitlement');
      result.status = 'completed';
      result.outcome = 'paid';
    } else if (expected === 'NO_REFUND' || expected === 'candidate') {
      if (!claimTx.failed) throw new Error('candidate claim did not fail and was not accepted as a payout');
      if (!/NO_REFUND/.test(failureText(claimTx))) throw new Inconclusive(`claim failed for a non-NO_REFUND reason: ${failureText(claimTx)}`);
      if (result.entitlement.afterMigration !== '0') throw new Error('candidate migration did not clear entitlement');
      if (result.transfer.linked) throw new Error('failed claim unexpectedly linked to a beneficiary transfer');
      result.status = 'expected-failure';
      result.outcome = 'no-refund';
    } else {
      throw new Error(`unsupported expectation: ${expected}`);
    }
    return result;
  } catch (error) {
    const infrastructure = error instanceof Inconclusive || /fetch failed|ECONN|socket|RPC|network|timeout/i.test(error.message);
    result.status = infrastructure ? 'inconclusive' : 'error';
    result.error = error.message;
    return result;
  } finally {
    await worker.tearDown();
  }
}

async function main() {
  const caseArgIndex = process.argv.indexOf('--case');
  const reportArgIndex = process.argv.indexOf('--report');
  const caseFile = path.resolve(ROOT, caseArgIndex >= 0 ? (process.argv[caseArgIndex + 1] || 'cases/refund-v1/case.json') : 'cases/refund-v1/case.json');
  const reportPath = reportArgIndex >= 0
    ? path.resolve(ROOT, process.argv[reportArgIndex + 1] || 'out/refund-report.json')
    : path.join(OUT, 'refund-report.json');
  const config = validateCase(caseFile);
  const capturePath = path.resolve(ROOT, config.capture);
  let capture;
  if (fs.existsSync(capturePath)) capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  else capture = await captureBaseline(config);

  validateCapture(capture, config);
  const baseline = await runBranch(capture, config, null, config.expected.baseline);
  const bad = await runBranch(capture, config, config.candidates.bad, config.expected.bad);
  const corrected = await runBranch(capture, config, config.candidates.corrected, config.expected.corrected);

  const expectedBranches = [baseline, bad, corrected];
  const candidateOutcome = bad.status === 'completed' && bad.transfer?.linked === true && bad.transfer?.amountMatches === true
    ? 'paid'
    : bad.status === 'amount-regression'
      ? 'amount-regression'
      : bad.status === 'expected-failure'
        && /NO_REFUND/.test(failureText({receiptFailureMessages: bad.claim?.receiptFailures || []}))
        && bad.transfer?.linked === false
        ? 'no-refund'
        : 'inconclusive';
  const candidateClassified = candidateOutcome !== 'inconclusive';
  const branchOutcomesMatch = expectedBranches.every((branch) => {
    if (branch.expected === 'success') return branch.status === 'completed';
    if (branch.expected === 'NO_REFUND') return branch.status === 'expected-failure';
    if (branch.expected === 'candidate') return branch.status === 'completed' || branch.status === 'expected-failure';
    return false;
  });
  const sameStartingState = expectedBranches.every((branch) => branch.importCheck?.matches === true);
  const controls = expectedBranches.every((branch) => branch.controls.outsiderDenied === true && branch.controls.secondClaimDenied === true)
    && bad.controls.migrationAuthorityDenied === true
    && corrected.controls.migrationAuthorityDenied === true;
  const baselineCorrectedTransfer = [baseline, corrected].every((branch) =>
    branch.status === 'completed'
    && branch.transfer?.linked === true
    && branch.transfer?.beneficiary === capture.beneficiary
    && branch.transfer?.amountMatches === true
    && BigInt(branch.balances.user.delta) > 0n
    && BigInt(branch.balances.contract.delta) < 0n);
  const candidateTransferGate = candidateOutcome === 'paid'
    ? (bad.status === 'completed'
      && bad.transfer?.linked === true
      && bad.transfer?.amountMatches === true
      && BigInt(bad.balances.user.delta) > 0n
      && BigInt(bad.balances.contract.delta) < 0n)
    : candidateOutcome === 'no-refund';
  const claimTransferToBeneficiary = baselineCorrectedTransfer && candidateTransferGate;
  const badFailureIsStructured = candidateOutcome === 'no-refund';

  const complete = branchOutcomesMatch && candidateClassified && sameStartingState && controls
    && claimTransferToBeneficiary && (candidateOutcome === 'paid' || badFailureIsStructured);
  const report = {
    schema: REPORT_SCHEMA,
    case: config.id,
    label: config.label,
    generatedAt: new Date().toISOString(),
    boundary: config.boundary,
    capture: {
      contract: capture.contract,
      blockHeight: capture.blockHeight,
      blockHash: capture.blockHash,
      codeHash: capture.codeHash,
      codeSha256: capture.codeSha256,
      stateHash: capture.stateHash,
      stateBytes: capture.stateBytes,
      entitlement: capture.entitlement,
      beneficiary: capture.beneficiary,
      fundedNear: capture.fundedNear,
      grossEntitlementNear: capture.grossEntitlementNear,
      runtime: capture.runtime,
      claimBoundary: capture.claimBoundary,
    },
    operation: config.operation,
    migration: config.migration,
    branches: {baseline, bad, corrected},
    result: {
      status: complete ? 'complete' : 'incomplete',
      expected: config.expected,
      sameStartingState,
      controls,
      badFailureIsStructured,
      candidateOutcome,
      candidateClassified,
      claimTransferToBeneficiary,
      runtimePinned: expectedBranches.every((branch) => branch.runtimePinMatched === true),
    },
  };
  fs.mkdirSync(path.dirname(reportPath), {recursive: true});
  fs.writeFileSync(reportPath, json(report) + '\n');
  console.log(json(report));
  if (!complete) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  validateCase,
  validateCaseConfig,
  validateCapture,
  parseCaptureState,
  transferEvidence,
  runtimeOf,
  runtimePinMatches,
  stateHash,
  hashContract,
  sha256,
};
