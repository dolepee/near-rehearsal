'use strict';
/*
 * Portable helper for a downloaded Sputnik export JSON.
 * Does not execute command strings embedded in the export.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const RUNNER = path.join(HERE, 'local-three-branch.cjs');
const VERIFIER = path.join(HERE, 'verify-local-three.cjs');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const fail = (m) => { throw new Error(m); };
const args = process.argv.slice(2);
const command = args.shift();
const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const exportArg = valueOf('--export');
const outArg = valueOf('--out');
const sandboxArg = valueOf('--sandbox-dir') || process.env.NEAR_SANDBOX_BINARY_PATH || process.env.NEAR_SANDBOX_BIN_PATH || '';
if (!['verify', 'replay'].includes(command) || !exportArg) {
  console.error('usage: node export-helper.cjs verify|replay --export <export.json> [--out <new-dir>] [--sandbox-dir <dir>]');
  process.exit(2);
}
const exportPath = path.resolve(exportArg);
const exportDoc = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
if (exportDoc.schema !== 'near-rehearsal/sputnik-export/v2') fail('unsupported export schema');
const outDir = path.resolve(outArg || fs.mkdtempSync(path.join(os.tmpdir(), 'sputnik-export-')));
const out = path.join(outDir, 'out');
if (fs.existsSync(outDir)) {
  if (!fs.statSync(outDir).isDirectory()) fail('output path exists and is not a directory');
  if (fs.readdirSync(outDir).length) fail('output directory is not empty; refusing to overwrite earlier proof');
}
fs.mkdirSync(out, {recursive: true});

function bytes(role) {
  const item = exportDoc[role];
  if (!item || typeof item.bytesBase64 !== 'string') fail(`export ${role} bytes missing`);
  const b = Buffer.from(item.bytesBase64, 'base64');
  if (sha256(b) !== item.sha256) fail(`export ${role} sha256 mismatch`);
  return b;
}
const candidate = bytes('candidate');
const correction = bytes('correction');
if (!exportDoc.inputManifest || !exportDoc.frozenBundle || !exportDoc.report) fail('export is missing manifest, frozen state or report');
if (exportDoc.inputManifest.candidate.sha256 !== exportDoc.candidate.sha256) fail('candidate manifest mismatch');
if (exportDoc.inputManifest.correction.sha256 !== exportDoc.correction.sha256) fail('correction manifest mismatch');
const transfer = exportDoc.frozenBundle?.proposal?.kind?.Transfer;
if (!transfer) fail('export frozen proposal has no Transfer obligation');
if (exportDoc.obligation) {
  if (String(exportDoc.obligation.amount) !== String(transfer.amount)) fail('declared transfer amount mismatch');
  if (exportDoc.obligation.recipient !== transfer.receiver_id) fail('declared transfer recipient mismatch');
  if (String(exportDoc.obligation.proposalId) !== String(exportDoc.frozenBundle.proposal.id)) fail('declared proposal id mismatch');
}
const reportRaw = json(exportDoc.report);
if (exportDoc.reportSha256 && sha256(reportRaw) !== exportDoc.reportSha256) fail('export report sha256 mismatch');
if (exportDoc.verdict && exportDoc.verdictSha256 && sha256(json(exportDoc.verdict)) !== exportDoc.verdictSha256) fail('export verdict sha256 mismatch');
fs.writeFileSync(path.join(outDir, 'candidate.wasm'), candidate);
fs.writeFileSync(path.join(outDir, 'correction.wasm'), correction);
fs.writeFileSync(path.join(out, 'candidate.wasm'), candidate);
fs.writeFileSync(path.join(out, 'correction.wasm'), correction);
fs.writeFileSync(path.join(out, 'input-manifest.json'), json(exportDoc.inputManifest));
fs.writeFileSync(path.join(out, 'local-frozen-bundle.json'), json(exportDoc.frozenBundle));
fs.writeFileSync(path.join(out, 'local-three-branch.json'), json(exportDoc.report));
if (exportDoc.verdict) fs.writeFileSync(path.join(out, 'local-three-verdict.json'), json(exportDoc.verdict));

function verify(targetDir) {
  const p = spawnSync(process.execPath, [VERIFIER], {cwd: ROOT, env: {...process.env, CASE_DIR: targetDir}, encoding: 'utf8', timeout: 60000});
  if (p.status !== 0) fail((p.stderr || p.stdout || 'shared verifier rejected export').trim().slice(-3000));
  process.stdout.write(p.stdout);
  return JSON.parse(p.stdout);
}
if (command === 'verify') {
  verify(outDir);
  console.log(`verified export in ${outDir}`);
  process.exit(0);
}

// Replay from the unpacked frozen bundle and actual submitted bytes, not from the export's command text.
if (!sandboxArg) fail('replay requires --sandbox-dir <directory containing near-sandbox> or NEAR_SANDBOX_BINARY_PATH');
const sandboxDir = path.resolve(sandboxArg);
const replayRoot = path.join(outDir, 'replay');
const replayOut = path.join(replayRoot, 'out');
fs.mkdirSync(replayOut, {recursive: true});
const nodePath = [process.env.NODE_PATH, path.join(ROOT, 'node_modules'), path.join(ROOT, '..', 'qdee-repo', 'node_modules')].filter(Boolean).join(path.delimiter);
const env = {
  ...process.env,
  NODE_PATH: nodePath,
  NEAR_SANDBOX_BIN_PATH: sandboxDir,
  NEAR_SANDBOX_BINARY_PATH: sandboxDir,
  NODE_SANDBOX_BIN_DIR: sandboxDir,
  SPUTNIK_OUT_DIR: replayOut,
  USE_FROZEN: '1',
  FROZEN_BUNDLE: path.join(out, 'local-frozen-bundle.json'),
  CANDIDATE_WASM: path.join(outDir, 'candidate.wasm'),
  CORRECTED_WASM: path.join(outDir, 'correction.wasm'),
  CANDIDATE_WASM_SHA256: exportDoc.candidate.sha256,
  CORRECTED_WASM_SHA256: exportDoc.correction.sha256,
  CANDIDATE_LABEL: exportDoc.candidate.label,
  CANDIDATE_PROVENANCE: exportDoc.candidate.provenance,
  CORRECTED_LABEL: exportDoc.correction.label,
  CORRECTED_PROVENANCE: exportDoc.correction.provenance,
};
const p = spawnSync(process.execPath, [RUNNER], {cwd: ROOT, env, encoding: 'utf8', timeout: 15 * 60 * 1000});
if (p.stdout) process.stdout.write(p.stdout);
if (p.stderr) process.stderr.write(p.stderr);
if (p.status !== 0) fail(`replay runner exited ${p.status}`);
verify(replayRoot);
console.log(`replayed export in ${replayRoot}`);
