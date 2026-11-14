'use strict';
/*
 * The reviewer CLI's verdict file is the only thing the browser manager is
 * allowed to classify a finished run by. This test drives the CLI's real
 * classifier (`classifyAndPublish`) with the committed, hash-checked evidence
 * and then hands the exact bytes and exit code it produced to the real
 * manager, so the two halves cannot drift apart:
 *
 *   - a measured policy failure is a typed REJECTED file with exit 2;
 *   - missing execution evidence is INCONCLUSIVE with exit 5, never REJECTED;
 *   - a producer/reviewer disagreement on the shared policy is a rejection,
 *     not a crash before the file is written.
 *
 * What this cannot prove is that a live Sandbox run produces those reports;
 * the CI Source-build repair handoff job replays the real CLI for that.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

const root = path.resolve(__dirname, '..', '..');
const {buildHandoffBundle} = require(path.join(root, 'case-triage', 'rehearsal-repair', 'handoff-bundle.cjs'));
const {classifyAndPublish, publishStageRejection, summarize} = require(path.join(root, 'scripts', 'repair-review.cjs'));
const {verifyMixedReport} = require(path.join(root, 'case-triage', 'rehearsal-repair', 'mixed-policy.cjs'));
const {verifySettlementReport} = require(path.join(root, 'case-triage', 'rehearsal-repair', 'settlement-policy.cjs'));
const {mixedPolicyIdentity} = require(path.join(root, 'case-triage', 'rehearsal-repair', 'mixed-policy-identity.cjs'));
const {createManager} = require('./review-job.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'near-review-cli-'));
const bundle = buildHandoffBundle();
const bundlePath = path.join(tmp, 'bundle.json');
fs.writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
const wasmSha256 = bundle.candidate.wasm.sha256;
const persistedReport = JSON.parse(bundle.recovery.reportText);
const mixedReport = JSON.parse(bundle.mixed.reportText);
const settlementReport = JSON.parse(bundle.settlement.reportText);
const sandboxDir = path.join(tmp, 'sandbox');
fs.mkdirSync(sandboxDir, {recursive: true});
fs.writeFileSync(path.join(sandboxDir, 'near-sandbox'), '');

const run = {
  mode: 'recorded-wasm',
  modeLabel: 'recorded WASM replay (supplied artifact; no source build)',
  wasmSha256,
  builtWasmSha256: null,
  acceptance: bundle.recovery.acceptance,
  reportPath: path.join(tmp, 'persisted-recovery.json'),
  acceptancePath: path.join(tmp, 'persisted-recovery-acceptance.json'),
  replayDir: path.join(tmp, 'replay'),
};

const withProducerMixed = (label, producer) => {
  const copy = JSON.parse(JSON.stringify(bundle));
  const reportText = JSON.stringify(producer);
  copy.mixed.reportText = reportText;
  copy.mixed.reportSha256 = require('node:crypto').createHash('sha256').update(Buffer.from(reportText, 'utf8')).digest('hex');
  const file = path.join(tmp, `${label}-bundle.json`);
  fs.writeFileSync(file, `${JSON.stringify(copy, null, 2)}\n`);
  return {bundle: copy, bundlePath: file};
};

const publish = (label, {
  producerMixed = mixedReport,
  bundleOverride = null,
  settlement = {checked: verifySettlementReport(settlementReport, {candidateWasmSha256: wasmSha256}), unavailable: null},
} = {}) => {
  const outDir = path.join(tmp, label);
  fs.mkdirSync(outDir, {recursive: true});
  const activeBundle = bundleOverride ? bundleOverride.bundle : bundle;
  const activeBundlePath = bundleOverride ? bundleOverride.bundlePath : bundlePath;
  const summary = summarize(persistedReport, run);
  const mixedRun = {
    report: producerMixed,
    reportPath: path.join(tmp, `${label}-mixed.json`),
    checked: verifyMixedReport(producerMixed, {requireBlockPinned: true}),
    policy: mixedPolicyIdentity(root),
  };
  fs.writeFileSync(mixedRun.reportPath, JSON.stringify(producerMixed));
  const settlementRun = {
    report: settlement.checked ? settlementReport : null,
    reportPath: settlement.checked ? path.join(tmp, `${label}-settlement.json`) : path.join(tmp, `${label}-missing-settlement.json`),
    checked: settlement.checked,
    unavailable: settlement.unavailable,
  };
  if (settlement.checked) fs.writeFileSync(settlementRun.reportPath, JSON.stringify(settlementReport));
  const {exitCode, result} = classifyAndPublish({bundle: activeBundle, bundlePath: activeBundlePath, run, outDir, report: persistedReport, summary, mixedRun, settlementRun});
  const written = JSON.parse(fs.readFileSync(path.join(outDir, 'review-result.json'), 'utf8'));
  assert.deepEqual(written.acceptancePolicy, result.acceptancePolicy, `${label}: the file carries the classifier's verdict`);
  return {exitCode, result: written, outDir, bundle: activeBundle};
};

(async () => {
  try {
    // 1. The committed accepted evidence is accepted, with the writer's own exit code.
    const accepted = publish('accepted');
    assert.equal(accepted.exitCode, 0);
    assert.equal(accepted.result.status, 'ACCEPTED');
    assert.equal(accepted.result.accepted, true);
    assert.equal(accepted.result.bundle.sha256, require('node:crypto').createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex'));

    // 2. A producer/reviewer disagreement on the shared same-DAO policy is an
    //    executed rejection. It used to throw before review-result.json existed.
    const crossed = JSON.parse(JSON.stringify(mixedReport));
    const producerOutcomes = verifyMixedReport(mixedReport, {requireBlockPinned: true}).outcomes;
    crossed.outcomes = {...producerOutcomes, bobPaidExactlyOnce: !producerOutcomes.bobPaidExactlyOnce};
    assert.equal(verifyMixedReport(crossed, {requireBlockPinned: true}).ok, true, 'the crossed producer report still satisfies the shared policy itself');
    const crossedBundle = withProducerMixed('disagreement', crossed);
    const disagreement = publish('disagreement', {producerMixed: crossed, bundleOverride: crossedBundle});
    assert.equal(disagreement.exitCode, 2, 'an executed rejection exits 2');
    assert.equal(disagreement.result.status, 'REJECTED');
    assert.equal(disagreement.result.accepted, false);
    assert.match(disagreement.result.acceptancePolicy.errors.join(' '), /producer\/reviewer mixed outcomes differ: bobPaidExactlyOnce/);

    // 3. A measured financial failure in the settlement policy is a rejection too.
    const bond = 10n ** 24n;
    const shortRefund = JSON.parse(JSON.stringify(settlementReport));
    shortRefund.unequal.after.proposer = (BigInt(shortRefund.unequal.before.proposer) + bond / 2n).toString();
    shortRefund.unequal.aliceDelta = (bond / 2n).toString();
    const financial = publish('financial', {settlement: {checked: verifySettlementReport(shortRefund, {candidateWasmSha256: wasmSha256}), unavailable: null}});
    assert.equal(financial.exitCode, 2);
    assert.equal(financial.result.status, 'REJECTED');
    assert.match(financial.result.acceptancePolicy.errors.join(' '), /unequal Alice refund is not exactly one original bond/);

    // 4. Missing execution evidence is inconclusive and must never be called rejected.
    const missing = publish('missing', {settlement: {checked: null, unavailable: {message: 'settlement child exited 1 without a report'}}});
    assert.equal(missing.exitCode, 5, 'missing evidence exits 5');
    assert.equal(missing.result.status, 'INCONCLUSIVE');
    assert.equal(missing.result.accepted, false);
    assert.equal(missing.result.acceptancePolicy.stages.settlement.evidenceValid, false, 'missing settlement evidence is not evidence of a rejection');
    assert.equal(missing.result.acceptancePolicy.stages.settlement.ok, false);

    // 5. A stage that executed and reported failure is a rejection, not a crash,
    //    and the stages behind it were never reached.
    for (const [label, rejectedStage, errors] of [
      ['acceptance-stage', 'acceptance', ['persisted recovery acceptance failed: candidate WASM SHA-256 does not match report']],
      ['pipeline-stage', 'fresh-pipeline', ['source-build pipeline did not pass']],
    ]) {
      const outDir = path.join(tmp, label);
      fs.mkdirSync(outDir, {recursive: true});
      const stageRun = {...run, rejectedStage, rejectionErrors: errors};
      const published = publishStageRejection({bundle, bundlePath, run: stageRun, outDir});
      assert.equal(published.exitCode, 2, `${label}: withholds exit 2`);
      const written = JSON.parse(fs.readFileSync(path.join(outDir, 'review-result.json'), 'utf8'));
      assert.equal(written.status, 'REJECTED');
      assert.equal(written.run.rejectedStage, rejectedStage);
      assert.equal(written.acceptancePolicy.stages.fresh.evidenceValid, true, `${label}: the executed stage is verified evidence`);
      assert.equal(written.acceptancePolicy.stages.mixed.evidenceValid, false, `${label}: an unexecuted stage must not look executed`);
      assert.equal(written.acceptancePolicy.stages.mixed.ok, false);
      assert.equal(written.summary.checks.accepted, false);
    }

    // 6. The manager classifies the CLI's own file and exit code, not a guess.
    for (const [label, expected] of [['disagreement', 'rejected'], ['financial', 'rejected'], ['missing', 'inconclusive']]) {
      const source = label === 'disagreement' ? disagreement : label === 'financial' ? financial : missing;
      const manager = createManager({
        runsRoot: path.join(tmp, `manager-${label}`),
        env: {REPAIR_SANDBOX_DIR: sandboxDir},
        spawn: (command, args) => {
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => {};
          child.pid = undefined;
          setTimeout(() => {
            const out = args[args.indexOf('--out') + 1];
            fs.mkdirSync(out, {recursive: true});
            fs.copyFileSync(path.join(source.outDir, 'review-result.json'), path.join(out, 'review-result.json'));
            child.emit('close', source.exitCode, null);
          }, 5);
          return child;
        },
      });
      const started = manager.start(source.bundle || bundle, 'recorded-wasm');
      await manager.get(started.id).done;
      const finished = manager.get(started.id);
      assert.equal(finished.status, expected, `${label}: the manager must classify the CLI's typed verdict as ${expected}`);
      assert.notEqual(finished.phase, 'replaying', `${label}: the run stayed replaying`);
      assert.ok(finished.finishedAt, `${label}: no finishedAt recorded`);
      assert.equal(manager.download(started.id), null, `${label}: a refused run exposed a download`);
    }

    console.log('review CLI: typed REJECTED/INCONCLUSIVE verdict, exit code and manager classification agree');
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
