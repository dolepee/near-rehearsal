'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {createManager} = require('./repair-job.cjs');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const BOND = 10n ** 24n;
const TRANSFER = 10n ** 23n;
const report = (failedContract) => ({
  schema: 'near-rehearsal/issue238-local/v1',
  source: {repository: 'https://github.com/near-daos/sputnik-dao-contract', commit: '5434a59dec23ee0c49df8c8c4350c208a7e75b0b', wasmSha256: 'a'.repeat(64)},
  runtime: {sandbox: '2.14.0', commit: 'bc4e9e8cfb03d9e82f027883055624e18576993e', protocol: 88},
  healthy: {
    transferDeclaredYocto: TRANSFER.toString(),
    before: {state: [{key: 'frozen', value: 'same'}], policy: {proposal_bond: BOND.toString()}},
    after: {proposal: {status: 'Approved'}},
    deltas: {contract: (-TRANSFER).toString(), proposer: '-1', recipient: TRANSFER.toString()},
  },
  failed: {
    bondDeclaredYocto: BOND.toString(),
    before: {state: [{key: 'frozen', value: 'same'}], policy: {proposal_bond: BOND.toString()}},
    after: {proposal: {status: 'Failed'}},
    deltas: {contract: failedContract.toString(), proposer: '-2', recipient: '0'},
    retry: {
      final: 'FINAL',
      summary: {transactionHash: 'retry', totalTokensBurntYocto: '123'},
      deltas: {contract: '0', proposer: '-3', recipient: '0'},
    },
  },
});

function fakeChild(handler) {
  const child = new EventEmitter();
  child.pid = Math.floor(Math.random() * 100000) + 1000;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    try {
      const {code = 0} = handler(child) || {};
      child.emit('close', code, null);
    } catch (error) {
      child.emit('error', error);
    }
  });
  return child;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-failed-pipeline-'));
  const runsRoot = path.join(tmp, 'runs');
  const privateRuntime = path.join(tmp, 'provider-runtime');
  fs.mkdirSync(privateRuntime, {recursive: true});
  const config = {
    sourceDir: tmp, baseWasm: path.join(tmp, 'base.wasm'), sandboxDir: tmp,
    codexBin: 'codex', profile: 'test-profile', privateRuntime,
    authSource: path.join(tmp, 'auth.json'), sandboxCmd: 'test', providerConfigured: true,
    configured: true, missing: [], timeouts: {baselineMs: 10000, generationMs: 10000, pipelineMs: 10000, jobMs: 30000},
  };
  const fakeSpawn = (command, args, options) => {
    const out = args[args.indexOf('--out') + 1];
    if (args[0].endsWith('issue238-local.cjs')) {
      fs.mkdirSync(options.env.SPUTNIK_OUT_DIR, {recursive: true});
      fs.writeFileSync(path.join(options.env.SPUTNIK_OUT_DIR, 'issue238-local.json'), JSON.stringify(report(BOND)));
      return fakeChild(() => ({code: 0}));
    }
    if (args[0].endsWith('codex-producer.cjs')) {
      const dir = path.join(out);
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(privateRuntime, 'auth.json'), '{}');
      fs.writeFileSync(path.join(dir, 'canonical.patch'), 'diff --git a/sputnikdao2/src/proposals.rs b/sputnikdao2/src/proposals.rs\n');
      fs.writeFileSync(path.join(dir, 'producer.json'), JSON.stringify({schema: 'near-rehearsal/codex-tool-free-producer/v1', changedSourceSha256: 'b'.repeat(64)}));
      return fakeChild(() => ({code: 0}));
    }
    if (args[0].endsWith('repair-pipeline.cjs')) {
      const dir = path.join(out);
      fs.mkdirSync(path.join(dir, 'replay'), {recursive: true});
      fs.mkdirSync(path.join(dir, 'applied/target/wasm32-unknown-unknown/release'), {recursive: true});
      fs.writeFileSync(path.join(dir, 'applied/target/wasm32-unknown-unknown/release/sputnikdao2.wasm'), 'wasm');
      fs.writeFileSync(path.join(dir, 'replay/issue238-local.json'), JSON.stringify(report(0n)));
      fs.writeFileSync(path.join(dir, 'candidate-identity.json'), JSON.stringify({source: {path: 'sputnikdao2/src/proposals.rs'}}));
      fs.writeFileSync(path.join(dir, 'pipeline.json'), JSON.stringify({ok: false, acceptanceErrors: ['declared acceptance failed'], changedArtifactRejected: true, hashes: {wasm: sha('wasm')}}));
      return fakeChild(() => ({code: 1}));
    }
    throw new Error(`unexpected command: ${args[0]}`);
  };
  const manager = createManager({config, runsRoot, spawn: fakeSpawn});
  const started = manager.start('sputnik-238-async-bond');
  assert.equal(started.status, 'running');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const run = manager.get(started.id);
  assert.equal(run.status, 'rejected');
  assert.equal(run.phase, 'rejected');
  assert.match(run.error, /declared acceptance failed/);
  assert.equal(run.patch.sha256, sha(fs.readFileSync(path.join(runsRoot, started.id, 'producer/canonical.patch'))));
  const publicRun = manager.publicRun(started.id);
  assert.equal(publicRun.patchUrl, `/api/repair/runs/${started.id}/patch`);
  assert.equal(publicRun.bundleUrl, null);
  assert.equal(run.consequence.candidate.failedContract, '0');
  assert.ok(run.evidence);
  assert.equal(fs.existsSync(privateRuntime), true, 'a preexisting runtime directory is kept');
  assert.deepEqual(fs.readdirSync(privateRuntime), [], 'runtime contents created by the run are cleared');

  console.log(JSON.stringify({
    schema: 'near-rehearsal/repair-browser-pipeline-failure-tests/v1',
    passed: true,
    checks: ['completed-rejection-parsed', 'measured-consequence-retained', 'patch-retained', 'bundle-withheld', 'preexisting-runtime-preserved'],
  }, null, 2));
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
