'use strict';
/*
 * Controller-side acceptance for the issue #238 repair checkpoint.
 * This reads the two local Sandbox reports; it does not deploy or sign.
 * The controller owns these predicates; the repair source never sees them.
 */
const fs = require('node:fs');
const path = require('node:path');

const BOND = 10n ** 24n;
const TRANSFER = 10n ** 23n;
const GAS_ONLY_MAX = 10n ** 22n;
const AUTHORED_REPAIRED_SHA = '539f1bb88d00dc8cc7153a7d6d00a3cbeab1579fd1fdfc2931d36e85adc710ff';

function sha256File(file) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verifyCandidateFiles(identity, files) {
  const errors = [];
  const fail = (m) => errors.push(m);
  if (identity?.schema !== 'near-rehearsal/repair-candidate-identity/v1') fail('candidate identity schema');
  if (!identity?.source?.commit) fail('candidate identity source commit');
  if (!identity?.source?.path) fail('candidate identity source path');
  if (!/^[0-9a-f]{64}$/.test(identity?.source?.sha256 || '')) fail('candidate identity source hash');
  if (!/^[0-9a-f]{64}$/.test(identity?.patch?.sha256 || '')) fail('candidate identity patch hash');
  if (!/^[0-9a-f]{64}$/.test(identity?.wasm?.sha256 || '')) fail('candidate identity wasm hash');
  if (!files?.patch || !files?.source || !files?.wasm) {
    fail('candidate identity requires actual patch, applied source and wasm files');
    return errors;
  }
  for (const [name, file] of Object.entries(files)) {
    try {
      const actual = sha256File(file);
      const expected = name === 'patch' ? identity?.patch?.sha256 : name === 'source' ? identity?.source?.sha256 : identity?.wasm?.sha256;
      if (actual !== expected) fail(`candidate ${name} hash does not match identity`);
    } catch (error) {
      fail(`cannot read candidate ${name}: ${error.message}`);
    }
  }
  return errors;
}

function verify(base, repaired, options = {}) {
  const errors = [];
  const fail = (m) => errors.push(m);
  for (const [name, report] of [['base', base], ['repaired', repaired]]) {
    if (report?.schema !== 'near-rehearsal/issue238-local/v1') fail(`${name} report schema`);
    if (report?.source?.commit !== '5434a59dec23ee0c49df8c8c4350c208a7e75b0b') fail(`${name} source commit`);
    if (report?.runtime?.sandbox !== '2.14.0') fail(`${name} report Sandbox is not 2.14.0`);
    if (report?.runtime?.commit !== 'bc4e9e8cfb03d9e82f027883055624e18576993e') fail(`${name} report Sandbox commit`);
    if (Number(report?.runtime?.protocol) !== 88) fail(`${name} report Sandbox protocol`);
    if (!/^[0-9a-f]{64}$/.test(report?.runtime?.binarySha256 || '')) fail(`${name} report Sandbox binary hash`);
    if (report?.healthy?.after?.proposal?.status !== 'Approved') fail(`${name} healthy status`);
    if (report?.failed?.after?.proposal?.status !== 'Failed') fail(`${name} failed status`);
    if (BigInt(report?.healthy?.deltas?.recipient ?? '0') !== TRANSFER) fail(`${name} healthy recipient payout`);
    if (BigInt(report?.healthy?.deltas?.contract ?? '0') !== -TRANSFER) fail(`${name} healthy contract debit`);
    if (BigInt(report?.failed?.deltas?.recipient ?? '0') !== 0n) fail(`${name} failed recipient payout`);
  }
  for (const [name, report] of [['base', base], ['repaired', repaired]]) {
    if (JSON.stringify(report?.healthy?.before) !== JSON.stringify(report?.failed?.before)) fail(`${name} branches did not start from identical state`);
  }
  for (const [name, report] of [['base', base], ['repaired', repaired]]) {
    const callback = report?.healthy?.unauthorizedCallback;
    if (!callback?.receipts?.some((receipt) => receipt.status?.Failure)) fail(`${name} unauthorized callback was not rejected on its receipt`);
    if (report?.healthy?.kind?.Transfer?.receiver_id !== 'recipient.test.near') fail(`${name} healthy beneficiary changed`);
    if (BigInt(report?.healthy?.kind?.Transfer?.amount ?? '0') !== TRANSFER) fail(`${name} healthy transfer amount changed`);
  }
  if (JSON.stringify(base?.healthy?.before?.state) !== JSON.stringify(repaired?.healthy?.before?.state)) fail('base and repaired branches did not start from the same frozen state');
  if (JSON.stringify(base?.healthy?.before?.policy) !== JSON.stringify(repaired?.healthy?.before?.policy)) fail('base and repaired policy differ');
  if (base?.source?.wasmSha256 !== '5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578') fail('base artifact identity');
  if (options.candidateIdentity) {
    const identity = options.candidateIdentity;
    if (identity?.schema !== 'near-rehearsal/repair-candidate-identity/v1') fail('candidate identity schema');
    if (identity?.source?.commit !== repaired?.source?.commit) fail('candidate source commit does not match repaired report');
    if (!identity?.source?.path) fail('candidate source path missing');
    if (!/^[0-9a-f]{64}$/.test(identity?.source?.sha256 || '')) fail('candidate source hash invalid');
    if (!/^[0-9a-f]{64}$/.test(identity?.patch?.sha256 || '')) fail('candidate patch hash invalid');
    if (repaired?.source?.wasmSha256 !== identity?.wasm?.sha256) fail('repaired artifact does not match controller-built candidate');
    if (options.candidateFiles) errors.push(...verifyCandidateFiles(identity, options.candidateFiles));
  } else if (repaired?.source?.wasmSha256 !== AUTHORED_REPAIRED_SHA) {
    fail('repaired artifact identity');
  }
  if (BigInt(base?.failed?.deltas?.contract ?? '0') !== BOND) fail('base failed branch did not strand the bond');
  if (BigInt(repaired?.failed?.deltas?.contract ?? '1') !== 0n) fail('repair did not return the bond exactly once');
  if (BigInt(repaired?.failed?.deltas?.proposer ?? '0') >= 0n) fail('repaired proposer did not pay gas');
  if (BigInt(repaired?.failed?.deltas?.proposer ?? '0') < -GAS_ONLY_MAX) fail('repaired proposer lost bond-scale funds');
  if (BigInt(base?.failed?.deltas?.proposer ?? '0') > -BOND) fail('base proposer did not demonstrate stranded bond');

  // Exactly-once retry: the failed proposal is finalized again. The retry must
  // start from the immediate post-failure state, must not pay the recipient,
  // and must not credit the proposer a second bond. A positive proposer delta
  // here is the double-refund signature, not ordinary gas.
  for (const [name, report] of [['base', base], ['repaired', repaired]]) {
    const retry = report?.failed?.retry;
    if (!retry?.before || !retry?.after || !retry?.deltas) {
      fail(`${name} missing failed-proposal retry evidence`);
      continue;
    }
    const anchor = report?.failed?.afterUnauthorized;
    if (!anchor) { fail(`${name} missing post-failure pre-retry anchor`); continue; }
    for (const field of ['contract', 'proposer', 'recipient']) {
      if (String(retry.before[field]) !== String(anchor[field])) fail(`${name} retry does not start from the immediate pre-retry ${field}`);
    }
    if (JSON.stringify(retry.before.state) !== JSON.stringify(anchor.state)) fail(`${name} retry does not start from the immediate pre-retry state`);
    if (BigInt(retry.deltas.recipient ?? '0') !== 0n) fail(`${name} retry paid the failed recipient`);
    if (BigInt(retry.deltas.proposer ?? '0') > 0n) fail(`${name} retry returned a second bond to the proposer`);
    if (BigInt(retry.deltas.contract ?? '0') > 0n) fail(`${name} retry increased the contract balance`);
  }
  return errors;
}

