'use strict';
/*
 * Controller-owned candidate pipeline:
 * validate patch -> clean apply -> build -> replay -> acceptance.
 *
 * The model supplies only a patch. This script creates the applied tree,
 * built artifact, replay report and candidate identity; it never reads an
 * authored repaired report as the candidate report.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {materializeAppliedTree, verifyPatchInTree} = require('./repair-controller.cjs');
const {makeIdentity} = require('./candidate-identity.cjs');
const {verify} = require('./acceptance.cjs');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const MANIFEST = path.join(HERE, 'controller-manifest.json');
const ISSUE238 = path.join(HERE, 'issue238-local.cjs');
const AUTHORED_BASE = path.join(HERE, 'out', 'issue238-local.json');

function usage() {
  return [
    'usage: node repair-pipeline.cjs --patch <diff> --source <pinned-tree> --out <dir>',
    '',
    'Runs controller validation, clean apply, build, Sandbox replay and acceptance.',
    'The candidate report is written under --out; authored reports are not overwritten.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
    else if (argv[i] === '--patch') opts.patch = path.resolve(argv[++i]);
    else if (argv[i] === '--source') opts.source = path.resolve(argv[++i]);
    else if (argv[i] === '--out') opts.out = path.resolve(argv[++i]);
    else if (argv[i] === '--base-report') opts.baseReport = path.resolve(argv[++i]);
    else if (argv[i] === '--provenance') opts.provenance = path.resolve(argv[++i]);
    else if (argv[i] === '--sandbox-dir') opts.sandboxDir = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return opts;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: {...process.env, ...(options.env || {})},
    encoding: 'utf8',
    timeout: options.timeout || 15 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function resolveCargo(manifest) {
  if (process.env.CARGO && fs.existsSync(process.env.CARGO)) return process.env.CARGO;
  const which = run('sh', ['-c', 'command -v cargo']);
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const roots = [process.env.RUSTUP_HOME, path.join(os.homedir(), '.rustup'), '/workspace/.rustup'].filter(Boolean);
  const wanted = manifest?.toolchain?.rust || '';
  for (const root of roots) {
    const toolchains = path.join(root, 'toolchains');
    if (!fs.existsSync(toolchains)) continue;
    const names = fs.readdirSync(toolchains).filter((name) => name.startsWith(`${wanted}-`)).sort();
    for (const name of names) {
      const candidate = path.join(toolchains, name, 'bin', 'cargo');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function writeLog(file, result) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, [
    `exit=${result.status}`,
    '--- stdout',
    result.stdout || '',
    '--- stderr',
    result.stderr || '',
  ].join('\n'));
}

function cargoEnv(manifest) {
  const cargo = resolveCargo(manifest);
  if (!cargo) throw new Error('no cargo binary found; set CARGO to the pinned toolchain');
  const bin = path.dirname(cargo);
  const rustupHome = process.env.RUSTUP_HOME || path.resolve(bin, '..', '..', '..');
  const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  return {
    CARGO: cargo,
    PATH: `${bin}:${process.env.PATH || ''}`,
    RUSTUP_HOME: rustupHome,
    CARGO_HOME: cargoHome,
  };
}

function sandboxEnv(manifest, requestedDir) {
  const version = manifest?.localRuntime?.sandbox;
  if (!version) throw new Error('build manifest does not declare a Sandbox version');
  const dir = requestedDir || [
    `/workspace/tools/near-sandbox-${version}-wrapper`,
    `/workspace/tools/near-sandbox-${version.replace(/\.0$/, '')}-wrapper`,
  ].find((candidate) => fs.existsSync(path.join(candidate, 'near-sandbox')));
  if (!dir) throw new Error(`pinned Sandbox ${version} wrapper was not found`);
  return {
    NEAR_SANDBOX_VERSION: version,
    NEAR_SANDBOX_BIN_PATH: dir,
    NEAR_SANDBOX_BINARY_PATH: dir,
    SANDBOX_DIR: dir,
  };
}

function runPipeline({patch, source, out, baseReport = AUTHORED_BASE, provenance = null, sandboxDir = null} = {}) {
  if (!patch || !source || !out) throw new Error('--patch, --source and --out are required');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const buildManifest = JSON.parse(fs.readFileSync(path.join(HERE, 'build-manifest.json'), 'utf8'));
  const patchText = fs.readFileSync(patch, 'utf8');
  const allowed = manifest.allowedPaths || [];
  if (allowed.length !== 1) throw new Error('pipeline requires exactly one allowlisted source file');
  fs.mkdirSync(out, {recursive: true});
  if (fs.existsSync(path.join(out, 'pipeline.json'))) throw new Error('refusing to overwrite an existing pipeline result');
  const appliedDir = path.join(out, 'applied');
  const replayDir = path.join(out, 'replay');
  if (fs.existsSync(appliedDir) || fs.existsSync(replayDir)) throw new Error('applied or replay directory already exists');

  const staticAndApply = verifyPatchInTree(patchText, manifest, source);
  if (staticAndApply.errors.length) throw new Error(`patch guard rejected: ${staticAndApply.errors.join('; ')}`);
  const applied = materializeAppliedTree(patchText, source, appliedDir);
  if (JSON.stringify(applied.changedPaths) !== JSON.stringify([allowed[0]])) {
    throw new Error(`applied paths differ from allowlist: ${JSON.stringify(applied.changedPaths)}`);
  }
  const appliedSource = path.join(appliedDir, allowed[0]);
  if (!fs.existsSync(appliedSource)) throw new Error('applied allowlisted source is missing');

  const build = run('sh', ['-c', manifest.build.command], {
    cwd: appliedDir,
    timeout: 20 * 60 * 1000,
    env: cargoEnv(buildManifest),
  });
  writeLog(path.join(out, 'build.log'), build);
  if (build.status !== 0) throw new Error(`candidate build failed with exit ${build.status}; see build.log`);
  const wasm = path.join(appliedDir, buildManifest.build.artifact);
  if (!fs.existsSync(wasm)) throw new Error(`candidate build produced no ${buildManifest.build.artifact}`);

  const replay = run(process.execPath, [ISSUE238], {
    cwd: ROOT,
    timeout: 20 * 60 * 1000,
    env: {
      ...sandboxEnv(buildManifest, sandboxDir),
      SPUTNIK_WASM: wasm,
      SPUTNIK_SOURCE_SHA: manifest.source.commit,
      SPUTNIK_OUT_DIR: replayDir,
    },
  });
  writeLog(path.join(out, 'replay.log'), replay);
  if (replay.status !== 0) throw new Error(`candidate replay failed with exit ${replay.status}; see replay.log`);
  const candidateReportPath = path.join(replayDir, 'issue238-local.json');
  if (!fs.existsSync(candidateReportPath)) throw new Error('candidate replay produced no report');

  const identity = makeIdentity({
    patch,
    source: appliedSource,
    wasm,
    sourcePath: allowed[0],
    commit: manifest.source.commit,
    manifestPath: MANIFEST,
  });
  const identityPath = path.join(out, 'candidate-identity.json');
  fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);

  const base = JSON.parse(fs.readFileSync(baseReport, 'utf8'));
  const candidate = JSON.parse(fs.readFileSync(candidateReportPath, 'utf8'));
  const errors = verify(base, candidate, {
    candidateIdentity: identity,
    candidateFiles: {patch, source: appliedSource, wasm},
  });

  const changed = JSON.parse(JSON.stringify(candidate));
  changed.source.wasmSha256 = '0'.repeat(64);
  const changedErrors = verify(base, changed, {candidateIdentity: identity});
  const changedArtifactRejected = changedErrors.some((error) => /controller-built candidate|artifact/.test(error));

  const result = {
    schema: 'near-rehearsal/repair-pipeline/v1',
    ok: errors.length === 0 && changedArtifactRejected,
    source: manifest.source,
    hashes: {
      patch: sha256File(patch),
      appliedSource: sha256File(appliedSource),
      wasm: sha256File(wasm),
    },
    cargo: cargoEnv(buildManifest).CARGO || null,
    sandbox: sandboxEnv(buildManifest, sandboxDir).NEAR_SANDBOX_VERSION,
    changedPaths: applied.changedPaths,
    baseReport,
    candidateReport: candidateReportPath,
    identity: identityPath,
    provenance: provenance ? {path: provenance, sha256: sha256File(provenance)} : null,
    acceptanceErrors: errors,
    changedArtifactRejected,
  };
  fs.writeFileSync(path.join(out, 'pipeline.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) throw new Error(`candidate acceptance failed: ${errors.join('; ')}${changedArtifactRejected ? '' : '; changed artifact was not rejected'}`);
  return result;
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) console.log(usage());
    else {
      const result = runPipeline(opts);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {runPipeline};
