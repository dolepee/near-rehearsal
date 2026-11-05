'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {validateCase, validateCapture, parseCaptureState} = require('./refund-three-way.cjs');
const {verifyRefundReport} = require('./verify-refund-report.cjs');

const ROOT = path.join(__dirname, '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function verifyBundle(bundleDir) {
  const errors = [];
  const root = path.resolve(ROOT, bundleDir);
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return [`missing manifest: ${manifestPath}`];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 'near-rehearsal/refund-export/v1') errors.push('unsupported export schema');
  if (!manifest.bundleId || typeof manifest.bundleId !== 'string') errors.push('missing bundleId');
  if (!Array.isArray(manifest.inputs) || !manifest.inputs.length) errors.push('missing input list');
  for (const entry of manifest.inputs || []) {
    const file = path.resolve(ROOT, entry.path);
    if (!file.startsWith(root + path.sep)) { errors.push(`input escapes bundle: ${entry.path}`); continue; }
    if (!fs.existsSync(file)) { errors.push(`missing input: ${entry.path}`); continue; }
    const bytes = fs.readFileSync(file);
    if (bytes.length !== entry.bytes) errors.push(`size mismatch: ${entry.path}`);
    if (sha256(bytes) !== entry.sha256) errors.push(`hash mismatch: ${entry.path}`);
  }
  const caseEntry = (manifest.inputs || []).find((entry) => entry.role === 'case');
  const captureEntry = (manifest.inputs || []).find((entry) => entry.role === 'capture');
  const reportEntry = (manifest.inputs || []).find((entry) => entry.role === 'report');
  if (!caseEntry || !captureEntry || !reportEntry) {
    return [...errors, 'bundle needs case, capture and report inputs'];
  }
  if (manifest.case?.path !== caseEntry.path) errors.push('manifest case path does not identify the verified case input');
  if (manifest.capture?.path !== captureEntry.path) errors.push('manifest capture path does not identify the verified capture input');
  const candidateEntry = (manifest.inputs || []).find((entry) => entry.role === 'input' && entry.path === manifest.candidate?.path);
  if (!candidateEntry) errors.push('manifest candidate path is not a verified contained input');
  if (candidateEntry && candidateEntry.sha256 !== manifest.candidate?.sha256) errors.push('manifest candidate hash does not match its verified input');
  const casePath = path.resolve(ROOT, caseEntry.path);
  const capturePath = path.resolve(ROOT, captureEntry.path);
  const reportPath = path.resolve(ROOT, reportEntry.path);
  const config = validateCase(casePath);
  if (path.resolve(ROOT, config.capture) !== capturePath) errors.push('case capture reference does not resolve to the verified capture input');
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  try { validateCapture(capture, config); } catch (error) { errors.push(`capture invalid: ${error.message}`); }
  const reportErrors = verifyRefundReport(report, config, capture);
  errors.push(...reportErrors);
  if (manifest.case?.id !== config.id) errors.push('manifest case id mismatch');
  if (manifest.case?.sha256 !== caseEntry.sha256) errors.push('manifest case hash mismatch');
  if (manifest.capture?.sha256 !== captureEntry.sha256) errors.push('manifest capture hash mismatch');
  if (manifest.report?.sha256 !== reportEntry.sha256) errors.push('manifest report hash mismatch');
  if (JSON.stringify(manifest.report?.result) !== JSON.stringify(report.result)) errors.push('manifest result mismatch');
  if (manifest.runtimePin?.version !== config.runtimePin.version) errors.push('manifest runtime version mismatch');
  if (String(manifest.runtimePin?.protocolVersion) !== String(config.runtimePin.protocolVersion)) errors.push('manifest runtime protocol mismatch');
  if (manifest.runtimePin?.commit !== config.runtimePin.commit) errors.push('manifest runtime commit mismatch');
  if (manifest.capture?.codeHash !== capture.codeHash) errors.push('manifest code hash mismatch');
  if (manifest.capture?.codeSha256 !== capture.codeSha256) errors.push('manifest code SHA mismatch');
  if (manifest.capture?.beneficiary !== parseCaptureState(capture).beneficiary) errors.push('manifest beneficiary mismatch');
  if (manifest.capture?.entitlement !== capture.entitlement) errors.push('manifest entitlement mismatch');
  if (manifest.boundary !== config.boundary) errors.push('manifest boundary mismatch');
  return errors;
}

if (require.main === module) {
  const bundleDir = process.argv[2];
  if (!bundleDir) {
    console.error('usage: node scripts/verify-refund-export.cjs <bundle-dir>');
    process.exitCode = 2;
  } else {
    try {
      const errors = verifyBundle(bundleDir);
      if (errors.length) {
        console.error(JSON.stringify({ok: false, errors}, null, 2));
        process.exitCode = 1;
      } else {
        console.log(JSON.stringify({ok: true, status: 'verified', bundle: bundleDir}, null, 2));
      }
    } catch (error) {
      console.error(JSON.stringify({ok: false, errors: [error.message]}, null, 2));
      process.exitCode = 1;
    }
  }
}

module.exports = {verifyBundle};
