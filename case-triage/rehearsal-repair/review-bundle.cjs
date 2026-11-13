'use strict';
/*
 * Convert a completed maintainer patch review into the reviewer bundle schema
 * already understood by /review. This is a bridge, not a second acceptance
 * policy: the reviewer reruns the existing source-build or recorded-WASM path.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const read = (file) => fs.readFileSync(file);
const text = (file) => fs.readFileSync(file, 'utf8');
const parse = (file) => JSON.parse(text(file));
const {mixedPolicyIdentity} = require('./mixed-policy-identity.cjs');

function buildReviewBundle(opts = {}) {
  const patchText = text(opts.patchPath);
  const wasm = read(opts.wasmPath);
  const identityText = text(opts.candidateIdentityPath);
  const identity = JSON.parse(identityText);
  const baseReportText = text(opts.baseReportPath);
  const candidateReportText = text(opts.candidateReportPath);
  const recoveryReportText = text(opts.recoveryPath);
  const acceptance = parse(opts.acceptancePath);
  const mixedText = opts.mixedPath && fs.existsSync(opts.mixedPath) ? text(opts.mixedPath) : null;
  const settlementText = opts.settlementPath && fs.existsSync(opts.settlementPath) ? text(opts.settlementPath) : null;
  if (acceptance?.ok !== true) throw new Error('refusing to export a reviewer bundle without passing persisted acceptance');
  if (identity?.schema !== 'near-rehearsal/repair-candidate-identity/v1') throw new Error('candidate identity schema is invalid');
  if (identity.wasm?.sha256 !== sha256(wasm)) throw new Error('candidate identity WASM hash does not match the built artifact');
  if (identity.patch?.sha256 !== sha256(Buffer.from(patchText, 'utf8'))) throw new Error('candidate identity patch hash does not match the submitted patch');
  if (!identity.source?.path || !identity.source?.sha256 || !identity.source?.commit) throw new Error('candidate identity source is incomplete');
  const source = identity.source;
  const mixedPolicy = mixedText ? mixedPolicyIdentity() : null;
  const settlementPolicySha256 = settlementText ? sha256(read(require.resolve('./settlement-policy.cjs'))) : null;
  const candidate = {
    patch: {text: patchText, sha256: sha256(Buffer.from(patchText, 'utf8')), bytes: Buffer.byteLength(patchText)},
    wasm: {base64: wasm.toString('base64'), sha256: sha256(wasm), bytes: wasm.length},
    reportText: candidateReportText,
    reportSha256: sha256(Buffer.from(candidateReportText, 'utf8')),
    identity,
    identityText,
    identitySha256: sha256(Buffer.from(identityText, 'utf8')),
  };
  const recovery = {
    reportText: recoveryReportText,
    reportSha256: sha256(Buffer.from(recoveryReportText, 'utf8')),
    acceptance,
    candidateWasmSha256: identity.wasm.sha256,
    identity,
    identityText,
    identitySha256: sha256(Buffer.from(identityText, 'utf8')),
    artifacts: {
      patch: {filename: 'repair.patch', sha256: identity.patch.sha256, bytes: Buffer.byteLength(patchText)},
      wasm: {filename: 'candidate.wasm', sha256: identity.wasm.sha256, bytes: wasm.length},
      source: {path: source.path, sha256: source.sha256},
    },
  };
  return {
    schema: 'near-rehearsal/repair-review-bundle/v1',
    runId: opts.runId,
    caseId: 'sputnik-238-async-bond',
    createdAt: opts.createdAt || new Date().toISOString(),
    source: {
      repository: source.repository || 'https://github.com/near-daos/sputnik-dao-contract',
      commit: source.commit,
      path: source.path,
      issue: source.issue || 'https://github.com/near-daos/sputnik-dao-contract/issues/238',
    },
    build: {rust: '1.86.0', target: 'wasm32-unknown-unknown'},
    case: {obligation: {bond: '1000000000000000000000000', bondNear: '1', transfer: '100000000000000000000000', transferNear: '0.1'}},
    baseline: {reportText: baseReportText, reportSha256: sha256(Buffer.from(baseReportText, 'utf8'))},
    candidate,
    recovery,
    mixed: mixedText ? {
      reportText: mixedText,
      reportSha256: sha256(Buffer.from(mixedText, 'utf8')),
      candidateWasmSha256: identity.wasm.sha256,
      policySha256: mixedPolicy.sha256,
      policyFiles: mixedPolicy.files,
    } : null,
    settlement: settlementText ? {
      reportText: settlementText,
      reportSha256: sha256(Buffer.from(settlementText, 'utf8')),
      candidateWasmSha256: identity.wasm.sha256,
      policySha256: settlementPolicySha256,
    } : null,
    producer: opts.producer || null,
    policy: opts.policy || null,
  };
}

module.exports = {buildReviewBundle};
