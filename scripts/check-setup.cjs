'use strict';
// Local configuration checks only. Never reads credential contents or calls a provider.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {resolveConfig, resolveExecutable} = require('../ui/sputnik/repair-job.cjs');
const {verifyToolchain} = require('../case-triage/rehearsal-repair/repair-pipeline.cjs');
const {probeBoundary} = require('../case-triage/rehearsal-repair/compiler-boundary.cjs');
const {sandboxArgv} = require('../case-triage/rehearsal-repair/model-producer.cjs');
const {verifiedOuterProfile} = require('../case-triage/rehearsal-repair/codex-producer.cjs');
const ROOT = path.resolve(__dirname, '..');
const RUNTIMES = {
  manual: {version: '2.6.2', commit: '2f9ddb711ebd94a306eaec06030d87ef8dfc51fa', protocol: 77},
  repair: {version: '2.14.0', commit: 'bc4e9e8cfb03d9e82f027883055624e18576993e', protocol: 88},
};

function parseArgs(argv) {
  const options = {flow: 'repair', generate: false, mode: null};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--flow') options.flow = argv[++i];
    else if (argv[i] === '--generate') options.generate = true;
    else if (argv[i] === '--mode') options.mode = argv[++i];
    else if (argv[i] === '--help') options.help = true;
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  if (!RUNTIMES[options.flow]) throw new Error('--flow must be manual or repair');
  if (options.mode && options.mode !== 'patch') throw new Error('--mode must be patch');
  if (options.mode === 'patch' && options.flow !== 'repair') throw new Error('--mode patch requires --flow repair');
  if (options.generate && options.mode === 'patch') throw new Error('--generate and --mode patch are mutually exclusive');
  if (options.generate && options.flow !== 'repair') throw new Error('--generate requires --flow repair');
  return options;
}

function providerPrefix(raw, profile) {
  const prefix = sandboxArgv({MODEL_PRODUCER_SANDBOX_CMD: raw});
  if (!prefix) throw new Error('MODEL_PRODUCER_SANDBOX_CMD is required.');
  verifiedOuterProfile(prefix.map((part) => part.replaceAll('{profile}', profile || '{profile}')), profile);
  return prefix;
}

