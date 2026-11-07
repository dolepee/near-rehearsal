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

function findToolchain(manifest) {
  const wanted = manifest?.toolchain?.rust || '';
  if (!wanted) throw new Error('build manifest does not declare a Rust version');
  const roots = [process.env.RUSTUP_HOME, path.join(os.homedir(), '.rustup'), '/workspace/.rustup'].filter(Boolean);
  for (const root of roots) {
    const toolchains = path.join(root, 'toolchains');
    if (!fs.existsSync(toolchains)) continue;
    const names = fs.readdirSync(toolchains).filter((name) => name.startsWith(`${wanted}-`)).sort();
    for (const name of names) {
      const bin = path.join(toolchains, name, 'bin');
      const cargo = path.join(bin, 'cargo');
      const rustc = path.join(bin, 'rustc');
      if (fs.existsSync(cargo) && fs.existsSync(rustc)) return {root, name, bin, cargo, rustc};
    }
  }
  return null;
}

function resolveToolchain(manifest) {
  const found = findToolchain(manifest);
  if (!found) throw new Error(`Rust ${manifest?.toolchain?.rust} toolchain not found in a rustup home`);
  return found;
}

function cargoEnv(manifest) {
  const toolchain = resolveToolchain(manifest);
  const bin = toolchain.bin;
  const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  return {
    CARGO: toolchain.cargo,
    RUSTC: toolchain.rustc,
    RUSTUP_HOME: toolchain.root,
    RUSTUP_TOOLCHAIN: toolchain.name,
    CARGO_HOME: cargoHome,
    PATH: `${bin}:${process.env.PATH || ''}`,
  };
}

function versionOf(command, env) {
  const result = run(command, ['--version'], {env: {...process.env, ...env}});
  if (result.status !== 0) throw new Error(`cannot query ${command}: ${(result.stderr || result.stdout || '').trim()}`);
  return (result.stdout || '').trim();
}

function verifyToolchain(manifest) {
  const env = cargoEnv(manifest);
  const cargoVersion = versionOf(env.CARGO, env);
  const rustcVersion = versionOf(env.RUSTC, env);
  const wanted = manifest.toolchain.rust;
  if (!new RegExp(`^cargo ${wanted.replace(/\./g, '\\.')} `).test(cargoVersion)) throw new Error(`cargo version ${cargoVersion} is not ${wanted}`);
  if (!new RegExp(`^rustc ${wanted.replace(/\./g, '\\.')} `).test(rustcVersion)) throw new Error(`rustc version ${rustcVersion} is not ${wanted}`);
  return {env, cargoVersion, rustcVersion, toolchain: env.RUSTUP_TOOLCHAIN, rustupHome: env.RUSTUP_HOME};
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

function verifySandbox(manifest, requestedDir) {
  const env = sandboxEnv(manifest, requestedDir);
  const binary = path.join(env.SANDBOX_DIR, 'near-sandbox');
  if (!fs.existsSync(binary)) throw new Error(`Sandbox binary not found at ${binary}`);
  const result = run(binary, ['--version'], {env: {...process.env, ...env}});
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const version = manifest.localRuntime.sandbox;
  if (result.status !== 0 || !new RegExp(`release ${version.replace(/\./g, '\\.')}\\b`).test(output)) {
    throw new Error(`Sandbox binary at ${binary} is not the declared ${version}: ${output}`);
  }
  return {
    ...env,
    binary,
    versionOutput: output,
    binarySha256: sha256File(binary),
    targetSha256: sha256File(fs.realpathSync(binary)),
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

  const toolchain = verifyToolchain(buildManifest);
  const build = run('sh', ['-c', manifest.build.command], {
    cwd: appliedDir,
    timeout: 20 * 60 * 1000,
    env: toolchain.env,
  });
  writeLog(path.join(out, 'build.log'), build);
  if (build.status !== 0) throw new Error(`candidate build failed with exit ${build.status}; see build.log`);
  const wasm = path.join(appliedDir, buildManifest.build.artifact);
  if (!fs.existsSync(wasm)) throw new Error(`candidate build produced no ${buildManifest.build.artifact}`);

  const sandbox = verifySandbox(buildManifest, sandboxDir);
  const replay = run(process.execPath, [ISSUE238], {
    cwd: ROOT,
    timeout: 20 * 60 * 1000,
    env: {
      ...sandbox,
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
    cargo: toolchain.env.CARGO,
    toolchain: {cargo: toolchain.cargoVersion, rustc: toolchain.rustcVersion, rustupHome: toolchain.rustupHome, toolchain: toolchain.toolchain},
    sandbox: {version: buildManifest.localRuntime.sandbox, binary: sandbox.binary, versionOutput: sandbox.versionOutput, binarySha256: sandbox.binarySha256, targetSha256: sandbox.targetSha256},
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

module.exports = {findToolchain, verifyToolchain, sandboxEnv, verifySandbox, runPipeline};
