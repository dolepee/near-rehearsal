'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createManager, cleanupPrivateRuntime, deriveConsequence, probePrivateRuntime, resolveConfig, sanitizeValue} = require('./repair-job.cjs');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const BOND = 10n ** 24n;
const TRANSFER = 10n ** 23n;
const GAS = 123456789000000000000n;
const report = ({failedContract, failedRecipient = 0n, retryContract = 0n, retryRecipient = 0n, healthyRecipient = TRANSFER, healthyContract = -TRANSFER} = {}) => ({
  schema: 'near-rehearsal/issue238-local/v1',
  source: {repository: 'https://github.com/near-daos/sputnik-dao-contract', commit: '5434a59dec23ee0c49df8c8c4350c208a7e75b0b', wasmSha256: 'a'.repeat(64)},
  runtime: {sandbox: '2.14.0', commit: 'bc4e9e8cfb03d9e82f027883055624e18576993e', protocol: 88},
  healthy: {
    kind: {Transfer: {receiver_id: 'recipient.test.near', amount: TRANSFER.toString()}},
    transferDeclaredYocto: TRANSFER.toString(),
    before: {state: [{key: 'same', value: 'state'}], policy: {proposal_bond: BOND.toString()}},
    after: {proposal: {status: 'Approved'}},
    deltas: {contract: healthyContract.toString(), proposer: '-1', recipient: healthyRecipient.toString()},
  },
  failed: {
    kind: {FunctionCall: {receiver_id: 'missing-target.test.near'}},
    bondDeclaredYocto: BOND.toString(),
    before: {state: [{key: 'same', value: 'state'}], policy: {proposal_bond: BOND.toString()}},
    after: {proposal: {status: 'Failed'}},
    deltas: {contract: failedContract.toString(), proposer: '-2', recipient: failedRecipient.toString()},
    retry: {
      final: 'FINAL',
      summary: {transactionHash: 'retry-hash', totalTokensBurntYocto: GAS.toString()},
      deltas: {contract: retryContract.toString(), proposer: '-3', recipient: retryRecipient.toString()},
    },
  },
});

