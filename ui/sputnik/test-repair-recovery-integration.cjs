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

const root = path.resolve(__dirname, '..', '..');
const repair = path.join(root, 'case-triage/rehearsal-repair');
const baselineReport = path.join(repair, 'out/issue238-local.json');
const candidateReport = path.join(repair, 'out/issue238-repaired.json');
const candidateWasm = path.join(repair, 'generated/e8262f5a/candidate.wasm');
const candidatePatch = path.join(repair, 'generated/e8262f5a/repair.patch');
const candidateIdentity = path.join(repair, 'generated/e8262f5a/candidate-identity.json');
const persistedReport = path.join(repair, 'out/persisted-recovery.json');
const mixedReport = path.join(repair, 'out/mixed-obligation-intended.json');

function arg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function fakeSpawn() {
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
          fs.copyFileSync(mixedReport, path.join(out, 'mixed-obligation.json'));
        } else if (command === process.execPath && args[0]?.endsWith('persisted-recovery.cjs')) {
          const out = arg(args, '--out');
          fs.mkdirSync(out, {recursive: true});
          fs.copyFileSync(persistedReport, path.join(out, 'persisted-recovery.json'));
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
      timeouts: {baselineMs: 30000, generationMs: 30000, pipelineMs: 30000, recoveryMs: 30000, jobMs: 120000},
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
  console.log(JSON.stringify({
    schema: 'near-rehearsal/repair-recovery-integration-tests/v1',
    passed: true,
    checks: ['baseline', 'producer', 'pipeline', 'persisted-recovery', 'independent-acceptance', 'accepted-bundle', 'recovery-evidence-in-bundle'],
  }, null, 2));
})();
