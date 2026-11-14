'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseArgs, classify, classifyPipelineResult, policyIdentity, renderReport, checkSource, checksFrom, runReview,
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

assert.equal(classifyPipelineResult({pipeline: {ok: true}}).kind, 'accepted');
assert.equal(classifyPipelineResult({pipeline: {ok: false, acceptanceErrors: ['economic check failed']}}).kind, 'rejected');
assert.equal(classifyPipelineResult({buildLogText: 'exit=101\n', replayReportExists: false}).kind, 'buildError');
assert.equal(classifyPipelineResult({replayReportExists: false}).kind, 'inconclusive');
assert.equal(classifyPipelineResult({replayReportExists: true}).kind, 'inconclusive');
console.log('accepted: only a completed pipeline verdict rejects a candidate; replay.log alone stays inconclusive');

const policy = policyIdentity(path.join(root, 'case-triage', 'rehearsal-repair', 'out', 'issue238-local.json'));
assert.match(policy.policySha256, /^[0-9a-f]{64}$/);
assert.equal(policy.caseId, 'sputnik-238-async-bond');
assert.equal(policy.sourceCommit, '5434a59dec23ee0c49df8c8c4350c208a7e75b0b');
assert.equal(policy.allowedPaths.length, 1);
assert.match(policy.files.acceptance, /^[0-9a-f]{64}$/);
assert.match(policy.files.persistedAcceptance, /^[0-9a-f]{64}$/);
assert.match(policy.files.mixedObligation, /^[0-9a-f]{64}$/);
assert.match(policy.files.mixedPolicy, /^[0-9a-f]{64}$/);
console.log('accepted: checker policy identities are pinned outside the candidate');

