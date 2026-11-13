'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseArgs, classify, policyIdentity, renderReport, checkSource,
} = require('./review-patch.cjs');

const here = __dirname;
const root = path.resolve(here, '..');

function parseOk(argv) {
  return parseArgs(argv);
}

assert.throws(() => parseOk(['--patch', 'x']), /--source is required/);
assert.throws(() => parseOk(['--patch', 'x', '--source', 'y']), /--out is required/);
assert.throws(() => parseOk(['--unknown']), /unknown argument/);
const parsed = parseOk(['--patch', 'x.diff', '--source', 'source', '--out', 'out', '--repo', 'r', '--base', 'b', '--head', 'h']);
assert.equal(parsed.repo, 'r');
assert.equal(parsed.base, 'b');
assert.equal(parsed.head, 'h');
assert.equal(parsed.patch, 'x.diff');
console.log('accepted: argument parsing and required input failures');

assert.deepEqual(classify('input', {inputError: 'bad patch'}), {status: 'INPUT_ERROR', reason: 'bad patch'});
assert.deepEqual(classify('build', {buildError: 'no compile'}), {status: 'BUILD_ERROR', reason: 'no compile'});
assert.equal(classify('runtime', {inconclusive: 'sandbox missing'}).status, 'INCONCLUSIVE');
assert.equal(classify('persisted', {rejected: 'bond remained'}).status, 'REJECTED');
assert.equal(classify('all', {accepted: true}).status, 'ACCEPTED');
assert.equal(classify('nothing', {}).status, 'INCONCLUSIVE');
console.log('accepted: status classification separates input, build, rejection and infrastructure');

const policy = policyIdentity(path.join(root, 'case-triage', 'rehearsal-repair', 'out', 'issue238-local.json'));
assert.match(policy.policySha256, /^[0-9a-f]{64}$/);
assert.equal(policy.caseId, 'sputnik-238-async-bond');
assert.equal(policy.sourceCommit, '5434a59dec23ee0c49df8c8c4350c208a7e75b0b');
assert.equal(policy.allowedPaths.length, 1);
assert.match(policy.files.acceptance, /^[0-9a-f]{64}$/);
assert.match(policy.files.persistedAcceptance, /^[0-9a-f]{64}$/);
console.log('accepted: checker policy identities are pinned outside the candidate');

const review = {
  schema: 'near-rehearsal/review-patch/v1',
  status: 'ACCEPTED',
  supplied: {repo: 'caller/repo', base: 'base-label', head: 'head-label', patchFilename: 'candidate.diff'},
  verified: {
    sourceCommit: '5434a59dec23ee0c49df8c8c4350c208a7e75b0b',
    patchSha256: 'a'.repeat(64),
    appliedSourceSha256: 'b'.repeat(64),
    builtWasmSha256: 'c'.repeat(64),
  },
  policy,
  checks: [
    {id: 'patch.allowlist', status: 'pass', detail: 'sputnikdao2/src/proposals.rs'},
    {id: 'persisted-acceptance', status: 'pass', detail: 'accepted'},
  ],
  evidence: {status: 'review-status.json', report: 'review-report.md', dir: 'evidence/'},
  limitations: ['Local only.'],
};
const rendered = renderReport(review);
assert.match(rendered, /ACCEPTED means the defined checks/);
assert.match(rendered, /does not mean the patch is universally safe/);
assert.match(rendered, /caller metadata/);
assert.match(rendered, /not verified provenance/);
assert.doesNotMatch(rendered, /\/Users\/|\/workspace\//);
console.log('accepted: report language is bounded and caller labels are not presented as provenance');

const rejected = renderReport({...review, status: 'REJECTED', checks: [{id: 'bond-recovered-once', status: 'fail', detail: 'bond remained'}]});
assert.match(rejected, /valid executable candidate failed/);
assert.match(rejected, /not a judgment that the patch is malicious/);
console.log('accepted: rejected language does not overclaim');

const build = renderReport({...review, status: 'BUILD_ERROR'});
assert.match(build, /did not compile/);
assert.match(build, /No economic recovery result was produced/);
console.log('accepted: compilation failure is not reported as an economic failure');

assert.throws(() => checkSource(path.join(root, 'does-not-exist'), '0'.repeat(40)), /not found/);
console.log('accepted: source checkout failures are explicit');

console.log(JSON.stringify({
  schema: 'near-rehearsal/review-patch-tests/v1',
  tests: [
    'argument parsing', 'required input failures', 'input error', 'build error',
    'inconclusive', 'rejected', 'accepted', 'policy identity', 'bounded report language',
    'rejected language', 'no checked-in absolute paths', 'source checkout failure',
  ],
  passed: true,
}, null, 2));
