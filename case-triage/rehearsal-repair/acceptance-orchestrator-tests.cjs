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
assert.equal(all.status, 'ACCEPTED');
assert.equal(all.policyVersion, POLICY_VERSION);

const withoutMixed = evaluateCandidate({
  fresh: stageFromChecks(true),
  recovery: stageFromChecks(true),
});
assert.equal(withoutMixed.ok, false);
assert.equal(withoutMixed.status, 'INCONCLUSIVE');
assert.ok(withoutMixed.errors.some((error) => /mixed acceptance/.test(error)));

const withoutSettlement = evaluateCandidate({
  fresh: stageFromChecks(true),
  recovery: stageFromChecks(true),
  mixed: stageFromChecks(true, [], {policyVersion: POLICY_VERSION}),
});
assert.equal(withoutSettlement.ok, false);
assert.equal(withoutSettlement.status, 'INCONCLUSIVE');
assert.ok(withoutSettlement.errors.some((error) => /settlement acceptance/.test(error)));

const stalePolicy = evaluateCandidate({
  fresh: stageFromChecks(true),
  recovery: stageFromChecks(true),
  mixed: stageFromChecks(true, [], {policyVersion: 'near-rehearsal/acceptance-policy/v1'}),
  settlement: stageFromChecks(true),
});
assert.equal(stalePolicy.ok, false);
assert.equal(stalePolicy.status, 'REJECTED');
assert.ok(stalePolicy.errors.some((error) => /does not match/.test(error)));

const mixedFailure = evaluateCandidate({
  fresh: stageFromChecks(true),
  recovery: stageFromChecks(true),
  mixed: stageFromChecks(false, ['unrelated obligation changed'], {evidenceValid: true}),
  settlement: stageFromChecks(true),
});
assert.equal(mixedFailure.ok, false);
assert.equal(mixedFailure.status, 'REJECTED');
assert.ok(mixedFailure.errors.some((error) => /unrelated obligation changed/.test(error)));

const missingSettlement = evaluateCandidate({
  fresh: stageFromChecks(true),
  recovery: stageFromChecks(true),
  mixed: stageFromChecks(true),
  settlement: stageFromChecks(false, ['settlement report missing']),
});
assert.equal(missingSettlement.status, 'INCONCLUSIVE', 'missing execution is not a semantic rejection');

const unprovenGuard = evaluateCandidate({
  fresh: stageFromChecks(true),
  recovery: stageFromChecks(true),
  mixed: stageFromChecks(true),
  settlement: stageFromChecks(false, ['in-flight retry guard was not exercised'], {evidenceValid: false}),
});
assert.equal(unprovenGuard.status, 'INCONCLUSIVE', 'an unexercised guard is unproven, not a semantic rejection');

console.log('acceptance-orchestrator: mixed and settlement gates are mandatory and policy versions cannot drift');