try {
  const baseline = report({failedContract: BOND});
  const candidate = report({failedContract: 0n});
  const consequence = deriveConsequence(baseline, candidate);
  assert.equal(consequence.baseline.bondRetained, true);
  assert.equal(consequence.candidate.bondReturned, true);
  assert.equal(consequence.candidate.retryNoSecondRefund, true);
  assert.equal(consequence.candidate.healthyPayoutUnchanged, true);
  assert.equal(consequence.checks.authorizedRetryNoSecondRefund, true);
  assert.equal(consequence.candidate.retryGas, GAS.toString(), 'gas is separate from principal');

  const secondRefund = report({failedContract: 0n, retryContract: BOND});
  const badRetry = deriveConsequence(baseline, secondRefund);
  assert.equal(badRetry.candidate.retryNoSecondRefund, false);
  assert.equal(badRetry.checks.authorizedRetryNoSecondRefund, false);
  assert.equal(badRetry.candidate.bondReturned, true, 'contract delta alone does not prove no double refund');

  const unexecutedRetry = report({failedContract: 0n});
  unexecutedRetry.failed.retry.final = null;
  const noFinal = deriveConsequence(baseline, unexecutedRetry);
  assert.equal(noFinal.candidate.retryNoSecondRefund, false, 'zero deltas without a FINAL receipt do not prove a clean retry');
  assert.equal(noFinal.checks.authorizedRetryNoSecondRefund, false);

  const changedPayout = report({failedContract: 0n, healthyRecipient: 0n});
  const badPayout = deriveConsequence(baseline, changedPayout);
  assert.equal(badPayout.candidate.healthyPayoutUnchanged, false);

  const deploymentBalanceDiffers = report({failedContract: 0n});
  deploymentBalanceDiffers.healthy.before.contract = 'different-deployment-gas';
  const sameFrozenState = deriveConsequence(baseline, deploymentBalanceDiffers);
  assert.equal(sameFrozenState.checks.baseAndCandidateStartSameState, true);
  deploymentBalanceDiffers.healthy.before.policy = {proposal_bond: 'different'};
  assert.equal(deriveConsequence(baseline, deploymentBalanceDiffers).checks.baseAndCandidateStartSameState, false);

  const sanitized = sanitizeValue({
    source: {path: 'sputnikdao2/src/proposals.rs'},
    binary: '/workspace/tools/near-sandbox',
    nested: {absolute: '/workspace/run/out', relative: 'out/report.json'},
  });
  assert.equal(sanitized.source.path, 'sputnikdao2/src/proposals.rs');
  assert.equal(sanitized.binary, undefined);
  assert.equal(sanitized.nested.absolute, '<local-path>');
  assert.equal(sanitized.nested.relative, 'out/report.json');

  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-runtime-test-'));
  const createdRuntime = path.join(runtimeRoot, 'created-by-run');
  const createdProbe = probePrivateRuntime(createdRuntime);
  assert.equal(createdProbe.existed, false);
  fs.mkdirSync(createdRuntime, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(createdRuntime, 'auth.json'), '{}');
  cleanupPrivateRuntime(createdRuntime, createdProbe);
  assert.equal(fs.existsSync(createdRuntime), false, 'a runtime created by the run is removed');

  const emptyRuntime = path.join(runtimeRoot, 'preexisting-empty');
  fs.mkdirSync(emptyRuntime);
  const emptyProbe = probePrivateRuntime(emptyRuntime);
  assert.equal(emptyProbe.wasEmpty, true);
  fs.writeFileSync(path.join(emptyRuntime, 'auth.json'), '{}');
  cleanupPrivateRuntime(emptyRuntime, emptyProbe);
  assert.equal(fs.existsSync(emptyRuntime), true, 'a preexisting empty runtime directory is kept');
  assert.deepEqual(fs.readdirSync(emptyRuntime), [], 'contents created by the run are cleared');

  const nonemptyRuntime = path.join(runtimeRoot, 'preexisting-nonempty');
  fs.mkdirSync(nonemptyRuntime);
  fs.writeFileSync(path.join(nonemptyRuntime, 'marker.txt'), 'keep');
  const nonemptyProbe = probePrivateRuntime(nonemptyRuntime);
  assert.equal(nonemptyProbe.wasEmpty, false);
  cleanupPrivateRuntime(nonemptyRuntime, nonemptyProbe);
  assert.equal(fs.readFileSync(path.join(nonemptyRuntime, 'marker.txt'), 'utf8'), 'keep', 'preexisting runtime contents survive a refused initialization');

  const runtimeFile = path.join(runtimeRoot, 'runtime-file');
  fs.writeFileSync(runtimeFile, 'keep');
  const fileProbe = probePrivateRuntime(runtimeFile);
  assert.equal(fileProbe.isDirectory, false);
  cleanupPrivateRuntime(runtimeFile, fileProbe);
  assert.equal(fs.existsSync(runtimeFile), true, 'a non-directory runtime path is left alone');
  fs.rmSync(runtimeRoot, {recursive: true, force: true});

  const env = {...process.env};
  for (const key of ['MODEL_PRODUCER_SANDBOX_CMD', 'CODEX_PERMISSION_PROFILE', 'CODEX_AUTH_SOURCE']) delete env[key];
  env.CODEX_BIN = '';
  const config = resolveConfig(env);
  assert.equal(config.providerConfigured, false);
  assert.ok(config.missing.includes('MODEL_PRODUCER_SANDBOX_CMD'));
  assert.equal(config.codexBin, null, 'the default codex executable is left for producer PATH lookup');
  const explicitCodex = resolveConfig({...env, CODEX_BIN: 'node'});
  assert.ok(path.isAbsolute(explicitCodex.codexBin), 'an explicit bare CODEX_BIN is resolved before passing it');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-manager-test-'));
  const id = '11111111-1111-4111-8111-111111111111';
  const dir = path.join(tmp, id);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
    schema: 'near-rehearsal/repair-browser-run/v1', id, caseId: 'sputnik-238-async-bond',
    status: 'running', phase: 'replaying', startedAt: new Date().toISOString(), finishedAt: null,
    error: null, phaseLog: [], source: {}, obligation: {}, baseline: null, candidate: null,
  }));
  let providerSpawns = 0;
  const unsupported = createManager({
    config: {configured: false, providerConfigured: false, compilerBoundary: {configured: false, reason: 'test boundary unavailable'}, missing: [], timeouts: {}},
    runsRoot: tmp,
    spawn: () => { providerSpawns += 1; throw new Error('provider must not spawn'); },
  });
  assert.throws(() => unsupported.start('sputnik-238-async-bond'), (error) => error?.status === 'unsupported-boundary' && error?.statusCode === 503);
  assert.equal(providerSpawns, 0, 'no provider process is spawned when the compiler boundary is unavailable');
  unsupported.shutdown();

  const manager = createManager({config: {configured: false, providerConfigured: false, missing: [], timeouts: {}}, runsRoot: tmp});
  manager.recover();
  const recovered = manager.get(id);
  assert.equal(recovered.status, 'interrupted');
  assert.match(recovered.error, /restarted/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'))).status, 'interrupted');

  const acceptedId = '22222222-2222-4222-8222-222222222222';
  const accepted = path.join(tmp, acceptedId);
  fs.mkdirSync(path.join(accepted, 'producer'), {recursive: true});
  fs.mkdirSync(path.join(accepted, 'baseline'), {recursive: true});
  fs.mkdirSync(path.join(accepted, 'pipeline/replay'), {recursive: true});
  fs.mkdirSync(path.join(accepted, 'pipeline/applied/target/wasm32-unknown-unknown/release'), {recursive: true});
  fs.mkdirSync(path.join(accepted, 'recovery'), {recursive: true});
  const patch = 'diff --git a/sputnikdao2/src/proposals.rs b/sputnikdao2/src/proposals.rs\n';
  const wasm = Buffer.from('fake-wasm');
  fs.writeFileSync(path.join(accepted, 'producer/canonical.patch'), patch);
  fs.writeFileSync(path.join(accepted, 'pipeline/applied/target/wasm32-unknown-unknown/release/sputnikdao2.wasm'), wasm);
  fs.writeFileSync(path.join(accepted, 'baseline/issue238-local.json'), JSON.stringify(report({failedContract: BOND})));
  fs.writeFileSync(path.join(accepted, 'pipeline/replay/issue238-local.json'), JSON.stringify(report({failedContract: 0n})));
  fs.writeFileSync(path.join(accepted, 'pipeline/candidate-identity.json'), JSON.stringify({schema: 'near-rehearsal/repair-candidate-identity/v1', source: {path: 'sputnikdao2/src/proposals.rs'}, patch: {sha256: sha(patch)}, wasm: {sha256: sha(wasm)}}));
  fs.writeFileSync(path.join(accepted, 'recovery/persisted-recovery.json'), JSON.stringify({schema: 'near-rehearsal/persisted-bond-recovery/v1', firstRecovery: {grossRecoveryYocto: BOND.toString(), final: {finalExecutionStatus: 'FINAL'}}, secondRetry: {grossRecoveryYocto: '0'}}));
  fs.writeFileSync(path.join(accepted, 'pipeline/pipeline.json'), JSON.stringify({schema: 'near-rehearsal/repair-pipeline/v1', ok: true, acceptanceErrors: [], changedArtifactRejected: true, hashes: {patch: sha(patch), wasm: sha(wasm)}, baseReport: '/workspace/local/base.json', candidateReport: '/workspace/local/candidate.json'}));
  fs.writeFileSync(path.join(accepted, 'run.json'), JSON.stringify({
    schema: 'near-rehearsal/repair-browser-run/v1', id: acceptedId, caseId: 'sputnik-238-async-bond',
    status: 'accepted', phase: 'accepted', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    error: null, phaseLog: [], source: {}, obligation: {}, baseline: {reportPath: 'baseline/issue238-local.json'}, candidate: {pipeline: {ok: true}, wasm: {sha256: sha(wasm)}}, consequence, checks: consequence.checks, recovery: {ok: true, status: 'accepted', summary: {firstGrossRecoveryYocto: BOND.toString(), secondGrossRecoveryYocto: '0'}},
  }));
  fs.writeFileSync(path.join(accepted, 'result.json'), JSON.stringify({
    id: acceptedId, status: 'accepted', phase: 'accepted', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    patch: {filename: 'repair.patch', text: patch, sha256: sha(patch), bytes: Buffer.byteLength(patch)},
    evidence: {baseline: report({failedContract: BOND}), candidate: report({failedContract: 0n})},
  }));
  manager.recover();
  const bundle = manager.bundle(acceptedId);
  assert.equal(bundle.candidate.patch.sha256, sha(patch));
  assert.equal(bundle.candidate.wasm.sha256, sha(wasm));
  assert.equal(bundle.baseline.reportSha256, sha(bundle.baseline.reportText));
  assert.equal(bundle.candidate.reportSha256, sha(bundle.candidate.reportText));
  assert.equal(bundle.candidate.identitySha256, sha(bundle.candidate.identityText));
  assert.equal(JSON.stringify(bundle).includes('/workspace'), false);
  assert.match(bundle.commands.verify, /acceptance\.cjs/);
  assert.match(bundle.commands.recovery, /persisted-recovery-acceptance\.cjs/);
  assert.equal(bundle.recovery.report.schema, 'near-rehearsal/persisted-bond-recovery/v1');
  assert.equal(bundle.candidate.wasm.base64, wasm.toString('base64'));
  assert.throws(() => manager.bundle(id), /Only an accepted repair/);

  console.log(JSON.stringify({
    schema: 'near-rehearsal/repair-browser-job-tests/v1',
    passed: true,
    checks: ['consequence', 'second-refund-rejected', 'payout-change-rejected', 'sanitize', 'runtime-ownership', 'provider-config', 'interrupted-recovery', 'accepted-bundle'],
  }, null, 2));
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