if (require.main === module) {
  const here = __dirname;
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--base') opts.base = path.resolve(args[++i]);
    else if (args[i] === '--repaired') opts.repaired = path.resolve(args[++i]);
    else if (args[i] === '--identity') opts.identity = path.resolve(args[++i]);
    else if (args[i] === '--patch') opts.patch = path.resolve(args[++i]);
    else if (args[i] === '--source') opts.source = path.resolve(args[++i]);
    else if (args[i] === '--wasm') opts.wasm = path.resolve(args[++i]);
    else throw new Error(`unknown argument: ${args[i]}`);
  }
  const base = JSON.parse(fs.readFileSync(opts.base || path.join(here, 'out/issue238-local.json'), 'utf8'));
  const repaired = JSON.parse(fs.readFileSync(opts.repaired || path.join(here, 'out/issue238-repaired.json'), 'utf8'));
  const candidateIdentity = opts.identity ? JSON.parse(fs.readFileSync(opts.identity, 'utf8')) : undefined;
  if (candidateIdentity && (!opts.patch || !opts.source || !opts.wasm)) {
    throw new Error('candidate identity requires --patch, --source and --wasm');
  }
  const candidateFiles = candidateIdentity ? {patch: opts.patch, source: opts.source, wasm: opts.wasm} : undefined;
  const errors = verify(base, repaired, {candidateIdentity, candidateFiles});
  const frozenStateEqual = JSON.stringify(base.healthy.before.state) === JSON.stringify(repaired.healthy.before.state);
  const policyEqual = JSON.stringify(base.healthy.before.policy) === JSON.stringify(repaired.healthy.before.policy);
  const withinRunBeforeEqual = ['base', 'repaired'].every((name) => JSON.stringify((name === 'base' ? base : repaired).healthy.before) === JSON.stringify((name === 'base' ? base : repaired).failed.before));
  console.log(JSON.stringify({
    schema: 'near-rehearsal/repair-acceptance/v1',
    ok: errors.length === 0,
    candidateIdentity: Boolean(candidateIdentity),
    frozenStateEqual,
    policyEqual,
    withinRunBeforeEqual,
    baseFailedContractDelta: base.failed.deltas.contract,
    repairedFailedContractDelta: repaired.failed.deltas.contract,
    repairedFailedProposerDelta: repaired.failed.deltas.proposer,
    errors,
  }, null, 2));
  if (errors.length) process.exitCode = 1;
}
module.exports = {verify, verifyCandidateFiles, AUTHORED_REPAIRED_SHA};
