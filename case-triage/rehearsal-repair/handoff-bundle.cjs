'use strict';
/*
 * One canonical reviewer bundle for the settlement-fixed candidate.
 *
 * The bundle is assembled from the tracked artifacts of the accepted
 * source-build run (candidate patch, built WASM, identity, fresh and persisted
 * reports, mixed and settlement reports) so the operator handoff and the guard
 * tests exercise the same bytes. It adds no acceptance policy of its own:
 * `repair-review` re-verifies every hash and re-runs the chain.
 */
const path = require('node:path');
const {buildReviewBundle} = require('./review-bundle.cjs');

const REPAIR = __dirname;
const REPO = path.join(REPAIR, '..', '..');

const ARTIFACTS = Object.freeze({
  patchPath: path.join(REPAIR, 'mixed-candidates', 'intended.patch'),
  wasmPath: path.join(REPAIR, 'mixed-candidates', 'intended.wasm'),
  candidateIdentityPath: path.join(REPAIR, 'mixed-candidates', 'intended-identity.json'),
  baseReportPath: path.join(REPAIR, 'out', 'issue238-local.json'),
  candidateReportPath: path.join(REPAIR, 'out', 'audit-intended', 'fresh', 'issue238-local.json'),
  recoveryPath: path.join(REPAIR, 'out', 'audit-intended', 'persisted', 'persisted-recovery.json'),
  acceptancePath: path.join(REPAIR, 'out', 'audit-intended', 'persisted', 'persisted-recovery-acceptance.json'),
  mixedPath: path.join(REPAIR, 'out', 'mixed-obligation-intended.json'),
  settlementPath: path.join(REPAIR, 'out', 'audit-intended', 'settlement', 'settlement-refund.json'),
});

const RUN_ID = 'settlement-fixed-handoff-2026-11-13';
const CREATED_AT = '2026-11-13T21:15:09.000Z';

// Paths are resolved against the repository so the bundle is reproducible from
// a clean checkout and CI can build it into a temporary directory.
function buildHandoffBundle(overrides = {}) {
  const paths = {...ARTIFACTS, ...overrides};
  const resolved = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.isAbsolute(value) ? value : path.join(REPO, value)]));
  return buildReviewBundle({
    ...resolved,
    runId: overrides.runId || RUN_ID,
    createdAt: overrides.createdAt || CREATED_AT,
  });
}

module.exports = {buildHandoffBundle, ARTIFACTS, RUN_ID, CREATED_AT};

if (require.main === module) {
  const fs = require('node:fs');
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node case-triage/rehearsal-repair/handoff-bundle.cjs <out.json>');
    process.exitCode = 1;
  } else {
    fs.writeFileSync(out, `${JSON.stringify(buildHandoffBundle(), null, 2)}\n`);
    console.log(out);
  }
}
