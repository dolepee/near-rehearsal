'use strict';
/*
 * Acceptance policy for the failed-refund settlement obligation.
 *
 * This is intentionally independent of the candidate's own report verdict: it
 * recomputes the debt/refund/retry facts from a fresh local execution report.
 *
 * An accepted settlement report must contain two independently executed
 * scenarios: the candidate deployed from genesis, and a proposal created on the
 * pinned base artifact and inherited across an upgrade to the candidate. The
 * second scenario is what proves the historical bond/refund state survives.
 */
const BOND = 10n ** 24n;
const REQUIRED_SCHEMA = 'near-rehearsal/settlement-refund/v2';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes) {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) + BigInt(byte);
  let out = '';
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = `1${out}`; }
  return out || '1';
}

function deploymentCommitment(deploy, label, fail) {
  if (!deploy || deploy.finalExecutionStatus !== 'FINAL') { fail(`${label} deployment was not FINAL`); return null; }
  if (!deploy.transactionOutcome?.status?.SuccessReceiptId) { fail(`${label} deployment has no successful receipt`); }
  const action = (deploy.transaction?.actions || []).find((entry) => entry && entry.DeployContract);
  if (!action) { fail(`${label} deployment has no DeployContract action`); return null; }
  let code;
  try { code = Buffer.from(action.DeployContract.code, 'base64'); } catch { code = null; }
  if (!code || code.length !== 32) { fail(`${label} DeployContract code commitment is not 32 bytes`); return null; }
  const sha256 = code.toString('hex');
  if (deploy.wasmSha256 !== sha256) fail(`${label} deployment label does not match its DeployContract commitment`);
  if (deploy.codeHash !== base58Encode(code)) fail(`${label} installed code hash does not match its DeployContract commitment`);
  return sha256;
}

const DEFAULT_BASE_WASM_SHA256 = '5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578';

