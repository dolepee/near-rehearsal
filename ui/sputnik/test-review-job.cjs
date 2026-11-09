'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const crypto = require('node:crypto');
const {createManager, exampleBundleText, validateBundle} = require('./review-job.cjs');
const {summarize} = require('../../scripts/repair-review.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'near-review-job-'));
const example = exampleBundleText();
assert.notEqual(example.sha256, example.canonicalSha256, 'raw and canonical bundle hashes are distinct');
const tampered = JSON.parse(JSON.stringify(example.bundle));
tampered.case.obligation.transferNear = '1000000';
assert.throws(() => validateBundle(tampered), /case obligation transferNear does not match/, 'a tampered case obligation is rejected before display');
const measured = summarize({
  firstRecovery: {grossRecoveryYocto: '1000000000000000000000000', gasBurntYocto: '1', deltas: {proposer: '999', contract: '-1000000000000000000000000', recipient: '0', locked: '-1000000000000000000000000'}},
  secondRetry: {grossRecoveryYocto: '0', gasBurntYocto: '1', deltas: {proposer: '-1', contract: '0', recipient: '0', locked: '0'}},
  failed: {proposal: {status: 'Failed'}, frozen: {proposal: {status: 'Failed'}}},
  preservation: {state: true, policy: true, proposal: true},
  authority: {unauthorizedUpdateRejected: true, unauthorizedFinalizeRejected: true},
  healthyPreservation: {
    checks: {settledApproved: true, settledPayout: '100000000000000000000000', pendingPayout: true, pendingNoSecondPayout: true},
    pending: {deltas: {recipient: '100000000000000000000000'}},
  },
}, {mode: 'recorded-wasm', modeLabel: 'recorded WASM replay'});
assert.equal(measured.healthy.settledTransfer, '0.1 NEAR', 'healthy amount comes from the measured settled payout');
assert.equal(measured.healthy.pendingTransfer, '0.1 NEAR', 'healthy amount comes from the measured pending payout');
const sandboxDir = path.join(tmp, 'sandbox');
fs.mkdirSync(sandboxDir, {recursive: true});
fs.writeFileSync(path.join(sandboxDir, 'near-sandbox'), '');

const spawnCalls = [];
function fakeSpawn({payload = null, code = 0, error = null, hold = false} = {}) {
  return (command, args, options) => {
    spawnCalls.push({command, args, options});
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    child.kill = (signal = 'SIGTERM') => {
      child.signals.push(signal);
      if (hold) setImmediate(() => child.emit('close', null, signal));
    };
    // Synthetic children must not signal a real process group on this host.
    child.pid = undefined;
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
    healthy: {settledTransfer: '0.1 NEAR', settledTransferYocto: '100000000000000000000000', pendingTransfer: '0.1 NEAR', pendingTransferYocto: '100000000000000000000000'},
    checks: {preservedState: true, preservedPolicy: true, preservedProposal: true, authorityRejected: true, healthyControl: true, pendingHealthy: true, accepted: true},
  },
  resultPath: '/tmp/private/review-result.json',
  boundary: 'Local NEAR Sandbox 2.14 only.',
};

async function runAccepted() {
  const runsRoot = path.join(tmp, 'accepted');
  const manager = createManager({runsRoot, env: {REPAIR_SANDBOX_DIR: sandboxDir}, spawn: fakeSpawn({payload: acceptedResult})});
  const started = manager.start(example.bundle, 'recorded-wasm');
  assert.equal(started.status, 'running');
  assert.equal(spawnCalls.at(-1)?.options?.detached, process.platform !== 'win32', 'the review runs in its own process group');
  assert.equal(spawnCalls.at(-1)?.options?.stdio?.[0], 'ignore');
  const run = manager.get(started.id);
  await run.done;
  assert.equal(run.status, 'accepted');
  assert.equal(run.result.summary.checks.accepted, true);
  assert.equal(manager.publicRun(run).bundle.case.obligation.bondNear, '1', 'accepted result carries the declared frozen bond');
  assert.equal(run.result.summary.firstRecovery.gross, '1 NEAR', 'accepted result carries measured first recovery');
  assert.equal(run.result.summary.firstRecovery.proposerNet, '0.9993 NEAR', 'accepted result carries measured proposer net');
  assert.equal(run.result.summary.retry.gross, '0 NEAR', 'accepted result carries zero retry principal');
  assert.equal(manager.publicRun(run).downloadUrl, `/api/review/runs/${started.id}/download`);
  const downloaded = fs.readFileSync(manager.download(started.id), 'utf8');
  assert.doesNotMatch(downloaded, /\/Users\/|\/tmp\/|\/opt\//);
  assert.match(downloaded, /"accepted": true/);
  const inputFile = manager.input(started.id);
  const inputHash = crypto.createHash('sha256').update(fs.readFileSync(inputFile)).digest('hex');
  assert.equal(run.bundle.sha256, inputHash, 'reported bundle hash is the stored/downloaded bytes');
  assert.equal(run.bundle.canonicalSha256, example.canonicalSha256, 'canonical compact JSON hash is separate');
  assert.equal(run.result.bundle.sha256, inputHash, 'result metadata uses the stored bytes hash');
  assert.equal(run.result.bundle.canonicalSha256, example.canonicalSha256, 'result metadata keeps the canonical content hash');
  assert.ok(manager.input(started.id));
  assert.ok(manager.evidence(started.id));
  assert.doesNotMatch(fs.readFileSync(manager.evidence(started.id), 'utf8'), /\/Users\/|\/tmp\/|\/opt\//);
  assert.equal(manager.list()[0].accepted, true);

  const recovered = createManager({runsRoot, env: {REPAIR_SANDBOX_DIR: sandboxDir}});
  recovered.recover();
  assert.equal(recovered.get(started.id).status, 'accepted');
  assert.equal(recovered.list().length, 1);
}

async function runRejected() {
  const manager = createManager({runsRoot: path.join(tmp, 'rejected'), env: {REPAIR_SANDBOX_DIR: sandboxDir}, spawn: fakeSpawn({code: 1, error: 'recorded recovery failed at /tmp/private'})});
  const started = manager.start(example.bundle, 'recorded-wasm');
  await manager.get(started.id).done;
  const run = manager.get(started.id);
  assert.equal(run.status, 'rejected');
  assert.doesNotMatch(run.error, /\/tmp\/private/);
  assert.equal(manager.download(started.id), null);
}

async function runActive() {
  const manager = createManager({runsRoot: path.join(tmp, 'active'), env: {REPAIR_SANDBOX_DIR: sandboxDir}, spawn: fakeSpawn({hold: true})});
  const started = manager.start(example.bundle, 'recorded-wasm');
  assert.throws(() => manager.start(example.bundle, 'recorded-wasm'), (error) => error.statusCode === 409);
  await manager.shutdown();
  const stopped = manager.get(started.id);
  assert.equal(stopped.status, 'interrupted', 'a review stopped by shutdown is interrupted, not rejected');
  assert.match(stopped.error, /server shut down/, 'the stop reason is recorded honestly');
  assert.equal(manager.active(), null, 'no review stays active after shutdown');
}

function runRestartRecovery() {
  const runsRoot = path.join(tmp, 'restart');
  const dir = path.join(runsRoot, 'run-restart');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
    schema: 'near-rehearsal/review-browser-run/v1',
    id: 'run-restart',
    status: 'running',
    phase: 'replaying',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    bundle: {sha256: 'a'.repeat(64)},
    mode: 'recorded-wasm',
    logs: [],
  }));
  const manager = createManager({runsRoot, env: {REPAIR_SANDBOX_DIR: sandboxDir}});
  manager.recover();
  const recovered = manager.get('run-restart');
  assert.equal(recovered.status, 'interrupted', 'a restart marks an in-flight run interrupted');
  assert.match(recovered.error, /restarted before this review completed/, 'the restart reason is explicit');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')).status, 'interrupted',
    'the interrupted state is persisted for the next restart');
}

function validation() {
  const manager = createManager({runsRoot: path.join(tmp, 'validation'), env: {REPAIR_SANDBOX_DIR: sandboxDir}, spawn: fakeSpawn({hold: true})});
  assert.throws(() => manager.start(example.bundle, 'not-a-mode'), (error) => error.statusCode === 400);
  assert.throws(() => manager.start(example.bundle, 'source-build'), (error) => error.statusCode === 409);
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
    runRestartRecovery();
    console.log('review-job: accepted, rejected, active-lock, recovery and sanitization checks passed');
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
