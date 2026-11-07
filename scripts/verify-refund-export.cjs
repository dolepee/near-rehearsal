'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {validateCase, validateCapture, parseCaptureState} = require('./refund-three-way.cjs');
const {verifyRefundReport} = require('./verify-refund-report.cjs');

const ROOT = path.join(__dirname, '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function verifyBundle(bundleDir, options = {}) {
  const errors = [];
  const rootBase = path.resolve(options.root || ROOT);
  const root = path.resolve(rootBase, bundleDir);
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return [`missing manifest: ${manifestPath}`];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 'near-rehearsal/refund-export/v1') errors.push('unsupported export schema');
  if (!manifest.bundleId || typeof manifest.bundleId !== 'string') errors.push('missing bundleId');
  if (!Array.isArray(manifest.inputs) || !manifest.inputs.length) errors.push('missing input list');
  let unsafe = false;
  for (const entry of manifest.inputs || []) {
    const file = path.resolve(rootBase, entry.path);
    if (!file.startsWith(root + path.sep)) { errors.push(`input escapes bundle: ${entry.path}`); unsafe = true; continue; }
    if (!fs.existsSync(file)) { errors.push(`missing input: ${entry.path}`); unsafe = true; continue; }
    const bytes = fs.readFileSync(file);
    if (bytes.length !== entry.bytes) errors.push(`size mismatch: ${entry.path}`);
    if (sha256(bytes) !== entry.sha256) errors.push(`hash mismatch: ${entry.path}`);
  }
  if (unsafe) return errors;
  const caseEntry = (manifest.inputs || []).find((entry) => entry.role === 'case');
  const captureEntry = (manifest.inputs || []).find((entry) => entry.role === 'capture');
  const reportEntry = (manifest.inputs || []).find((entry) => entry.role === 'report');
  if (!caseEntry || !captureEntry || !reportEntry) {
    return [...errors, 'bundle needs case, capture and report inputs'];
  }
  if (manifest.case?.path !== caseEntry.path) errors.push('manifest case path does not identify the verified case input');
  if (manifest.capture?.path !== captureEntry.path) errors.push('manifest capture path does not identify the verified capture input');
  const casePath = path.resolve(rootBase, caseEntry.path);
  const capturePath = path.resolve(rootBase, captureEntry.path);
  const reportPath = path.resolve(rootBase, reportEntry.path);
  const config = validateCase(casePath);

  const containedInput = (reference, role, label) => {
    if (typeof reference !== 'string' || !reference) {
      errors.push(`${label} is missing`);
      return null;
    }
    const resolved = path.resolve(rootBase, reference);
    if (!resolved.startsWith(root + path.sep)) {
      errors.push(`${label} escapes bundle: ${reference}`);
      return null;
    }
    const entry = (manifest.inputs || []).find((item) => item.role === role && path.resolve(rootBase, item.path) === resolved);
    if (!entry) {
      errors.push(`${label} is not a verified contained ${role} input`);
      return null;
    }
    return {resolved, entry};
  };

  containedInput(config.baselineWasm, 'input', 'case baselineWasm');
  const badCandidateReference = containedInput(config.candidates.bad.wasm, 'input', 'case bad candidate');
  const correctedCandidateReference = containedInput(config.candidates.corrected.wasm, 'input', 'case corrected candidate');
  const captureReference = containedInput(config.capture, 'capture', 'case capture');
  if (captureReference && captureReference.resolved !== capturePath) errors.push('case capture reference does not resolve to the verified capture input');
  if (badCandidateReference && (badCandidateReference.entry.sha256 !== config.candidates.bad.sha256 || badCandidateReference.entry.bytes !== fs.statSync(badCandidateReference.resolved).size)) errors.push('case bad candidate does not match its verified input');
  if (correctedCandidateReference && (correctedCandidateReference.entry.sha256 !== config.candidates.corrected.sha256 || correctedCandidateReference.entry.bytes !== fs.statSync(correctedCandidateReference.resolved).size)) errors.push('case corrected candidate does not match its verified input');

  const candidateEntry = containedInput(manifest.candidate?.path, 'input', 'manifest candidate');
  if (candidateEntry && candidateEntry.entry.sha256 !== manifest.candidate?.sha256) errors.push('manifest candidate hash does not match its verified input');
  if (candidateEntry && candidateEntry.resolved !== badCandidateReference?.resolved) errors.push('manifest candidate is not the case bad candidate');
  if (manifest.candidate?.sha256 !== config.candidates.bad.sha256) errors.push('manifest candidate hash does not match the case bad candidate');
  if (manifest.candidate?.label !== config.candidates.bad.label) errors.push('manifest candidate label does not match the case bad candidate');

  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  try { validateCapture(capture, config); } catch (error) { errors.push(`capture invalid: ${error.message}`); }
  const reportErrors = verifyRefundReport(report, config, capture);
  errors.push(...reportErrors);
  if (JSON.stringify(report.operation) !== JSON.stringify(config.operation)) errors.push('report operation does not match the case operation');
  for (const name of ['bad', 'corrected']) {
    const expected = config.candidates[name];
    const branch = report.branches?.[name];
    if (branch?.candidateSha256 !== expected.sha256) errors.push(`report ${name} candidate bytes do not match the case candidate`);
    if (branch?.candidateLabel !== expected.label) errors.push(`report ${name} candidate label does not match the case candidate`);
  }
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
