'use strict';
const assert = require('node:assert/strict');
const {POLICY_VERSION, evaluateCandidate, stageFromChecks} = require('./acceptance-orchestrator.cjs');

const all = evaluateCandidate({
  fresh: stageFromChecks(true),
  recovery: stageFromChecks(true),
  mixed: stageFromChecks(true, [], {policyVersion: POLICY_VERSION}),
  settlement: stageFromChecks(true),
});
assert.equal(all.ok, true);
assert.equal(all.policyVersion, POLICY_VERSION);

const withoutMixed = evaluateCandidate({
  fresh: stageFromChecks(true),
  recovery: stageFromChecks(true),
});
assert.equal(withoutMixed.ok, false);
assert.ok(withoutMixed.errors.some((error) => /mixed acceptance/.test(error)));

const withoutSettlement = evaluateCandidate({
  fresh: stageFromChecks(true),
  recovery: stageFromChecks(true),
  mixed: stageFromChecks(true, [], {policyVersion: POLICY_VERSION}),
});
assert.equal(withoutSettlement.ok, false);
assert.ok(withoutSettlement.errors.some((error) => /settlement acceptance/.test(error)));

const stalePolicy = evaluateCandidate({
  fresh: stageFromChecks(true),
  recovery: stageFromChecks(true),
  mixed: stageFromChecks(true, [], {policyVersion: 'near-rehearsal/acceptance-policy/v1'}),
  settlement: stageFromChecks(true),
});
assert.equal(stalePolicy.ok, false);
assert.ok(stalePolicy.errors.some((error) => /does not match/.test(error)));

const mixedFailure = evaluateCandidate({
  fresh: stageFromChecks(true),
  recovery: stageFromChecks(true),
  mixed: stageFromChecks(false, ['unrelated obligation changed']),
  settlement: stageFromChecks(true),
});
assert.equal(mixedFailure.ok, false);
assert.ok(mixedFailure.errors.some((error) => /unrelated obligation changed/.test(error)));

console.log('acceptance-orchestrator: mixed and settlement gates are mandatory and policy versions cannot drift');