function verifyScenario(scenario, mode, context) {
  const {fail, text, candidateWasmSha256, baseWasmSha256, report} = context;
  if (!scenario) { fail(`${mode} settlement scenario is missing`); return null; }
  const failFor = (condition, message) => { if (!condition) fail(`${mode}: ${message}`); };

  if (mode === 'candidate-only') {
    if (scenario.legacy) failFor(false, 'fresh candidate scenario must not claim legacy upgrade evidence');
    const committed = deploymentCommitment(scenario.deploy, 'fresh candidate', (message) => failFor(false, message));
    if (committed !== candidateWasmSha256) failFor(false, 'fresh candidate deployment does not commit to the candidate WASM');
    if (scenario.deploy?.wasmSha256 !== candidateWasmSha256) failFor(false, 'fresh candidate scenario did not deploy the candidate WASM');
    const upgrade = report?.inherited?.transactions?.upgrade;
    if (upgrade && scenario.deploy?.codeHash && upgrade.codeHash && scenario.deploy.codeHash !== upgrade.codeHash) {
      failFor(false, 'fresh deployment installed different code from the inherited upgrade');
    }
  } else {
    const legacy = scenario.legacy;
    if (!legacy) failFor(false, 'legacy upgrade proof is missing');
    else {
      if (legacy.baseWasmSha256 !== baseWasmSha256) failFor(false, 'legacy base WASM identity is wrong');
      if (legacy.candidateWasmSha256 !== candidateWasmSha256) failFor(false, 'legacy candidate identity is wrong');
      if (legacy.upgradeCodeHash !== scenario.transactions?.upgrade?.codeHash || !legacy.upgradeCodeHash) failFor(false, 'legacy upgrade did not install the candidate');
      if (legacy.proposalCreatedBeforeUpgrade !== true) failFor(false, 'legacy proposal was not created before upgrade');
      if (legacy.legacyFinalize?.finalExecutionStatus !== 'FINAL') failFor(false, 'legacy finalize evidence is missing');
    }
    const upgrade = scenario.transactions?.upgrade;
    if (!upgrade || upgrade.candidateWasmSha256 !== candidateWasmSha256 || !upgrade.deploy || !upgrade.migrate) {
      failFor(false, 'legacy upgrade transaction evidence is missing');
    } else {
      const upgradedCode = deploymentCommitment(upgrade.deploy, 'inherited upgrade', (message) => failFor(false, message));
      if (upgradedCode !== candidateWasmSha256) failFor(false, 'inherited upgrade does not commit to the candidate WASM');
      if (upgrade.codeHash !== base58Encode(Buffer.from(candidateWasmSha256, 'hex'))) failFor(false, 'inherited installed code hash is not the candidate');
      if (upgrade.migrate?.finalExecutionStatus !== 'FINAL' || !upgrade.migrate?.transactionOutcome?.status?.SuccessReceiptId) failFor(false, 'inherited migrate was not successful');
    }
    const baseCommitted = deploymentCommitment(scenario.deploy, 'inherited base', (message) => failFor(false, message));
    if (baseCommitted !== baseWasmSha256) failFor(false, 'inherited scenario does not commit to the pinned base WASM');
    if (scenario.deploy?.wasmSha256 !== baseWasmSha256) failFor(false, 'inherited scenario did not deploy the pinned base WASM');
  }

  const failed = scenario.failedRefund;
  if (!failed) failFor(false, 'failed-refund snapshot missing');
  else {
    if (text(failed.lockedAmount) !== BOND.toString()) failFor(false, 'failed refund did not retain the locked debt');
    if (failed.proposal?.status !== 'Failed') failFor(false, 'failed refund did not leave the proposal Failed');
  }

  const before = scenario.beforeRetry;
  const after = scenario.afterRetry;
  let retryDelta = null;
  if (!before || !after) failFor(false, 'retry snapshots missing');
  else {
    if (text(before.lockedAmount) !== BOND.toString()) failFor(false, 'retry did not start with the debt still locked');
    retryDelta = BigInt(after.proposer ?? 0) - BigInt(before.proposer ?? 0);
    if (retryDelta !== BOND) failFor(false, `retry proposer delta is ${retryDelta}, expected exactly one bond`);
    if (text(after.lockedAmount) !== '0') failFor(false, 'successful retry did not clear the debt');
  }

  if (text(scenario.afterDuplicate?.proposer) !== text(after?.proposer)) failFor(false, 'duplicate retry changed the proposer balance');
  if (text(scenario.afterDuplicate?.lockedAmount) !== '0') failFor(false, 'duplicate retry changed the locked debt');
  if (text(scenario.afterUnauthorized?.proposer) !== text(after?.proposer)) failFor(false, 'unauthorized callback changed the proposer balance');
  if (text(scenario.afterUnauthorized?.lockedAmount) !== '0') failFor(false, 'unauthorized callback changed the locked debt');

  const unauthorized = scenario.unauthorized;
  const unauthorizedReceipts = unauthorized?.value?.receipts || unauthorized?.receipts || [];
  if (!unauthorized || unauthorized.ok === true) failFor(false, 'unauthorized callback was accepted');
  else {
    const failures = unauthorizedReceipts.filter((receipt) => receipt?.status?.Failure);
    if (!failures.some((receipt) => JSON.stringify(receipt.status).includes('Method on_refund_callback is private'))) {
      failFor(false, 'unauthorized callback did not fail with the private-method denial');
    }
  }
  if (scenario.unauthorizedArgs?.attempt !== 999) failFor(false, 'unauthorized callback did not use the numeric attempt argument');

  const overlap = scenario.overlap;
  if (!overlap || overlap.ok !== true) failFor(false, 'overlapping retry evidence missing or failed');
  else {
    if (overlap.kind !== 'concurrent-submission') failFor(false, 'overlap evidence is not a concurrent submission');
    if (overlap.distinctHashes !== true) failFor(false, 'overlap attempts reused one transaction hash');
    if (overlap.distinctSigners !== true) failFor(false, 'overlap attempts were not independently signed');
    if (overlap.bothFinal !== true) failFor(false, 'both overlap attempts were not executed to FINAL');
    if (overlap.receiptBacked !== true) failFor(false, 'overlap attempts are not receipt-backed');
    const attempts = Array.isArray(overlap.attempts) ? overlap.attempts : [];
    if (attempts.length !== 2) failFor(false, 'overlap evidence must record exactly two attempts');
    attempts.forEach((attempt, index) => {
      if (!attempt?.transactionHash) failFor(false, `overlap attempt ${index + 1} has no transaction hash`);
      if (attempt?.finalExecutionStatus !== 'FINAL') failFor(false, `overlap attempt ${index + 1} did not reach FINAL`);
      if (!attempt?.signerId) failFor(false, `overlap attempt ${index + 1} has no signer identity`);
      if (!Array.isArray(attempt?.receiptIds) || attempt.receiptIds.length === 0) failFor(false, `overlap attempt ${index + 1} has no executed receipts`);
    });
    const hashes = attempts.map((attempt) => attempt?.transactionHash).filter(Boolean);
    if (new Set(hashes).size !== 2) failFor(false, 'overlap did not produce two distinct transactions');
    const signers = attempts.map((attempt) => attempt?.signerId).filter(Boolean);
    if (new Set(signers).size !== 2) failFor(false, 'overlap did not produce two distinct signers');
    if (overlap.delta !== BOND.toString()) failFor(false, 'overlapping retries did not pay exactly one bond');
    if (text(overlap.lockedAfter) !== '0') failFor(false, 'overlapping retries did not settle the debt');
  }

  return {
    failedRefundLocked: text(failed?.lockedAmount),
    retryDelta: before && after ? (BigInt(after.proposer ?? 0) - BigInt(before.proposer ?? 0)).toString() : null,
    duplicateDelta: text(scenario.afterDuplicate?.proposer) && text(after?.proposer) ? (BigInt(scenario.afterDuplicate.proposer) - BigInt(after.proposer)).toString() : null,
    unauthorizedDenied: Boolean(unauthorized && unauthorized.ok !== true),
    overlapDelta: overlap?.delta ?? null,
  };
}

