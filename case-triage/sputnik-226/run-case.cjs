'use strict';
/*
 * Fixed-case runner for the Sputnik #226 pilot.
 *
 * It verifies the recorded reference packet and supplied artifacts first, then
 * executes the existing node-harness in a new output directory. It never
 * rewrites the recorded packet and never treats the reference/native run as a
 * new execution.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {verifyPacket} = require('./review-packet/packet-model.cjs');

const here = __dirname;
const packetDir = path.join(here, 'review-packet');
const harness = path.join(here, 'node-harness.cjs');
const args = process.argv.slice(2);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const oneNear = 1000000000000000000000000n;

function valueOf(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function help() {
  console.log(`Usage: node case-triage/sputnik-226/run-case.cjs --sandbox-dir <pinned-dir> [--out <new-output-dir>]

Runs the fixed Sputnik #226 pilot with the supplied source-built WASMs.
The sandbox directory must contain the near-sandbox executable used by the
patched Node binding. The runtime must report version 2.6.2.

The reference packet is verified before execution and remains recorded.
A fresh run writes node-evidence.json and run.json into a new output directory.
Existing output directories are never overwritten.`);
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function findRuntime(dir) {
  const absolute = path.resolve(dir);
  requireValue(fs.existsSync(absolute) && fs.statSync(absolute).isDirectory(), `sandbox directory not found: ${absolute}`);
  const preferred = path.join(absolute, 'near-sandbox');
  const candidates = [preferred, ...fs.readdirSync(absolute).filter((name) => name === 'near-sandbox' || /^near-sandbox(?:\.exe)?$/.test(name)).map((name) => path.join(absolute, name))];
  const binary = [...new Set(candidates)].find((file) => fs.existsSync(file) && fs.statSync(file).isFile() && (fs.statSync(file).mode & 0o111));
  requireValue(binary, `no executable near-sandbox found in ${absolute}`);
  return {dir: absolute, binary};
}

function runtimeVersion(runtime) {
  const result = spawnSync(runtime.binary, ['--version'], {encoding: 'utf8', timeout: 15000});
  const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
  requireValue(!result.error && result.status === 0, `runtime --version failed: ${result.error?.message || text || 'no output'}`);
  requireValue(/\b2\.6\.2\b/.test(text), `runtime does not report 2.6.2: ${text || 'no output'}`);
  return {version: '2.6.2', sha256: sha256(fs.readFileSync(runtime.binary)), versionText: text};
}

function readArtifacts() {
  const artifactsPath = path.join(packetDir, 'evidence', 'artifacts.json');
  const artifacts = JSON.parse(fs.readFileSync(artifactsPath, 'utf8'));
  return {
    base: {...artifacts.base, path: path.join(packetDir, 'evidence', artifacts.base.path)},
    candidate: {...artifacts.candidate, path: path.join(packetDir, 'evidence', artifacts.candidate.path)},
    build: artifacts.build,
    boundary: artifacts.boundary,
  };
}

function validateArtifacts(artifacts) {
  for (const [name, artifact] of [['base', artifacts.base], ['candidate', artifacts.candidate]]) {
    requireValue(fs.existsSync(artifact.path), `missing ${name} WASM: ${artifact.path}`);
    const bytes = fs.readFileSync(artifact.path);
    requireValue(sha256(bytes) === artifact.sha256, `${name} WASM hash mismatch`);
    requireValue(bytes.length === artifact.bytes, `${name} WASM byte count mismatch`);
  }
}

function validateFresh(node, artifacts) {
  requireValue(node.status === 'passed' && node.stage === 'complete', 'fresh execution is not a complete pass');
  requireValue(node.mode === 'local-configured-factory-update', 'fresh execution mode mismatch');
  requireValue(node.governanceUpgradeSelf === false && node.callbackFlow === false, 'fresh execution crossed the governance/callback boundary');
  requireValue(node.inputs?.baseSha256 === artifacts.base.sha256, 'fresh execution used a different base WASM');
  requireValue(node.inputs?.candidateSha256 === artifacts.candidate.sha256, 'fresh execution used a different candidate WASM');
  requireValue(node.codeSha256 === artifacts.candidate.sha256, 'fresh execution deployed a different candidate code hash');
  requireValue(JSON.stringify(node.configBefore) === JSON.stringify(node.configAfter), 'fresh execution changed DAO config');
  requireValue(node.proposalBefore?.status === 'InProgress' && node.proposalAfterUpgrade?.status === 'InProgress', 'fresh proposal did not survive the upgrade');
  requireValue(node.proposalAfter?.status === 'Approved', 'fresh proposal was not approved');
  requireValue(node.proposalAfter?.votes?.['test.near'] === 'Approve', 'fresh root vote did not persist');
  for (const retry of ['duplicateApproval', 'finalizeRetry']) {
    requireValue(node.replay?.[retry]?.transactionFailed === true && node.replay?.[retry]?.secondTransfer === false, `fresh ${retry} was not a rejected no-transfer retry`);
  }
  const recipient = node.recipient || {};
  requireValue(BigInt(recipient.delta) === oneNear, 'fresh first payment is not exactly 1 NEAR');
  requireValue(BigInt(recipient.afterReplay) === BigInt(recipient.after), 'fresh duplicate approval caused a second transfer');
  requireValue(BigInt(recipient.afterFinalizeRetry) === BigInt(recipient.after), 'fresh Finalize retry caused a second transfer');
  requireValue(BigInt(recipient.deltaTotal) === oneNear, 'fresh total recipient delta is not exactly 1 NEAR');
  const finality = node.finality || {};
  for (const stage of ['deploy', 'init', 'add-proposal', 'update', 'approve', 'replay', 'finalize-retry']) {
    requireValue(finality[stage]?.target > 0 && finality[stage]?.finalized >= finality[stage].target, `fresh finality barrier missing for ${stage}`);
  }
}

function writeRun(outDir, value) {
  fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(value, null, 2) + '\n');
}

function main() {
  if (args.includes('--help') || args.includes('-h')) {
    help();
    return;
  }
  const sandboxArg = valueOf('--sandbox-dir');
  requireValue(sandboxArg, '--sandbox-dir <pinned-dir> is required');
  const outArg = valueOf('--out');
  const outDir = outArg ? path.resolve(outArg) : path.join(here, 'runs', new Date().toISOString().replace(/[:.]/g, '-') + `-${process.pid}`);

  // The reference packet is checked before execution and is never mutated.
  verifyPacket(packetDir);
  const artifacts = readArtifacts();
  validateArtifacts(artifacts);

  requireValue(!fs.existsSync(outDir), `output already exists; refusing to overwrite: ${outDir}`);
  const runtime = findRuntime(sandboxArg);
  const version = runtimeVersion(runtime);

  fs.mkdirSync(path.dirname(outDir), {recursive: true});
  fs.mkdirSync(outDir, {recursive: false});
  const evidencePath = path.join(outDir, 'node-evidence.json');
  const meta = {
    schema: 'near-rehearsal/pilot/sputnik-226-fresh-run/v1',
    mode: 'fresh-local-execution',
    referencePacket: 'recorded case review; not re-executed by this command',
    status: 'running',
    startedAt: new Date().toISOString(),
    scope: 'local configured-factory upgrade; historical source; locally constructed state; two tested retry routes; not mainnet or universal exactly-once',
    runtime: {dir: runtime.dir, binary: runtime.binary, version: version.version, sha256: version.sha256, versionText: version.versionText},
    artifacts: {base: artifacts.base.sha256, candidate: artifacts.candidate.sha256},
    evidence: evidencePath,
  };
  writeRun(outDir, meta);
  console.log(`Reference packet verified (recorded; not the fresh execution).`);
  console.log(`Fresh run output: ${outDir}`);
  console.log(`Runtime: ${version.version} sha256 ${version.sha256}`);

  const child = spawnSync(process.execPath, [harness], {
    cwd: here,
    encoding: 'utf8',
    timeout: 180000,
    env: {
      ...process.env,
      BASE_WASM: artifacts.base.path,
      BASE_WASM_SHA256: artifacts.base.sha256,
      CANDIDATE_WASM: artifacts.candidate.path,
      CANDIDATE_WASM_SHA256: artifacts.candidate.sha256,
      NODE_SANDBOX_BIN_DIR: runtime.dir,
      EVIDENCE_PATH: evidencePath,
    },
  });
  if (child.status !== 0) {
    meta.status = 'failed';
    meta.finishedAt = new Date().toISOString();
    meta.error = child.error?.message || child.stderr?.trim() || `node-harness exited ${child.status}`;
    writeRun(outDir, meta);
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    throw new Error(`fresh execution failed; evidence: ${evidencePath}`);
  }

  requireValue(fs.existsSync(evidencePath), `fresh execution produced no evidence: ${evidencePath}`);
  const fresh = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  try {
    validateFresh(fresh, artifacts);
  } catch (error) {
    meta.status = 'failed';
    meta.finishedAt = new Date().toISOString();
    meta.error = error.message;
    writeRun(outDir, meta);
    throw new Error(`${error.message}; evidence: ${evidencePath}`);
  }

  meta.status = 'passed';
  meta.finishedAt = new Date().toISOString();
  meta.evidenceSha256 = sha256(fs.readFileSync(evidencePath));
  writeRun(outDir, meta);
  console.log(`Fresh evidence: ${evidencePath}`);
  console.log(`Fresh run metadata: ${path.join(outDir, 'run.json')}`);
  console.log('Scope: local configured-factory upgrade; historical source; locally constructed state; two tested retry routes.');
  console.log('The recorded reviewer packet was not modified or presented as this run.');
}

try {
  main();
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
}
