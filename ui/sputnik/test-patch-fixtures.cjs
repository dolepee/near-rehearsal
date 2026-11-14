'use strict';
// Test-only evidence fixtures for the source-patch browser route. These copy
// the repository's retained, already verified reports; they do not run the
// scientific execution or manufacture a new acceptance result.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repo = path.resolve(__dirname, '../..');
const repair = path.join(repo, 'case-triage', 'rehearsal-repair');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), {recursive: true});
  fs.copyFileSync(from, to);
}

function validatorFiles(root) {
  const target = path.join(root, 'case-triage', 'rehearsal-repair');
  fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
  fs.mkdirSync(path.join(target, 'out'), {recursive: true});
  fs.mkdirSync(path.join(target, 'bundle', 'artifacts'), {recursive: true});
  copy(path.join(repo, 'scripts', 'repair-review.cjs'), path.join(root, 'scripts', 'repair-review.cjs'));
  copy(path.join(repair, 'settlement-policy.cjs'), path.join(target, 'settlement-policy.cjs'));
  copy(path.join(repair, 'mixed-policy.cjs'), path.join(target, 'mixed-policy.cjs'));
  copy(path.join(repair, 'mixed-policy-identity.cjs'), path.join(target, 'mixed-policy-identity.cjs'));
  copy(path.join(repair, 'acceptance-orchestrator.cjs'), path.join(target, 'acceptance-orchestrator.cjs'));
  copy(path.join(repair, 'mixed-obligation.cjs'), path.join(target, 'mixed-obligation.cjs'));
  copy(path.join(repair, 'bundle', 'artifacts', 'base.wasm'), path.join(target, 'bundle', 'artifacts', 'base.wasm'));
  copy(path.join(repair, 'out', 'issue238-local.json'), path.join(target, 'out', 'issue238-local.json'));
}

function acceptedEvidence(runDir, root) {
  const out = path.join(runDir, 'evidence');
  const evidence = path.join(out, 'evidence');
  const pipeline = path.join(out, 'pipeline');
  const applied = path.join(pipeline, 'applied');
  fs.mkdirSync(path.join(applied, 'target', 'wasm32-unknown-unknown', 'release'), {recursive: true});
  fs.mkdirSync(path.join(applied, 'sputnikdao2', 'src'), {recursive: true});
  fs.mkdirSync(path.join(pipeline, 'replay'), {recursive: true});
  fs.mkdirSync(evidence, {recursive: true});
  const wasmPath = path.join(applied, 'target', 'wasm32-unknown-unknown', 'release', 'sputnikdao2.wasm');
  copy(path.join(repo, 'ui/sputnik/public/consequences/downloads/238/intended.wasm'), wasmPath);
  copy(path.join(repair, 'out', 'issue238-local.json'), path.join(pipeline, 'replay', 'issue238-local.json'));
  copy(path.join(repair, 'out', 'audit-intended', 'persisted', 'persisted-recovery.json'), path.join(evidence, 'persisted-recovery.json'));
  copy(path.join(repair, 'out', 'audit-intended', 'persisted', 'persisted-recovery-acceptance.json'), path.join(evidence, 'persisted-recovery-acceptance.json'));
  copy(path.join(repair, 'out', 'mixed-obligation-intended.json'), path.join(evidence, 'mixed-obligation.json'));
  copy(path.join(repair, 'out', 'audit-intended', 'settlement', 'settlement-refund.json'), path.join(evidence, 'settlement-refund.json'));
  fs.writeFileSync(path.join(applied, 'sputnikdao2', 'src', 'proposals.rs'), 'fixture source');
  const patchText = fs.readFileSync(path.join(runDir, 'submitted.patch'), 'utf8');
  const wasm = fs.readFileSync(wasmPath);
  const identity = {
    schema: 'near-rehearsal/repair-candidate-identity/v1',
    source: {
      repository: 'https://github.com/near-daos/sputnik-dao-contract',
      commit: '5434a59dec23ee0c49df8c8c4350c208a7e75b0b',
      path: 'sputnikdao2/src/proposals.rs',
      sha256: sha256(Buffer.from('fixture source')),
    },
    patch: {filename: 'repair.patch', sha256: sha256(Buffer.from(patchText)), bytes: Buffer.byteLength(patchText)},
    wasm: {filename: 'candidate.wasm', sha256: sha256(wasm), bytes: wasm.length},
  };
  fs.writeFileSync(path.join(pipeline, 'candidate-identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
  fs.writeFileSync(path.join(pipeline, 'pipeline.json'), `${JSON.stringify({
    baseReport: path.join(root, 'case-triage', 'rehearsal-repair', 'out', 'issue238-local.json'),
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'review-status.json'), `${JSON.stringify({
    status: 'accepted',
    checks: [{id: 'bond-recovered-once', status: 'pass', detail: 'fixture'}],
    summary: {firstRecovery: {gross: '1 NEAR', endedFailed: true}, retry: {gross: '0 NEAR'}, healthy: {settledTransfer: '0.1 NEAR', pendingTransfer: '0.1 NEAR'}},
    verified: {patchSha256: sha256(Buffer.from(patchText)), builtWasmSha256: sha256(wasm), sourceCommitPinned: identity.source.commit},
    policy: {policySha256: 'c'.repeat(64)},
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'review-report.md'), '# fixture accepted\n');
  return identity;
}

module.exports = {validatorFiles, acceptedEvidence};
