'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {verifyBundle} = require('./verify-refund-export.cjs');
const {validateCase} = require('./refund-three-way.cjs');
const {verifyRefundReport} = require('./verify-refund-report.cjs');

const ROOT = path.join(__dirname, '..');

const bundleDir = process.argv[2];
if (!bundleDir) {
  console.error('usage: node scripts/replay-refund-export.cjs <bundle-dir>');
  process.exit(2);
}
const bundle = path.resolve(ROOT, bundleDir);
try {
  const bundleErrors = verifyBundle(bundle);
  if (bundleErrors.length) {
    console.error(JSON.stringify({ok: false, stage: 'bundle-verification', errors: bundleErrors}, null, 2));
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  const casePath = path.resolve(ROOT, manifest.case.path);
  const capturePath = path.resolve(ROOT, manifest.capture.path);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'near-refund-replay-'));
  const replayReport = path.join(temp, 'report.json');
  const config = validateCase(casePath);
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));

  const child = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/refund-three-way.cjs'),
    '--case', casePath,
    '--report', replayReport,
  ], {
    cwd: ROOT,
    env: {...process.env},
    stdio: 'inherit',
    timeout: 900000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    console.error(JSON.stringify({ok: false, stage: 'replay', exitCode: child.status, errors: ['replay runner failed']}, null, 2));
    process.exit(child.status || 1);
  }
  const report = JSON.parse(fs.readFileSync(replayReport, 'utf8'));
  const errors = verifyRefundReport(report, config, capture);
  if (errors.length) {
    console.error(JSON.stringify({ok: false, stage: 'report-verification', errors}, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    status: 'replayed-and-verified',
    bundle: path.relative(ROOT, bundle),
    report: replayReport,
    result: report.result,
    transactions: {
      baseline: report.branches.baseline.claim.transactionHash,
      bad: report.branches.bad.claim.transactionHash,
      corrected: report.branches.corrected.claim.transactionHash,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ok: false, stage: 'exception', errors: [error.message]}, null, 2));
  process.exit(1);
}
