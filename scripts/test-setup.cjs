'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {checkSetup, parseArgs, providerPrefix} = require('./check-setup.cjs');
assert.throws(() => parseArgs(['--flow', 'other']), /manual or repair/);
assert.throws(() => parseArgs(['--flow', 'manual', '--generate']), /requires/);
for (const flags of [['--permission-profile', 'local'], ['--permission-profile=local'], ['-P', 'local'], ['--permission-profile', '{profile}']]) {
  assert.doesNotThrow(() => providerPrefix(JSON.stringify(['codex', ...flags, '{workspace}']), 'local'));
}
assert.throws(() => providerPrefix(JSON.stringify(['codex', '-P', 'other', '{workspace}']), 'local'), /does not match/);
assert.throws(() => providerPrefix(JSON.stringify(['codex', '-P', 'local']), 'local'), /workspace/);
const empty = {PATH: process.env.PATH, CODEX_AUTH_SOURCE: '/nonexistent-rehearsal-test-auth'};
const report = checkSetup({flow: 'repair', generate: true}, empty, '24.22.1');
assert.equal(report.ready, false);
assert.equal(report.providerCalled, false);
assert.equal(report.checks.find((c) => c.name === 'Provider configuration').ok, false);
assert.equal(report.checks.find((c) => c.name === 'Pinned source').ok, false);
const wrongNode = checkSetup({flow: 'manual', generate: false}, empty, '22.0.0');
assert.equal(wrongNode.checks.find((c) => c.name === 'Node').ok, false);
assert.equal(wrongNode.checks.some((c) => c.name === 'Provider configuration'), false);
// A normal unsupported setup must fail before starting the server or a chain.
const launch = spawnSync(process.execPath, [path.join(__dirname, 'start-rehearsal.cjs'), '--flow', 'repair'], {env: empty, encoding: 'utf8', timeout: 15_000});
assert.equal(launch.status, 1);
assert.match(launch.stderr, /Missing:|Pinned source/);
assert.doesNotMatch(launch.stdout, /Open http/);
console.log('setup checks: missing provider/source, wrong Node, mode boundaries and fail-fast launch passed; no model call');
