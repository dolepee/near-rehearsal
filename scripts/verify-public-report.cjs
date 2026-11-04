'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(root, 'out', 'public-report.json'), 'utf8'));
const regression = JSON.parse(fs.readFileSync(path.join(root, 'out', 'public-regression.json'), 'utf8'));
const captureFile = path.join(root, regression.capture);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const expected = (BigInt(report.capture.counter) + 1n).toString();
const failureText = JSON.stringify(report.branches.bad.operation.tx?.failure || '');
const checks = {
  sourceIsCounter: report.sourceContract === 'counter.testnet',
  codeHashPinned: report.capture.codeHash === '7H96nK1NFTYUUgiRxNER5AjRfUeD4W1TVNC6eKfSgzrf',
  sourceBuildMatches: report.capture.source.sourceBuildMatchesDeployed === true,
  stateIsTiny: report.capture.stateBytes === 3 && report.capture.counter === '291' && Buffer.from(report.capture.counterBytes, 'base64').toString() === '291',
  allImportsMatch: Object.values(report.branches).every((b) => b.importCheck.matches === true),
  baselineSucceeds: report.branches.baseline.operation.succeeded === true && report.branches.baseline.operation.value === expected,
  badFailsWithStructuredPanic: report.branches.bad.operation.succeeded === false && /v2 migration missing/.test(failureText) && !!report.branches.bad.operation.tx?.transactionHash,
  correctedSucceeds: report.branches.corrected.operation.succeeded === true && report.branches.corrected.operation.value === expected,
  migrationsHaveTxHashes: !!report.branches.bad.migration?.transactionHash && !!report.branches.corrected.migration?.transactionHash,
  runtimePinned: report.runtime.version === '2.6.2' && report.runtime.protocolVersion === 77 && report.runtime.commit === '2f9ddb711ebd94a306eaec06030d87ef8dfc51fa',
  regressionCaptureHash: sha256(fs.readFileSync(captureFile)) === regression.captureSha256,
  candidateHashes: ['bad', 'corrected'].every((k) => {
    const c = regression.candidates[k].candidate;
    return sha256(fs.readFileSync(path.join(root, c.wasm))) === c.sha256;
  }),
  expectedPinned: regression.expected.baseline.value === expected && regression.expected.corrected.value === expected && regression.expected.bad.succeeded === false,
};
console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((v) => !v)) process.exit(1);
