'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verifyMixedReport} = require('./mixed-policy.cjs');
const {checksFrom} = require('../../scripts/review-patch.cjs');
const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'out', name), 'utf8'));
const pipeline = {ok: true, changedPaths: ['sputnikdao2/src/proposals.rs'], hashes: {wasm: 'a'.repeat(64)}, acceptanceErrors: []};
const report = {failed: {proposal: {status: 'Failed'}}, firstRecovery: {grossRecoveryYocto: '1000000000000000000000000'}, secondRetry: {grossRecoveryYocto: '0'}, healthyPreservation: {checks: {settledApproved: true, pendingPayout: true, pendingNoSecondPayout: true}}, preservation: {state: true, policy: true, proposal: true}, authority: {unauthorizedUpdateRejected: true, unauthorizedFinalizeRejected: true}};
const acceptance = {ok: true, errors: []};
for (const name of ['mixed-obligation-old.json', 'mixed-obligation-future-only.json', 'mixed-obligation-clear-all.json']) {
  const checked = verifyMixedReport(read(name));
  assert.equal(checked.ok, false, `${name} must not pass the same-DAO policy`);
  const checks = checksFrom(pipeline, report, acceptance, checked);
  assert.equal(checks.find((check) => check.id === 'same-dao-mixed').status, 'fail', `${name} must fail the primary policy check`);
}
const intended = verifyMixedReport(read('mixed-obligation-intended.json'), {requireBlockPinned: true});
assert.equal(intended.ok, true);
assert.equal(checksFrom(pipeline, report, acceptance, intended).find((check) => check.id === 'same-dao-mixed').status, 'pass');
console.log('primary-mixed-regression: primary checks reject the compiled clear-all candidate and accept the intended candidate');