const review = {
  schema: 'near-rehearsal/review-patch/v1',
  status: 'ACCEPTED',
  supplied: {repo: 'caller/repo', base: 'base-label', head: 'head-label', patchFilename: 'candidate.diff'},
  verified: {
    sourceCommit: '5434a59dec23ee0c49df8c8c4350c208a7e75b0b',
    sourceCommitPinned: '5434a59dec23ee0c49df8c8c4350c208a7e75b0b',
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
assert.match(rendered, /## Reproduce/);
assert.doesNotMatch(rendered, /\/Users\/|\/workspace\//);
console.log('accepted: report language is bounded and caller labels are not presented as provenance');

const malformed = checksFrom(
  {ok: true, changedPaths: ['sputnikdao2/src/proposals.rs'], hashes: {wasm: 'c'.repeat(64)}, acceptanceErrors: []},
  {failed: {proposal: {status: 'Failed'}}, firstRecovery: {grossRecoveryYocto: 'not-a-number'}, secondRetry: {grossRecoveryYocto: '0'}},
  {ok: true, errors: []},
);
assert.equal(malformed.find((check) => check.id === 'bond-recovered-once').status, 'fail');
assert.doesNotThrow(() => renderReport({...review, checks: malformed}));
console.log('accepted: malformed recovery fields fail closed rather than throwing');

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

const pinnedSource = '5434a59dec23ee0c49df8c8c4350c208a7e75b0b';
const mixedFixture = path.join(root, 'case-triage', 'rehearsal-repair', 'out', 'mixed-obligation-intended.json');
const mixedFailureFixture = path.join(root, 'case-triage', 'rehearsal-repair', 'out', 'mixed-obligation-clear-all.json');
const settlementFixture = path.join(root, 'case-triage', 'rehearsal-repair', 'out', 'audit-intended', 'settlement', 'settlement-refund.json');
const persistedFixture = path.join(root, 'case-triage', 'rehearsal-repair', 'out', 'audit-intended', 'persisted', 'persisted-recovery.json');
const baseReport = path.join(root, 'case-triage', 'rehearsal-repair', 'out', 'issue238-local.json');
const candidateHash = JSON.parse(fs.readFileSync(settlementFixture, 'utf8')).candidate.wasmSha256;

function controlledReview({pipelineOk = true, persistedMode = 'report', acceptanceMode = 'ok', mixedMode = 'ok', settlementMode = 'ok'} = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'review-patch-run-'));
  const patch = path.join(scratch, 'candidate.diff');
  const source = path.join(scratch, 'source');
  const sandbox = path.join(scratch, 'sandbox');
  const out = path.join(scratch, 'out');
  fs.writeFileSync(patch, 'diff --git a/sputnikdao2/src/proposals.rs b/sputnikdao2/src/proposals.rs\n');
  fs.mkdirSync(source);
  fs.mkdirSync(sandbox);
  fs.writeFileSync(path.join(sandbox, 'near-sandbox'), '');
  const result = (status, stdout = '', stderr = '') => ({status, stdout, stderr, signal: null});
  const runner = (args) => {
    const name = path.basename(args[0]);
    const outArg = args[args.indexOf('--out') + 1];
    if (name === 'repair-pipeline.cjs') {
      fs.mkdirSync(outArg, {recursive: true});
      const applied = path.join(outArg, 'applied');
      fs.mkdirSync(path.join(applied, 'target', 'wasm32-unknown-unknown', 'release'), {recursive: true});
      fs.mkdirSync(path.join(applied, 'sputnikdao2', 'src'), {recursive: true});
      fs.writeFileSync(path.join(applied, 'target', 'wasm32-unknown-unknown', 'release', 'sputnikdao2.wasm'), 'wasm');
      fs.writeFileSync(path.join(applied, 'sputnikdao2', 'src', 'proposals.rs'), 'source');
      fs.writeFileSync(path.join(outArg, 'candidate-identity.json'), '{}');
      fs.writeFileSync(path.join(outArg, 'pipeline.json'), JSON.stringify({
        ok: pipelineOk,
        changedPaths: ['sputnikdao2/src/proposals.rs'],
        acceptanceErrors: pipelineOk ? [] : ['economic check failed'],
        hashes: {wasm: candidateHash, appliedSource: 'b'.repeat(64)},
      }));
      return result(0);
    }
    if (name === 'persisted-recovery.cjs') {
      if (persistedMode === 'missing') return result(1, '', 'persisted report missing');
      fs.mkdirSync(outArg, {recursive: true});
      fs.copyFileSync(persistedFixture, path.join(outArg, 'persisted-recovery.json'));
      return result(0);
    }
    if (name === 'persisted-recovery-acceptance.cjs') {
      if (acceptanceMode === 'missing') return result(1, '', 'acceptance missing');
      if (acceptanceMode === 'unreadable') return result(0, 'not-json');
      return result(0, JSON.stringify({ok: acceptanceMode !== 'fail', errors: acceptanceMode === 'fail' ? ['recovery failed'] : []}));
    }
    if (name === 'mixed-obligation.cjs') {
      if (mixedMode === 'missing') return result(1, '', 'mixed report missing');
      fs.mkdirSync(outArg, {recursive: true});
      fs.copyFileSync(mixedMode === 'reject' ? mixedFailureFixture : mixedFixture, path.join(outArg, 'mixed-obligation.json'));
      return result(0);
    }
    if (name === 'settlement-refund-tests.cjs') {
      if (settlementMode === 'missing') return result(1, '', 'settlement report missing');
      fs.mkdirSync(outArg, {recursive: true});
      fs.copyFileSync(settlementFixture, path.join(outArg, 'settlement-refund.json'));
      return result(0);
    }
    throw new Error(`unexpected child ${name}`);
  };
  try {
    return runReview({
      patch, source, out, baseReport, sandboxDir: sandbox,
      runNode: runner,
      checkSource: () => pinnedSource,
    });
  } finally {
    fs.rmSync(scratch, {recursive: true, force: true});
  }
}

const freshFailure = controlledReview({pipelineOk: false, settlementMode: 'missing'});
assert.equal(freshFailure.status, 'REJECTED', 'a verified fresh failure survives a missing settlement report');
assert.ok(freshFailure.acceptancePolicy, 'terminal policy must be recorded');
assert.equal(freshFailure.acceptancePolicy.status, 'REJECTED');
assert.equal(freshFailure.checks.find((check) => check.id === 'fresh-replay')?.status, 'fail');

const missingSettlement = controlledReview({settlementMode: 'missing'});
assert.equal(missingSettlement.status, 'INCONCLUSIVE', 'missing settlement after all prior passes stays inconclusive');
assert.ok(missingSettlement.acceptancePolicy, 'missing settlement still carries the shared policy verdict');
assert.equal(missingSettlement.acceptancePolicy.status, 'INCONCLUSIVE');

const freshFailureNoAcceptance = controlledReview({pipelineOk: false, persistedMode: 'missing'});
assert.equal(freshFailureNoAcceptance.status, 'REJECTED', 'a missing persisted acceptance cannot erase a verified fresh failure');
assert.ok(freshFailureNoAcceptance.acceptancePolicy);
assert.equal(freshFailureNoAcceptance.acceptancePolicy.status, 'REJECTED');
assert.equal(freshFailureNoAcceptance.checks.find((check) => check.id === 'fresh-replay')?.status, 'fail');

const freshFailureUnreadableAcceptance = controlledReview({pipelineOk: false, acceptanceMode: 'unreadable'});
assert.equal(freshFailureUnreadableAcceptance.status, 'REJECTED', 'an unreadable acceptance cannot erase a verified fresh failure');
assert.ok(freshFailureUnreadableAcceptance.acceptancePolicy);

const recoveryFailure = controlledReview({acceptanceMode: 'fail'});
assert.equal(recoveryFailure.status, 'REJECTED', 'a known recovery failure remains rejected');
assert.ok(recoveryFailure.acceptancePolicy);
assert.equal(recoveryFailure.acceptancePolicy.status, 'REJECTED');

const mixedFailure = controlledReview({mixedMode: 'reject', settlementMode: 'missing'});
assert.equal(mixedFailure.status, 'REJECTED', 'a known mixed failure remains rejected even without settlement');
assert.ok(mixedFailure.acceptancePolicy);
assert.equal(mixedFailure.acceptancePolicy.status, 'REJECTED');

console.log('accepted: runReview routes missing reports through the shared policy without erasing verified failures');

console.log(JSON.stringify({
  schema: 'near-rehearsal/review-patch-tests/v1',
  tests: [
    'argument parsing', 'required input failures', 'input error', 'build error',
    'inconclusive', 'rejected', 'accepted', 'policy identity', 'bounded report language',
    'rejected language', 'no checked-in absolute paths', 'source checkout failure',
    'malformed recovery fields', 'pipeline verdict classification', 'runReview shared-policy gaps',
  ],
  passed: true,
}, null, 2));
