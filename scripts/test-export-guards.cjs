'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {validateCase} = require('./refund-three-way.cjs');
const {verifyRefundReport} = require('./verify-refund-report.cjs');
const {verifyBundle} = require('./verify-refund-export.cjs');

const ROOT = path.join(__dirname, '..');
const caseConfig = validateCase(path.join(ROOT, 'cases/refund-v1/case.json'));
const capture = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/refund-capture.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/refund-report.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const expectFail = (fn, label) => {
  const errors = fn();
  assert.ok(errors.length > 0, label);
  console.log(`rejected: ${label}`);
};

assert.deepEqual(verifyRefundReport(report, caseConfig, capture), []);
console.log('accepted: current complete report');

expectFail(() => {
  const bad = clone(report);
  bad.result.status = 'incomplete';
  return verifyRefundReport(bad, caseConfig, capture);
}, 'tampered complete flag');

expectFail(() => {
  const bad = clone(report);
  bad.result.claimTransferToBeneficiary = false;
  return verifyRefundReport(bad, caseConfig, capture);
}, 'tampered payout gate');

expectFail(() => {
  const bad = clone(report);
  bad.branches.corrected.claim.receipts = bad.branches.corrected.claim.receipts.filter((receipt) => receipt.executorId !== 'refunduser.test.near');
  return verifyRefundReport(bad, caseConfig, capture);
}, 'tampered beneficiary receipt link');

expectFail(() => {
  const bad = clone(capture);
  bad.beneficiary = 'outsider.test.near';
  return verifyRefundReport(report, caseConfig, bad);
}, 'tampered capture beneficiary');

expectFail(() => {
  const changed = clone(caseConfig);
  changed.candidates.bad.wasm = caseConfig.candidates.corrected.wasm;
  changed.candidates.bad.sha256 = caseConfig.candidates.corrected.sha256;
  return verifyRefundReport(report, changed, capture);
}, 'report executed candidate does not match supplied candidate');

expectFail(() => {
  const bad = clone(report);
  bad.branches.corrected.runtime.version = '9.9.9';
  bad.branches.corrected.runtimePinMatched = true;
  return verifyRefundReport(bad, caseConfig, capture);
}, 'runtime booleans do not replace runtime evidence');

expectFail(() => {
  const bad = clone(report);
  bad.branches.corrected.importCheck.codeHash = '11111111111111111111111111111111';
  bad.branches.corrected.importCheck.matches = true;
  return verifyRefundReport(bad, caseConfig, capture);
}, 'import booleans do not replace imported identity');

const exportsRoot = path.join(ROOT, 'out/exports');
const bundles = fs.existsSync(exportsRoot)
  ? fs.readdirSync(exportsRoot).filter((name) => name.startsWith('refund-v1-')).map((name) => path.join(exportsRoot, name))
  : [];
for (const bundleDir of bundles) {
  assert.deepEqual(verifyBundle(bundleDir), []);
  console.log(`accepted: exported bundle hashes and evidence (${path.basename(bundleDir)})`);
  const relativeBundle = path.relative(ROOT, bundleDir);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-export-path-'));
  const tempBundle = path.join(tempRoot, relativeBundle);
  fs.mkdirSync(path.dirname(tempBundle), {recursive: true});
  fs.cpSync(bundleDir, tempBundle, {recursive: true});
  const manifestPath = path.join(tempBundle, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.capture.path = manifest.inputs.find((entry) => entry.role === 'input').path;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  assert.ok(verifyBundle(relativeBundle, {root: tempRoot}).some((error) => /capture path|case capture reference/.test(error)), 'tampered replay path must reject');
  console.log('rejected: manifest replay path outside verified inputs');

  const escapedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-export-escape-'));
  const escapedBundle = path.join(escapedRoot, relativeBundle);
  fs.mkdirSync(path.dirname(escapedBundle), {recursive: true});
  fs.cpSync(bundleDir, escapedBundle, {recursive: true});
  const escapedManifestPath = path.join(escapedBundle, 'manifest.json');
  const escapedManifest = JSON.parse(fs.readFileSync(escapedManifestPath, 'utf8'));
  escapedManifest.inputs[0].path = '../outside-input.json';
  fs.writeFileSync(escapedManifestPath, JSON.stringify(escapedManifest, null, 2) + '\n');
  assert.ok(verifyBundle(relativeBundle, {root: escapedRoot}).some((error) => /escapes bundle/.test(error)), 'escaped input path must reject');
  console.log('rejected: input path escapes the bundle');

  const swapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-export-swap-'));
  const swapBundle = path.join(swapRoot, relativeBundle);
  fs.mkdirSync(path.dirname(swapBundle), {recursive: true});
  fs.cpSync(bundleDir, swapBundle, {recursive: true});
  const swapManifestPath = path.join(swapBundle, 'manifest.json');
  const swapManifest = JSON.parse(fs.readFileSync(swapManifestPath, 'utf8'));
  const swapCase = JSON.parse(fs.readFileSync(path.join(swapBundle, 'case.json'), 'utf8'));
  swapManifest.candidate = {
    path: swapCase.candidates.corrected.wasm,
    sha256: swapCase.candidates.corrected.sha256,
    label: swapCase.candidates.corrected.label,
  };
  fs.writeFileSync(swapManifestPath, JSON.stringify(swapManifest, null, 2) + '\n');
  assert.ok(verifyBundle(relativeBundle, {root: swapRoot}).some((error) => /manifest candidate/.test(error)), 'fixed-for-bad manifest swap must reject');
  console.log('rejected: manifest candidate swapped to the corrected candidate');

  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-export-external-'));
  const externalBundle = path.join(externalRoot, relativeBundle);
  fs.mkdirSync(path.dirname(externalBundle), {recursive: true});
  fs.cpSync(bundleDir, externalBundle, {recursive: true});
  const externalCasePath = path.join(externalBundle, 'case.json');
  const externalCase = JSON.parse(fs.readFileSync(externalCasePath, 'utf8'));
  const outsideBytes = fs.readFileSync(path.join(ROOT, 'out', 'refund-capture.json'));
  externalCase.candidates.bad.wasm = 'out/refund-capture.json';
  externalCase.candidates.bad.sha256 = crypto.createHash('sha256').update(outsideBytes).digest('hex');
  fs.writeFileSync(externalCasePath, JSON.stringify(externalCase, null, 2) + '\n');
  assert.ok(verifyBundle(relativeBundle, {root: externalRoot}).some((error) => /escapes bundle|not a verified contained/.test(error)), 'external case candidate path must reject');
  console.log('rejected: case candidate path outside the bundle');
}