function checkSetup(options, env = process.env, nodeVersion = process.versions.node) {
  const checks = [];
  const check = (name, operation) => {
    try { checks.push({name, ok: true, detail: operation()}); }
    catch (error) { checks.push({name, ok: false, detail: error.message}); }
  };
  const pin = RUNTIMES[options.flow];
  check('Node', () => {
    if (!['24', '26'].includes(nodeVersion.split('.')[0])) throw new Error('Use Node 24 or 26; .nvmrc pins the Node 24 reference version.');
    return `Node ${nodeVersion}; supported major version (.nvmrc selects Node 24)`;
  });
  check('Dependencies', () => {
    require.resolve('near-workspaces');
    require.resolve('wabt');
    const shim = fs.readFileSync(require.resolve('near-sandbox/dist/getBinary.js'), 'utf8');
    if (!shim.includes('Local compatibility')) throw new Error('Run npm run setup to install dependencies and apply the host compatibility shim.');
    return 'Installed; near-sandbox host shim present';
  });
  check(`Sandbox ${pin.version}`, () => {
    const dir = options.flow === 'repair'
      ? (env.REPAIR_SANDBOX_DIR || env.NEAR_SANDBOX_BIN_PATH)
      : (env.NEAR_SANDBOX_BIN_PATH || env.NEAR_SANDBOX_BINARY_PATH);
    if (!dir) throw new Error(`Set ${options.flow === 'repair' ? 'REPAIR_SANDBOX_DIR' : 'NEAR_SANDBOX_BIN_PATH'} to the directory containing Sandbox ${pin.version}.`);
    const binary = path.join(dir, 'near-sandbox');
    const run = spawnSync(binary, ['--version'], {encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024});
    const output = `${run.stdout || ''}\n${run.stderr || ''}`;
    const match = output.match(/neard \(release ([^)]+)\).*?commit ([0-9a-f]+).*?\(protocol (\d+)\)/s);
    if (run.error || run.status !== 0 || !match || match[1] !== pin.version || match[2] !== pin.commit || Number(match[3]) !== pin.protocol) {
      throw new Error(`Expected Sandbox ${pin.version}, commit ${pin.commit}, protocol ${pin.protocol}; runtime did not match or could not execute.`);
    }
    return `${pin.version}; commit and protocol match (configuration check, not replay)`;
  });
  const patch = options.mode === 'patch';
  if (options.generate || patch) {
    const config = resolveConfig(env);
    check('Pinned source', () => {
      if (!config.sourceDir) throw new Error('Set REPAIR_SOURCE_DIR to the pinned Sputnik Git checkout.');
      const run = spawnSync('git', ['-C', config.sourceDir, 'rev-parse', 'HEAD'], {encoding: 'utf8', timeout: 10_000});
      if (run.status !== 0 || run.stdout.trim() !== '5434a59dec23ee0c49df8c8c4350c208a7e75b0b') throw new Error('REPAIR_SOURCE_DIR must be checked out at 5434a59dec23ee0c49df8c8c4350c208a7e75b0b.');
      return 'Pinned source revision available';
    });
    check('Rust build tools', () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'case-triage/rehearsal-repair/build-manifest.json'), 'utf8'));
      const toolchain = verifyToolchain(manifest);
      const run = spawnSync(toolchain.env.RUSTC, ['--print', 'target-libdir', '--target', manifest.toolchain.target], {env: {...process.env, ...toolchain.env}, encoding: 'utf8', timeout: 10_000});
      if (run.status !== 0 || !fs.existsSync(run.stdout.trim())) throw new Error('Install the wasm32-unknown-unknown target for Rust 1.86.0.');
      return 'cargo/rustc 1.86.0 and wasm32 target available';
    });
    check('Compiler boundary', () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'case-triage/rehearsal-repair/build-manifest.json'), 'utf8'));
      const toolchain = verifyToolchain(manifest);
      const jobDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'compiler-boundary-check-'));
      try {
        const probe = probeBoundary({cwd: ROOT, jobDir, toolchainEnv: toolchain.env});
        if (!probe.ok) throw new Error(`BUILD_BOUNDARY_UNAVAILABLE: ${probe.reason || 'compiler boundary probe failed'}${probe.adapter ? ` (${probe.adapter})` : ''}`);
        return `enforced compiler boundary available (${probe.adapter})`;
      } finally { fs.rmSync(jobDir, {recursive: true, force: true}); }
    });
    if (options.generate) check('Provider configuration', () => {
      const missing = config.missing.filter((name) => name.startsWith('CODEX_') || name === 'MODEL_PRODUCER_SANDBOX_CMD' || name === 'REPAIR_BASE_WASM');
      if (missing.length) throw new Error(`Missing: ${missing.join(', ')}. See docs/local-repair-setup.md.`);
      const prefix = providerPrefix(env.MODEL_PRODUCER_SANDBOX_CMD, env.CODEX_PERMISSION_PROFILE);
      for (const command of [env.CODEX_BIN || 'codex', prefix[0]]) {
        const executable = resolveExecutable(command, env.PATH);
        if (!executable) throw new Error('Codex or the configured provider wrapper could not be found.');
        try { fs.accessSync(executable, fs.constants.X_OK); } catch { throw new Error('Codex or the configured provider wrapper is not executable.'); }
      }
      const runtime = config.privateRuntime;
      if (fs.existsSync(runtime) && (!fs.statSync(runtime).isDirectory() || fs.readdirSync(runtime).length)) throw new Error('CODEX_PRIVATE_RUNTIME must be absent or an empty dedicated directory.');
      return 'Local configuration present; login, model entitlement and confinement are checked by the actual producer, not by doctor. No credential contents read.';
    });
  }
  return {schema: 'near-rehearsal/setup-check/v1', flow: options.flow, generate: options.generate, ready: checks.every((c) => c.ok), checks, providerCalled: false};
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('npm run doctor -- --flow manual|repair [--generate | --mode patch]\nLocal checks only; no model call or Sandbox chain is started.');
    else { const report = checkSetup(options); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ready ? 0 : 1; }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {checkSetup, parseArgs, providerPrefix, RUNTIMES};
