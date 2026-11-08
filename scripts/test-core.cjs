'use strict';
// Offline checks: no Sandbox process, provider call, credentials or token funding.
const path = require('node:path');
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const results = path.join(root, '.local', 'test-results');
fs.mkdirSync(results, {recursive: true});
const suites = [
  'case-triage/sputnik-public-capture/test-classification.cjs',
  'scripts/test-operation-classification.cjs',
  'scripts/test-refund-guards.cjs',
  'scripts/test-export-guards.cjs',
  'scripts/test-amount-regression.cjs',
  'scripts/test-ui-polling.cjs',
  'ui/sputnik/test-upload-selection.cjs',
  'scripts/test-release-review-guards.cjs',
  'scripts/test-repair-review.cjs',
  'case-triage/sputnik-public-capture/negative-verifier-tests.cjs',
  'case-triage/sputnik-public-capture/negative-local-verifier-tests.cjs',
  'scripts/verify-report.cjs',
  'scripts/verify-public-report.cjs',
  'scripts/verify-oracle.cjs',
  'scripts/verify-refund-report.cjs',
  'ui/sputnik/test-repair-history.cjs',
  'ui/sputnik/test-repair-ui.cjs',
  'ui/sputnik/test-review-job.cjs',
  'ui/sputnik/test-review-ui.cjs',
  'scripts/test-setup.cjs',
];
for (const suite of suites) {
  console.log(`\n> ${suite}`);
  const run = spawnSync(process.execPath, [path.join(root, suite)], {
    cwd: root, stdio: 'inherit', timeout: 120_000,
    env: {...process.env, REHEARSAL_TEST_RESULTS_DIR: results},
  });
  if (run.error || run.status !== 0) {
    console.error(`FAILED: ${suite}${run.error ? ` (${run.error.message})` : ''}`);
    process.exit(run.status || 1);
  }
}
console.log(`\n${suites.length} offline suites passed. Live model and Sandbox execution were not run.`);
