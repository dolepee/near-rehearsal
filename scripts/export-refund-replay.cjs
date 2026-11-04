'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {validateCase, validateCapture, parseCaptureState} = require('./refund-three-way.cjs');
const {verifyRefundReport} = require('./verify-refund-report.cjs');

const ROOT = path.join(__dirname, '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const reportPath = path.resolve(ROOT, arg('--report', 'out/refund-report.json'));
const casePath = path.resolve(ROOT, arg('--case', 'cases/refund-v1/case.json'));
const capturePath = path.resolve(ROOT, arg('--capture', 'out/refund-capture.json'));
const outRoot = path.resolve(ROOT, arg('--out', 'out/exports'));
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), {recursive: true}); fs.copyFileSync(from, to); };
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const fileEntry = (file, role) => {
  const bytes = fs.readFileSync(file);
  return {path: rel(file), role, bytes: bytes.length, sha256: sha256(bytes)};
};

try {
  const config = validateCase(casePath);
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const errors = verifyRefundReport(report, config, capture);
  if (errors.length) {
    console.error(JSON.stringify({ok: false, errors}, null, 2));
    process.exitCode = 1;
    process.exit();
  }

  const reportBytes = fs.readFileSync(reportPath);
  const bundleId = `refund-v1-${sha256(reportBytes).slice(0, 12)}`;
  const bundleDir = path.join(outRoot, bundleId);
  fs.rmSync(bundleDir, {recursive: true, force: true});
  fs.mkdirSync(bundleDir, {recursive: true});

  const bundleCase = {
    ...config,
    capture: `${rel(bundleDir)}/capture.json`,
    baselineWasm: `${rel(bundleDir)}/inputs/refund-v1.wasm`,
    candidates: {
      bad: {...config.candidates.bad, wasm: `${rel(bundleDir)}/inputs/refund-v2-bad.wasm`},
      corrected: {...config.candidates.corrected, wasm: `${rel(bundleDir)}/inputs/refund-v2-fixed.wasm`},
    },
  };
  fs.writeFileSync(path.join(bundleDir, 'case.json'), json(bundleCase));
  fs.writeFileSync(path.join(bundleDir, 'capture.json'), json(capture));
  fs.writeFileSync(path.join(bundleDir, 'report.json'), json(report));
  for (const [name, file] of [
    ['refund-v1.wasm', config.baselineWasm],
    ['refund-v1.wat', 'contracts/refund-v1.wat'],
    ['refund-v2-bad.wasm', config.candidates.bad.wasm],
    ['refund-v2-bad.wat', 'contracts/refund-v2-bad.wat'],
    ['refund-v2-fixed.wasm', config.candidates.corrected.wasm],
    ['refund-v2-fixed.wat', 'contracts/refund-v2-fixed.wat'],
  ]) copy(path.resolve(ROOT, file), path.join(bundleDir, 'inputs', name));

  const inputs = [
    fileEntry(path.join(bundleDir, 'case.json'), 'case'),
    fileEntry(path.join(bundleDir, 'capture.json'), 'capture'),
    fileEntry(path.join(bundleDir, 'report.json'), 'report'),
    ...['refund-v1.wasm', 'refund-v1.wat', 'refund-v2-bad.wasm', 'refund-v2-bad.wat', 'refund-v2-fixed.wasm', 'refund-v2-fixed.wat']
      .map((name) => fileEntry(path.join(bundleDir, 'inputs', name), 'input')),
  ];
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: ROOT, encoding: 'utf8'}).trim();
  const manifest = {
    schema: 'near-rehearsal/refund-export/v1',
    bundleId,
    createdAt: new Date().toISOString(),
    sourceCommit,
    case: {id: config.id, path: rel(path.join(bundleDir, 'case.json')), sha256: inputs.find((x) => x.role === 'case').sha256},
    capture: {
      path: rel(path.join(bundleDir, 'capture.json')),
      sha256: inputs.find((x) => x.role === 'capture').sha256,
      codeHash: capture.codeHash,
      codeSha256: capture.codeSha256,
      stateHash: capture.stateHash,
      beneficiary: parseCaptureState(capture).beneficiary,
      entitlement: capture.entitlement,
    },
    report: {
      path: rel(path.join(bundleDir, 'report.json')),
      sha256: inputs.find((x) => x.role === 'report').sha256,
      generatedAt: report.generatedAt,
      result: report.result,
    },
    runtimePin: config.runtimePin,
    boundary: config.boundary,
    inputs,
    command: `node scripts/replay-refund-export.cjs ${rel(bundleDir)}`,
    verifyCommand: `node scripts/verify-refund-export.cjs ${rel(bundleDir)}`,
  };
  fs.writeFileSync(path.join(bundleDir, 'manifest.json'), json(manifest));
  fs.writeFileSync(path.join(bundleDir, 'README.md'), `# Verified refund rehearsal export

This is a local-Sandbox, authored seeded-migration export. It is not a public-chain capture, production upgrade authorization, or custody claim.

## Verify the bundle

\`\`\`sh
${manifest.verifyCommand}
\`\`\`

## Rerun and verify independently

\`\`\`sh
${manifest.command}
\`\`\`

The rerun starts from the capture in this bundle and executes baseline, seeded bad, and corrected branches against a fresh local Sandbox. It writes a fresh report and verifies it; it does not trust the bundled evidence as a result.

Runtime pin: \`${config.runtimePin.version}\` / protocol \`${config.runtimePin.protocolVersion}\` / commit \`${config.runtimePin.commit}\`.

Source commit at export: \`${sourceCommit}\`.
`);
  const sums = inputs.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n';
  fs.writeFileSync(path.join(bundleDir, 'SHA256SUMS'), sums);
  console.log(JSON.stringify({ok: true, bundle: rel(bundleDir), manifest: manifest.manifestPath || null, command: manifest.command, verifyCommand: manifest.verifyCommand}, null, 2));
} catch (error) {
  console.error(JSON.stringify({ok: false, errors: [error.message]}, null, 2));
  process.exitCode = 1;
}
