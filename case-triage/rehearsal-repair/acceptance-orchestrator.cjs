'use strict';
/*
 * One controller-owned acceptance policy for every candidate route.
 *
 * Routes may gather different evidence (fresh replay, persisted recovery,
 * source patch or recorded-WASM replay), but they must not invent their own
 * terminal predicate. The version below is exported with every verdict, and
 * the same-DAO mixed-obligation and failed-refund settlement gates are mandatory for all of them.
 */
const POLICY_VERSION = 'near-rehearsal/acceptance-policy/v3';
const REQUIRED_STAGES = Object.freeze(['fresh', 'recovery', 'mixed', 'settlement']);

function normalizeStage(stage) {
  if (!stage) return {ok: false, errors: ['stage evidence is missing']};
  return {
    ok: stage.ok === true,
    errors: Array.isArray(stage.errors) ? stage.errors.slice() : [],
    status: stage.status || null,
    sha256: stage.sha256 || null,
  };
}

function evaluateCandidate(stages = {}) {
  const errors = [];
  const normalized = {};
  for (const name of REQUIRED_STAGES) {
    normalized[name] = normalizeStage(stages[name]);
    if (!normalized[name].ok) {
      const detail = normalized[name].errors.length ? `: ${normalized[name].errors.join('; ')}` : '';
      errors.push(`${name} acceptance did not pass${detail}`);
    }
  }
  if (stages.mixed && stages.mixed.policyVersion && stages.mixed.policyVersion !== POLICY_VERSION) {
    errors.push(`mixed gate policy ${stages.mixed.policyVersion} does not match ${POLICY_VERSION}`);
  }
  return {
    schema: 'near-rehearsal/acceptance/v2',
    policyVersion: POLICY_VERSION,
    requiredStages: REQUIRED_STAGES.slice(),
    ok: errors.length === 0,
    errors,
    stages: normalized,
  };
}

function stageFromChecks(ok, errors = [], extra = {}) {
  return {ok: ok === true, errors: Array.isArray(errors) ? errors : [], ...extra};
}

module.exports = {POLICY_VERSION, REQUIRED_STAGES, evaluateCandidate, stageFromChecks};
