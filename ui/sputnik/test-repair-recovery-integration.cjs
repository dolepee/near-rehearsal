'use strict';
/*
 * Browser-manager integration without a model or a live Sandbox.
 *
 * The child commands are faked, but the manager's real sequence is exercised:
 * baseline -> producer -> pipeline -> persisted recovery -> independent
 * acceptance -> bundle. The persisted report and candidate bytes are the real
 * committed evidence, so the acceptance step is not a fixture approval.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const crypto = require('node:crypto');
const {createManager} = require('./repair-job.cjs');
const {checkBundle} = require('../../scripts/repair-review.cjs');

const root = path.resolve(__dirname, '..', '..');
const repair = path.join(root, 'case-triage/rehearsal-repair');
const baselineReport = path.join(repair, 'out/issue238-local.json');
const candidateReport = path.join(repair, 'out/audit-intended/fresh/issue238-local.json');
const candidateWasm = path.join(repair, 'mixed-candidates/intended.wasm');
const candidatePatch = path.join(repair, 'mixed-candidates/intended.patch');
const candidateIdentity = path.join(repair, 'mixed-candidates/intended-identity.json');
const persistedReport = path.join(repair, 'out/audit-intended/persisted/persisted-recovery.json');
const mixedReport = path.join(repair, 'out/mixed-obligation-intended.json');
const settlementReport = path.join(repair, 'out/audit-intended/settlement/settlement-refund.json');

function arg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function fakeSpawn({mixedPath = mixedReport, writeSettlement = true, settlementMutate = null, settlementFail = false} = {}) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 900000 + Math.floor(Math.random() * 1000);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      try {
        if (command === process.execPath && args[0]?.endsWith('issue238-local.cjs') && options.env?.SPUTNIK_OUT_DIR) {
          const out = options.env.SPUTNIK_OUT_DIR;
          fs.mkdirSync(out, {recursive: true});
          fs.copyFileSync(baselineReport, path.join(out, 'issue238-local.json'));
        } else if (command === process.execPath && args[0]?.endsWith('codex-producer.cjs')) {
          const out = arg(args, '--out');
          fs.mkdirSync(out, {recursive: true});
          fs.copyFileSync(candidatePatch, path.join(out, 'canonical.patch'));
          fs.writeFileSync(path.join(out, 'producer.json'), JSON.stringify({
            schema: 'near-rehearsal/codex-producer/v1',
            ok: true,
            changedSourceSha256: JSON.parse(fs.readFileSync(candidateIdentity, 'utf8')).source.sha256,
          }));
        } else if (command === process.execPath && args[0]?.endsWith('repair-pipeline.cjs')) {
          const out = arg(args, '--out');
          const applied = path.join(out, 'applied');
          const replay = path.join(out, 'replay');
          fs.mkdirSync(path.join(applied, 'target/wasm32-unknown-unknown/release'), {recursive: true});
          fs.mkdirSync(replay, {recursive: true});
          fs.copyFileSync(candidateWasm, path.join(applied, 'target/wasm32-unknown-unknown/release/sputnikdao2.wasm'));
          fs.copyFileSync(candidateIdentity, path.join(out, 'candidate-identity.json'));
          fs.copyFileSync(candidateReport, path.join(replay, 'issue238-local.json'));
          const identity = JSON.parse(fs.readFileSync(candidateIdentity, 'utf8'));
          fs.writeFileSync(path.join(out, 'pipeline.json'), JSON.stringify({
            schema: 'near-rehearsal/repair-pipeline/v1',
            ok: true,
            acceptanceErrors: [],
            changedArtifactRejected: true,
            hashes: {patch: identity.patch.sha256, appliedSource: identity.source.sha256, wasm: identity.wasm.sha256},
          }));
        } else if (command === process.execPath && args[0]?.endsWith('mixed-obligation.cjs')) {
          const out = arg(args, '--out');
          fs.mkdirSync(out, {recursive: true});
          fs.copyFileSync(mixedPath, path.join(out, 'mixed-obligation.json'));
        } else if (command === process.execPath && args[0]?.endsWith('persisted-recovery.cjs')) {
          const out = arg(args, '--out');
          fs.mkdirSync(out, {recursive: true});
          fs.copyFileSync(persistedReport, path.join(out, 'persisted-recovery.json'));
        } else if (command === process.execPath && args[0]?.endsWith('settlement-refund-tests.cjs')) {
          if (settlementFail) throw new Error('settlement child failed before writing a report');
          if (!writeSettlement) throw new Error('settlement child failed before writing a report');
          const out = arg(args, '--out');
          fs.mkdirSync(out, {recursive: true});
          if (settlementMutate) {
            const report = settlementMutate(JSON.parse(fs.readFileSync(settlementReport, 'utf8')));
            fs.writeFileSync(path.join(out, 'settlement-refund.json'), JSON.stringify(report));
          } else {
            fs.copyFileSync(settlementReport, path.join(out, 'settlement-refund.json'));
          }
        } else {
          throw new Error(`unexpected fake command: ${command} ${args.join(' ')}`);
        }
        child.emit('close', 0, null);
      } catch (error) {
        child.stderr.emit('data', String(error.stack || error));
        child.emit('close', 1, null);
      }
    });
    return child;
  };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-recovery-integration-'));
  const manager = createManager({
    runsRoot: tmp,
    spawn: fakeSpawn(),
    config: {
      configured: true,
      providerConfigured: true,
      missing: [],
      sandboxDir: '/fake-sandbox',
      baseWasm: path.join(repair, 'bundle/artifacts/base.wasm'),
      privateRuntime: path.join(tmp, 'provider-runtime'),
      timeouts: {baselineMs: 30000, generationMs: 30000, pipelineMs: 30000, recoveryMs: 30000, mixedMs: 30000, settlementMs: 30000, jobMs: 120000},
    },
  });
  const started = manager.start('sputnik-238-async-bond');
  await manager.get(started.id).done;
  const run = manager.get(started.id);
  assert.equal(run.status, 'accepted', run.error || 'run was not accepted');
  assert.equal(run.recovery?.ok, true);
  assert.equal(run.checks?.recoveryAccepted, true);
  assert.equal(run.recovery.summary.firstGrossRecoveryYocto, '1000000000000000000000000');
  assert.equal(run.recovery.summary.secondGrossRecoveryYocto, '0');
    const bundle = manager.bundle(started.id);
  assert.equal(bundle.recovery.report.schema, 'near-rehearsal/persisted-bond-recovery/v1');
  const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
  assert.equal(bundle.recovery.reportSha256, sha(bundle.recovery.reportText));
  assert.equal(bundle.recovery.reportSha256, sha(JSON.stringify(bundle.recovery.report)));
  assert.equal(bundle.recovery.rawReportSha256, manager.get(started.id).recovery.reportSha256);
  assert.match(bundle.commands.recovery, /persisted-recovery-acceptance\.cjs/);
  assert.match(bundle.commands.recovery, /--source <applied-proposals\.rs>/);
  assert.match(bundle.commands.recovery, /--expected-source-sha256/);
  assert.equal(bundle.recovery.appliedSource.sha256, JSON.parse(fs.readFileSync(candidateIdentity, 'utf8')).source.sha256);
  assert.equal(bundle.recovery.report.identity.source.sha256, bundle.recovery.appliedSource.sha256);
  assert.equal(bundle.checks.recoveryAccepted, true);
  assert.ok(bundle.mixed && bundle.mixed.reportSha256, 'accepted bundle must carry mixed evidence');
  assert.ok(bundle.acceptancePolicy && bundle.acceptancePolicy.policyVersion, 'accepted bundle must carry acceptance policy');

  const restarted = createManager({
    runsRoot: tmp,
    spawn: fakeSpawn(),
    config: {
      configured: true,
      providerConfigured: true,
      missing: [],
      sandboxDir: '/fake-sandbox',
      baseWasm: path.join(repair, 'bundle/artifacts/base.wasm'),
      privateRuntime: path.join(tmp, 'provider-runtime'),
      timeouts: {baselineMs: 30000, generationMs: 30000, pipelineMs: 30000, recoveryMs: 30000, mixedMs: 30000, settlementMs: 30000, jobMs: 120000},
    },
  });
  restarted.recover();
  const restored = restarted.get(started.id);
  assert.ok(restored && restored.mixed, 'mixed evidence must survive manager restart');
  assert.ok(restored.acceptancePolicy, 'acceptance policy must survive manager restart');
  const restartedBundle = restarted.bundle(started.id);
  assert.ok(restartedBundle.mixed && restartedBundle.mixed.reportSha256, 'restarted bundle must retain mixed evidence');
  const reviewerSourceCheck = checkBundle(bundle);
  const reviewerReplayCheck = checkBundle(restartedBundle);
  assert.equal(reviewerSourceCheck.mixedPolicy.sha256, bundle.mixed.policySha256);
  assert.equal(reviewerReplayCheck.mixedPolicy.sha256, restartedBundle.mixed.policySha256);
  assert.ok(reviewerSourceCheck.producerMixed && reviewerReplayCheck.producerMixed, 'both reviewer modes must accept the exported mixed evidence');
  assert.equal(restartedBundle.mixed.reportSha256, bundle.mixed.reportSha256);
  assert.equal(restartedBundle.acceptancePolicy.policyVersion, bundle.acceptancePolicy.policyVersion);

  const clearAllRoot = path.join(tmp, 'clear-all-run');
  const clearManager = createManager({
    runsRoot: clearAllRoot,
    spawn: fakeSpawn({mixedPath: path.join(repair, 'out/mixed-obligation-clear-all.json')}),
    config: {
      configured: true, providerConfigured: true, missing: [], sandboxDir: '/fake-sandbox',
      baseWasm: path.join(repair, 'bundle/artifacts/base.wasm'), privateRuntime: path.join(tmp, 'clear-provider-runtime'),
      timeouts: {baselineMs: 30000, generationMs: 30000, pipelineMs: 30000, recoveryMs: 30000, mixedMs: 30000, settlementMs: 30000, jobMs: 120000},
    },
  });
  const clearStarted = clearManager.start('sputnik-238-async-bond');
  await clearManager.get(clearStarted.id).done;
  const clearRun = clearManager.get(clearStarted.id);
  assert.equal(clearRun.status, 'rejected', 'a valid clear-all policy failure must be rejected, not inconclusive');
  assert.match(clearRun.error, /mixed|liability|unrelated obligation/i);
  assert.equal(clearRun.mixed.ok, false);

  const missingRoot = path.join(tmp, 'missing-settlement-run');
  const missingManager = createManager({
    runsRoot: missingRoot,
    spawn: fakeSpawn({writeSettlement: false}),
    config: {
      configured: true, providerConfigured: true, missing: [], sandboxDir: '/fake-sandbox',
      baseWasm: path.join(repair, 'bundle/artifacts/base.wasm'), privateRuntime: path.join(tmp, 'missing-provider-runtime'),
      timeouts: {baselineMs: 30000, generationMs: 30000, pipelineMs: 30000, recoveryMs: 30000, mixedMs: 30000, settlementMs: 30000, jobMs: 120000},
    },
  });
  const missingStarted = missingManager.start('sputnik-238-async-bond');
  await missingManager.get(missingStarted.id).done;
  const missingRun = missingManager.get(missingStarted.id);
  assert.equal(missingRun.status, 'inconclusive', 'an unexecuted settlement check must be inconclusive, not rejected');
  assert.equal(missingRun.mixed.ok, true);
  assert.equal(missingRun.settlement.ok, false);
  const mutateSettlement = (kind) => (report) => {
    const changed = JSON.parse(JSON.stringify(report));
    if (kind === 'guard' || kind === 'both') {
      const retry = changed.inherited.transactions.retries[0];
      retry.receipts.find((receipt) => receipt.id === retry.transactionOutcome.status.SuccessReceiptId).status = {SuccessValue: ''};
    }
    if (kind === 'debt' || kind === 'both') changed.inherited.failedRefund.lockedAmount = '0';
    return changed;
  };
  const mutationConfig = {
    configured: true, providerConfigured: true, missing: [], sandboxDir: '/fake-sandbox',
    baseWasm: path.join(repair, 'bundle/artifacts/base.wasm'),
    timeouts: {baselineMs: 30000, generationMs: 30000, pipelineMs: 30000, recoveryMs: 30000, mixedMs: 30000, settlementMs: 30000, jobMs: 120000},
  };
  const runMutationCase = async (name, kind) => {
    const mutationRoot = path.join(tmp, `${name}-run`);
    const mutationManager = createManager({
      runsRoot: mutationRoot,
      spawn: fakeSpawn({settlementMutate: mutateSettlement(kind)}),
      config: {...mutationConfig, privateRuntime: path.join(tmp, `${name}-provider-runtime`)},
    });
    const started = mutationManager.start('sputnik-238-async-bond');
    await mutationManager.get(started.id).done;
    return mutationManager.get(started.id);
  };
  const captureFailRoot = path.join(tmp, 'capture-failure-run');
  const captureFailManager = createManager({
    runsRoot: captureFailRoot,
    spawn: fakeSpawn({writeSettlement: false, settlementFail: true}),
    config: {...mutationConfig, privateRuntime: path.join(tmp, 'capture-failure-provider-runtime')},
  });
  const captureFailStarted = captureFailManager.start('sputnik-238-async-bond');
  await captureFailManager.get(captureFailStarted.id).done;
  const captureFailRun = captureFailManager.get(captureFailStarted.id);
  assert.equal(captureFailRun.status, 'inconclusive', 'a failed retry-capture child must remain inconclusive, not a proved rejection');
  assert.equal(captureFailRun.settlement.ok, false);

  const guardRun = await runMutationCase('guard-unproven', 'guard');
  assert.equal(guardRun.status, 'inconclusive', 'a guard-only omission must remain inconclusive');
  const debtRun = await runMutationCase('lost-debt', 'debt');
  assert.equal(debtRun.status, 'rejected', 'a lost locked debt must remain a semantic rejection');
  assert.match(debtRun.error || '', /locked debt|failed refund/i);
  const bothRun = await runMutationCase('lost-debt-and-guard', 'both');
  assert.equal(bothRun.status, 'rejected', 'coverage uncertainty must not mask a verified financial failure');

  console.log(JSON.stringify({
    schema: 'near-rehearsal/repair-recovery-integration-tests/v1',
    passed: true,
    checks: ['baseline', 'producer', 'pipeline', 'persisted-recovery', 'independent-acceptance', 'accepted-bundle', 'recovery-evidence-in-bundle'],
  }, null, 2));
})();
