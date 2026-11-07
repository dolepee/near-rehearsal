'use strict';
/*
 * Independent acceptance for persisted old-code failure recovery.
 *
 * This verifier deliberately uses the frozen entitlement/locked amount and
 * the measured gross recovery, not a claim that raw native balances never move.
 * Upgrade/deploy/finalize costs are legitimate and recorded separately.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');

const BASE_WASM_SHA = '5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578';
const BOND = 10n ** 24n;
const TRANSFER = 10n ** 23n;
const SANDBOX = '2.14.0';
const SANDBOX_COMMIT = 'bc4e9e8cfb03d9e82f027883055624e18576993e';
const SANDBOX_PROTOCOL = 88;
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function verify(report, options = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (report?.schema !== 'near-rehearsal/persisted-bond-recovery/v1') fail('report schema');
  if (report?.runtime?.sandbox !== SANDBOX) fail('Sandbox is not 2.14.0');
  if (report?.runtime?.commit !== SANDBOX_COMMIT) fail('Sandbox commit');
  if (Number(report?.runtime?.protocol) !== SANDBOX_PROTOCOL) fail('Sandbox protocol');
  if (report?.source?.baseWasmSha256 !== BASE_WASM_SHA) fail('base WASM identity');
  if (report?.initialization?.calls !== 1 || report?.initialization?.onlyOnce !== true) fail('contract was not initialized exactly once');

  const expectedWasm = options.expectedWasmSha256 || report?.candidate?.wasmSha256;
  if (!expectedWasm || report?.candidate?.wasmSha256 !== expectedWasm) fail('candidate WASM SHA-256');
  if (report?.candidate?.wasmHash !== report?.upgrade?.codeHash) fail('upgraded code hash does not match candidate');
  if (options.expectedPatchSha256 && report?.identity?.patch?.sha256 !== options.expectedPatchSha256) fail('candidate patch SHA-256');
  if (options.expectedSourceSha256 && report?.identity?.source?.sha256 !== options.expectedSourceSha256) fail('candidate source SHA-256');
  if (report?.identity) {
    if (report.identity.wasm?.sha256 !== report.candidate.wasmSha256) fail('identity WASM does not match report');
    if (report.identity.patch?.sha256 && options.expectedPatchSha256 && report.identity.patch.sha256 !== options.expectedPatchSha256) fail('identity patch SHA-256');
  }
  if (options.patchPath && !errors.some((e) => /patch SHA/.test(e))) {
    const actual = sha256File(options.patchPath);
    if (report?.identity?.patch?.sha256 && actual !== report.identity.patch.sha256) fail('patch file changed after identity binding');
  }
  if (options.sourcePath) {
    const actual = sha256File(options.sourcePath);
    if (report?.identity?.source?.sha256 && actual !== report.identity.source.sha256) fail('source file changed after identity binding');
  }

  const frozen = report?.failed?.frozen;
  if (report?.failed?.proposal?.status !== 'Failed') fail('old-code proposal did not end Failed');
  if (frozen?.proposal?.status !== 'Failed') fail('frozen proposal is not Failed');
  if (BigInt(frozen?.lockedAmount ?? '-1') !== BOND) fail('frozen locked amount is not the declared bond');
  const beforeContract = BigInt(report?.failed?.beforeProposal?.contract ?? '-1');
  const afterAddContract = BigInt(report?.failed?.afterAdd?.contract ?? '-2');
  if (afterAddContract - beforeContract !== BOND) fail('bond was not attached to the failed proposal');
  if (report?.failed?.afterAdd?.proposal?.status !== 'InProgress') fail('proposal was not in progress after add');
  if (report?.deploy?.succeeded !== true || report?.init?.succeeded !== true) fail('base deploy/init did not succeed');
  if (report?.failed?.add?.succeeded !== true) fail('failed proposal add did not succeed');
  if (report?.failed?.vote?.succeeded !== true) fail('failed proposal vote did not succeed');

  if (report?.authority?.unauthorizedUpdateRejected !== true) fail('unauthorized update was not rejected');
  if (report?.authority?.unauthorizedFinalizeRejected !== true) fail('unauthorized finalize was not rejected');
  if (report?.authority?.upgradeMethod !== 'account-key deploy + private migrate') fail('upgrade method is not the declared account-key deploy/migrate path');
  if (report?.authority?.upgradeCaller !== report?.accounts?.contract) fail('upgrade caller is not the recorded contract account');
  if (report?.authority?.finalizeCaller !== report?.accounts?.proposer) fail('finalize caller is not the recorded proposer');
  if (report?.upgrade?.final?.receiptFailure === true || report?.upgrade?.migrate?.receiptFailure === true) fail('upgrade/migrate receipt failed');

  if (report?.preservation?.state !== true) fail('state changed across code replacement');
  if (report?.preservation?.policy !== true) fail('policy changed across code replacement');
  if (report?.preservation?.proposal !== true) fail('proposal changed across code replacement');
  if (report?.preservation?.lockedAmount !== true) fail('locked funds changed across code replacement');
  if (report?.preservation?.codeChanged !== true) fail('candidate code was not applied');
  if (report?.preservation?.noNew !== true) fail('no-new invariant missing');

  if (BigInt(report?.firstRecovery?.grossRecoveryYocto ?? '0') !== BOND) fail('first recovery did not recover exactly the bond');
  if (report?.firstRecovery?.proposal?.status !== 'Failed') fail('first recovery did not end Failed');
  if (report?.firstRecovery?.noTargetPayment !== true) fail('first recovery paid the failed target');
  if (BigInt(report?.firstRecovery?.after?.lockedAmount ?? '-1') !== 0n) fail('bond remains locked after first recovery');
  if (BigInt(report?.secondRetry?.grossRecoveryYocto ?? '1') !== 0n) fail('second retry recovered another bond');
  if (report?.secondRetry?.proposal?.status !== 'Failed') fail('second retry did not end Failed');
  if (report?.secondRetry?.noTargetPayment !== true) fail('second retry paid the failed target');
  if (BigInt(report?.secondRetry?.deltas?.locked ?? '1') !== 0n) fail('second retry changed the locked entitlement');
  if (BigInt(report?.firstRecovery?.deltas?.recipient ?? '1') !== 0n) fail('first recovery recipient delta is not zero');
  if (BigInt(report?.secondRetry?.deltas?.recipient ?? '1') !== 0n) fail('second retry recipient delta is not zero');

  const healthy = report?.healthyPreservation;
  if (!healthy) fail('healthy/past-settled control missing');
  else {
    if (healthy.checks?.settledApproved !== true) fail('past-settled proposal is not Approved');
    if (BigInt(healthy.checks?.settledPayout ?? '0') !== TRANSFER) fail('past-settled payout is not the declared transfer');
    if (healthy.checks?.upgradeCode !== true) fail('past-settled control was not upgraded to candidate code');
    if (healthy.checks?.proposalPreserved !== true) fail('past-settled proposal changed across upgrade');
    if (healthy.checks?.recipientPreserved !== true) fail('past-settled recipient changed across upgrade');
    if (healthy.checks?.lockedCleared !== true) fail('past-settled control still has locked funds');
    if (healthy.checks?.noFurtherPayout !== true) fail('past-settled control paid again after finalize attempt');
  }
  return errors;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--report') opts.report = args[++i];
    else if (arg === '--expected-wasm-sha256') opts.expectedWasmSha256 = args[++i];
    else if (arg === '--expected-patch-sha256') opts.expectedPatchSha256 = args[++i];
    else if (arg === '--expected-source-sha256') opts.expectedSourceSha256 = args[++i];
    else if (arg === '--patch') opts.patchPath = args[++i];
    else if (arg === '--source') opts.sourcePath = args[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.report) throw new Error('--report is required');
  const report = JSON.parse(fs.readFileSync(opts.report, 'utf8'));
  const errors = verify(report, opts);
  console.log(JSON.stringify({
    schema: 'near-rehearsal/persisted-bond-recovery-acceptance/v1',
    ok: errors.length === 0,
    candidateWasmSha256: report?.candidate?.wasmSha256 ?? null,
    errors,
  }, null, 2));
  if (errors.length) process.exitCode = 1;
}

module.exports = {verify, BASE_WASM_SHA, BOND, TRANSFER};
