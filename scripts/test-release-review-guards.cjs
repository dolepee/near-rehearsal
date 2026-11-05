'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const scripts = ['build-release-review.cjs'];
const files = ['public-report.json', 'public-regression.json', 'public-capture.json'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-review-current-'));
fs.mkdirSync(path.join(tmp, 'scripts'), {recursive: true});
fs.mkdirSync(path.join(tmp, 'out'), {recursive: true});
for (const file of scripts) fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(tmp, 'scripts', file));
for (const file of files) fs.copyFileSync(path.join(ROOT, 'out', file), path.join(tmp, 'out', file));
fs.cpSync(path.join(ROOT, 'contracts'), path.join(tmp, 'contracts'), {recursive: true});
const run = () => spawnSync(process.execPath, ['scripts/build-release-review.cjs'], {cwd: tmp, encoding: 'utf8'});
const good = run();
assert.equal(good.status, 0, good.stderr || good.stdout);
const regressionPath = path.join(tmp, 'out', 'public-regression.json');
const regression = JSON.parse(fs.readFileSync(regressionPath, 'utf8'));
regression.runtime.version = '9.9.9';
fs.writeFileSync(regressionPath, JSON.stringify(regression, null, 2) + '\n');
const stale = run();
assert.notEqual(stale.status, 0, 'stale runtime declaration must not produce a passing packet');
assert.match(stale.stderr, /evidence does not match current files/);
console.log(JSON.stringify({
  schema: 'near-rehearsal/release-review-guards/v1',
  acceptedCurrentEvidence: true,
  rejectedStaleRuntime: true,
}, null, 2));