function verifySettlementReport(report, opts = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const text = (value) => (value === null || value === undefined ? '' : String(value));
  if (report?.schema !== REQUIRED_SCHEMA) fail(`settlement report schema must be ${REQUIRED_SCHEMA}`);
  const candidateWasmSha256 = report?.candidate?.wasmSha256;
  if (!candidateWasmSha256 || !/^[0-9a-f]{64}$/.test(candidateWasmSha256)) fail('settlement candidate WASM hash missing');
  const baseWasmSha256 = opts.baseWasmSha256 || DEFAULT_BASE_WASM_SHA256;
  if (report?.baseWasmSha256 !== baseWasmSha256) fail('settlement base WASM identity is wrong');
  if (opts.candidateWasmSha256 && candidateWasmSha256 !== opts.candidateWasmSha256) fail('settlement report is for a different candidate WASM');
  if (report?.ok !== true || (Array.isArray(report?.errors) && report.errors.length)) {
    fail(`settlement execution was not clean: ${(report?.errors || []).join('; ') || 'ok is not true'}`);
  }

  const context = {fail, text, candidateWasmSha256, baseWasmSha256, report};
  const freshOutcomes = verifyScenario(report?.fresh, 'candidate-only', context);
  const inheritedOutcomes = verifyScenario(report?.inherited, 'legacy-upgrade', context);

  return {
    ok: errors.length === 0,
    errors,
    outcomes: inheritedOutcomes ? {
      ...inheritedOutcomes,
      fresh: freshOutcomes,
      inherited: inheritedOutcomes,
    } : (freshOutcomes ? {fresh: freshOutcomes, inherited: null} : null),
  };
}

module.exports = {verifySettlementReport, BOND, REQUIRED_SCHEMA, DEFAULT_BASE_WASM_SHA256};
