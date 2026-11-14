'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sha256File = (file) => sha256(fs.readFileSync(file));

function mixedPolicyIdentity(root = path.resolve(__dirname, '../..')) {
  const files = {
    mixedObligation: path.join(root, 'case-triage/rehearsal-repair/mixed-obligation.cjs'),
    mixedPolicy: path.join(root, 'case-triage/rehearsal-repair/mixed-policy.cjs'),
    acceptanceOrchestrator: path.join(root, 'case-triage/rehearsal-repair/acceptance-orchestrator.cjs'),
    baseWasm: path.join(root, 'case-triage/rehearsal-repair/bundle/artifacts/base.wasm'),
    baseReport: path.join(root, 'case-triage/rehearsal-repair/out/issue238-local.json'),
  };
  const hashes = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, sha256File(file)]));
  const {POLICY_VERSION} = require(path.join(root, 'case-triage/rehearsal-repair/acceptance-orchestrator.cjs'));
  return {
    files: hashes,
    policyVersion: POLICY_VERSION,
    sha256: sha256(Buffer.from(JSON.stringify({files: hashes, policyVersion: POLICY_VERSION}), 'utf8')),
  };
}

module.exports = {mixedPolicyIdentity};
