'use strict';
/*
 * Acceptance policy for the failed-refund settlement obligation.
 *
 * This is intentionally independent of the candidate's own report verdict: it
 * recomputes the debt/refund/retry facts from a fresh local execution report.
 */
const BOND = 10n ** 24n;
const REQUIRED_SCHEMA = 'near-rehearsal/settlement-refund/v1';

function verifySettlementReport(report, opts = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const text = (value) => (value === null || value === undefined ? '' : String(value));
  if (report?.schema !== REQUIRED_SCHEMA) fail('settlement report schema');
  if (!report?.candidate?.wasmSha256 || !/^[0-9a-f]{64}$/.test(report.candidate.wasmSha256)) fail('settlement candidate WASM hash missing');
  if (opts.candidateWasmSha256 && report?.candidate?.wasmSha256 !== opts.candidateWasmSha256) fail('settlement report is for a different candidate WASM');
  if (report?.ok !== true || (Array.isArray(report?.errors) && report.errors.length)) fail(`settlement execution was not clean: ${(report?.errors || []).join('; ') || 'ok is not true'}`);

  const failed = report?.failedRefund;
  if (!failed) fail('failed-refund snapshot missing');
  if (text(failed?.lockedAmount) !== BOND.toString()) fail('failed refund did not retain the locked debt');
  if (failed?.proposal?.status !== 'Failed') fail('failed refund did not leave the proposal Failed');

  const before = report?.beforeRetry;
  const after = report?.afterRetry;
  if (!before || !after) fail('retry snapshots missing');
  else {
    if (text(before.lockedAmount) !== BOND.toString()) fail('retry did not start with the debt still locked');
    const delta = BigInt(after.proposer ?? 0) - BigInt(before.proposer ?? 0);
    if (delta !== BOND) fail(`retry proposer delta is ${delta}, expected exactly one bond`);
    if (text(after.lockedAmount) !== '0') fail('successful retry did not clear the debt');
  }

  if (text(report?.afterDuplicate?.proposer) !== text(after?.proposer)) fail('duplicate retry changed the proposer balance');
  if (text(report?.afterDuplicate?.lockedAmount) !== '0') fail('duplicate retry changed the locked debt');
  if (text(report?.afterUnauthorized?.proposer) !== text(after?.proposer)) fail('unauthorized callback changed the proposer balance');
  if (text(report?.afterUnauthorized?.lockedAmount) !== '0') fail('unauthorized callback changed the locked debt');

  const unauthorized = report?.unauthorized;
  const unauthorizedReceipts = unauthorized?.value?.receipts || unauthorized?.receipts || [];
  if (!unauthorized || unauthorized.ok === true) fail('unauthorized callback was accepted');
  else {
    const failures = unauthorizedReceipts.filter((receipt) => receipt?.status?.Failure);
    if (!failures.some((receipt) => JSON.stringify(receipt.status).includes('Method on_refund_callback is private'))) {
      fail('unauthorized callback did not fail with the private-method denial');
    }
  }
  if (report?.unauthorizedArgs?.attempt !== 999) fail('unauthorized callback did not use the numeric attempt argument');

  const overlap = report?.overlap;
  if (!overlap || overlap.ok !== true) fail('overlapping retry evidence missing or failed');
  else {
    if (overlap.delta !== BOND.toString()) fail('overlapping retries did not pay exactly one bond');
    if (text(overlap.lockedAfter) !== '0') fail('overlapping retries did not settle the debt');
  }

  return {
    ok: errors.length === 0,
    errors,
    outcomes: {
      failedRefundLocked: text(failed?.lockedAmount),
      retryDelta: before && after ? (BigInt(after.proposer ?? 0) - BigInt(before.proposer ?? 0)).toString() : null,
      duplicateDelta: text(report?.afterDuplicate?.proposer) && text(after?.proposer) ? (BigInt(report.afterDuplicate.proposer) - BigInt(after.proposer)).toString() : null,
      unauthorizedDenied: Boolean(unauthorized && unauthorized.ok !== true),
      overlapDelta: overlap?.delta ?? null,
    },
  };
}

module.exports = {verifySettlementReport, BOND, REQUIRED_SCHEMA};
