'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {createManager, exampleBundleText, validateBundle} = require('./review-job.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'near-review-job-'));
const example = exampleBundleText();

function fakeSpawn({payload = null, code = 0, error = null, hold = false} = {}) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.pid = 12345;
    if (hold) return child;
    const out = args[args.indexOf('--out') + 1];
    setTimeout(() => {
      if (error) child.stderr.emit('data', `${error}\n`);
      if (payload) {
        fs.mkdirSync(out, {recursive: true});
        fs.writeFileSync(path.join(out, 'review-result.json'), `${JSON.stringify(payload, null, 2)}\n`);
      }
      child.emit('close', code, null);
    }, 5);
    return child;
  };
}

const acceptedResult = {
  schema: 'near-rehearsal/repair-review-handoff/v1',
  createdAt: new Date().toISOString(),
  bundle: {
    path: '/Users/someone/private/bundle.json',
    sha256: example.sha256,
    runId: example.bundle.runId,
    caseId: example.bundle.caseId,
    source: example.bundle.source,
    candidate: {patchSha256: example.bundle.candidate.patch.sha256, wasmSha256: example.bundle.candidate.wasm.sha256, sourceSha256: example.bundle.candidate.identity?.source?.sha256 || 'a'.repeat(64)},
  },
  run: {
    mode: 'recorded-wasm',
    modeLabel: 'recorded WASM replay (supplied artifact; no source build)',
    sourceHead: null,
    wasmSha256: example.bundle.candidate.wasm.sha256,
    acceptance: {ok: true, candidateWasmSha256: example.bundle.candidate.wasm.sha256, errors: []},
    reportPath: '/tmp/private/report.json',
    replayDir: '/tmp/private/replay',
  },
  summary: {
    mode: 'recorded-wasm',
    modeLabel: 'recorded WASM replay (supplied artifact; no source build)',
    candidateWasmSha256: example.bundle.candidate.wasm.sha256,
    frozenOldCodeFailure: true,
    firstRecovery: {gross: '1 NEAR', gas: '0.0007 NEAR', proposerNet: '0.9993 NEAR', contractDelta: '-1 NEAR', recipientDelta: '0 NEAR', lockedDelta: '0 NEAR'},
    retry: {gross: '0 NEAR', gas: '0.0006 NEAR', proposerNet: '-0.0006 NEAR', contractDelta: '0 NEAR', recipientDelta: '0 NEAR', lockedDelta: '0 NEAR'},
    checks: {preservedState: true, preservedPolicy: true, preservedProposal: true, authorityRejected: true, healthyControl: true, pendingHealthy: true, accepted: true},
  },
  resultPath: '/tmp/private/review-result.json',
  boundary: 'Local NEAR Sandbox 2.14 only.',
};

async function runAccepted() {
  const runsRoot = path.join(tmp, 'accepted');
  const manager = createManager({runsRoot, env: {REPAIR_SANDBOX_DIR: '/opt/sandbox'}, spawn: fakeSpawn({payload: acceptedResult})});
  const started = manager.start(example.bundle);
  assert.equal(started.status, 'running');
  const run = manager.get(started.id);
  await run.done;
  assert.equal(run.status, 'accepted');
  assert.equal(run.result.summary.checks.accepted, true);
  assert.equal(manager.publicRun(run).downloadUrl, `/api/review/runs/${started.id}/download`);
  const downloaded = fs.readFileSync(manager.download(started.id), 'utf8');
  assert.doesNotMatch(downloaded, /\/Users\/|\/tmp\/|\/opt\//);
  assert.match(downloaded, /"accepted": true/);
  assert.ok(manager.input(started.id));
  assert.ok(manager.evidence(started.id));
  assert.doesNotMatch(fs.readFileSync(manager.evidence(started.id), 'utf8'), /\/Users\/|\/tmp\/|\/opt\//);
  assert.equal(manager.list()[0].accepted, true);

  const recovered = createManager({runsRoot, env: {REPAIR_SANDBOX_DIR: '/opt/sandbox'}});
  recovered.recover();
  assert.equal(recovered.get(started.id).status, 'accepted');
  assert.equal(recovered.list().length, 1);
}

async function runRejected() {
  const manager = createManager({runsRoot: path.join(tmp, 'rejected'), env: {REPAIR_SANDBOX_DIR: '/opt/sandbox'}, spawn: fakeSpawn({code: 1, error: 'recorded recovery failed at /tmp/private'})});
  const started = manager.start(example.bundle);
  await manager.get(started.id).done;
  const run = manager.get(started.id);
  assert.equal(run.status, 'rejected');
  assert.doesNotMatch(run.error, /\/tmp\/private/);
  assert.equal(manager.download(started.id), null);
}

async function runActive() {
  const manager = createManager({runsRoot: path.join(tmp, 'active'), env: {REPAIR_SANDBOX_DIR: '/opt/sandbox'}, spawn: fakeSpawn({hold: true})});
  manager.start(example.bundle);
  assert.throws(() => manager.start(example.bundle), (error) => error.statusCode === 409);
  await manager.shutdown();
}

function validation() {
  assert.throws(() => validateBundle({schema: 'wrong'}), /schema/);
  assert.throws(() => validateBundle({...example.bundle, candidate: {...example.bundle.candidate, wasm: {...example.bundle.candidate.wasm, sha256: '0'.repeat(64)}}}), /WASM hash/);
  const checked = validateBundle(example.bundle);
  assert.equal(checked.runId, example.bundle.runId);
  assert.equal(checked.source.commit, example.bundle.source.commit);
}

(async () => {
  try {
    validation();
    await runAccepted();
    await runRejected();
    await runActive();
    console.log('review-job: accepted, rejected, active-lock, recovery and sanitization checks passed');
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
