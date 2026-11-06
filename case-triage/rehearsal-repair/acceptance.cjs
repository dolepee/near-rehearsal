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

function verify(base, repaired) {
  const errors = [];
  const fail = (m) => errors.push(m);
  for (const [name, report] of [['base', base], ['repaired', repaired]]) {
    if (report?.schema !== 'near-rehearsal/issue238-local/v1') fail(`${name} report schema`);
    if (report?.source?.commit !== '5434a59dec23ee0c49df8c8c4350c208a7e75b0b') fail(`${name} source commit`);
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
  if (repaired?.source?.wasmSha256 !== '41001450691f372c38f8841795dcd7c3a113c62fc750bfd9a7b5e280fd3ecdf5') fail('repaired artifact identity');
  if (BigInt(base?.failed?.deltas?.contract ?? '0') !== BOND) fail('base failed branch did not strand the bond');
  if (BigInt(repaired?.failed?.deltas?.contract ?? '1') !== 0n) fail('repair did not return the bond exactly once');
  if (BigInt(repaired?.failed?.deltas?.proposer ?? '0') >= 0n) fail('repaired proposer did not pay gas');
  if (BigInt(repaired?.failed?.deltas?.proposer ?? '0') < -GAS_ONLY_MAX) fail('repaired proposer lost bond-scale funds');
  if (BigInt(base?.failed?.deltas?.proposer ?? '0') > -BOND) fail('base proposer did not demonstrate stranded bond');
  return errors;
}

if (require.main === module) {
  const here = __dirname;
  const base = JSON.parse(fs.readFileSync(path.join(here, 'out/issue238-local.json'), 'utf8'));
  const repaired = JSON.parse(fs.readFileSync(path.join(here, 'out/issue238-repaired.json'), 'utf8'));
  const errors = verify(base, repaired);
  const frozenStateEqual = JSON.stringify(base.healthy.before.state) === JSON.stringify(repaired.healthy.before.state);
  const policyEqual = JSON.stringify(base.healthy.before.policy) === JSON.stringify(repaired.healthy.before.policy);
  const withinRunBeforeEqual = ['base', 'repaired'].every((name) => JSON.stringify((name === 'base' ? base : repaired).healthy.before) === JSON.stringify((name === 'base' ? base : repaired).failed.before));
  console.log(JSON.stringify({
    schema: 'near-rehearsal/repair-acceptance/v1',
    ok: errors.length === 0,
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
module.exports = {verify};
