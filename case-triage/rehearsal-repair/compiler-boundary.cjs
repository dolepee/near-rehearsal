'use strict';
/*
 * Controller-owned compiler boundary.
 *
 * A build is only run through an OS-level launcher that has passed a live
 * filesystem/environment/network probe. There is deliberately no host shell
 * fallback: an unavailable adapter is a typed BUILD_BOUNDARY_UNAVAILABLE.
 *
 * Enforcement is supplied by bubblewrap on Linux or sandbox-exec on macOS.
 * The adapter is selected by capability and platform, not by assuming that all
 * Linux hosts are alike. A capable Linux CI host can use bwrap; the current
 * development container cannot create namespaces and therefore blocks here.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const crypto = require('node:crypto');

const CODE = 'BUILD_BOUNDARY_UNAVAILABLE';
const GUARANTEES = Object.freeze({
  enforced: ['wall-timeout', 'process-group-cleanup', 'cpu-seconds', 'file-size-blocks', 'open-files', 'output-bytes'],
  notEnforced: ['memory-limit', 'process-count-limit', 'disk-quota'],
});
const DEFAULT_LIMITS = Object.freeze({
  wallMs: 10 * 60 * 1000,
  cpuSeconds: 300,
  fileBlocks: 262144,
  openFiles: 1024,
  outputBytes: 8 * 1024 * 1024,
});

class BoundaryUnavailableError extends Error {
  constructor(reason, details = {}) {
    super(`${CODE}: ${reason}`);
    this.name = 'BoundaryUnavailableError';
    this.code = CODE;
    this.details = {code: CODE, reason, ...details};
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function uniqueExisting(paths) {
  return [...new Set(paths.filter(Boolean).map((value) => path.resolve(value)))]
    .filter((value) => fs.existsSync(value));
}

function which(command) {
  for (const dir of (process.env.PATH || '/usr/bin:/bin').split(path.delimiter)) {
    const candidate = path.join(dir, command);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}

function adapterFor(platform = process.platform, requested = process.env.COMPILER_BOUNDARY_ADAPTER || 'auto') {
  if (requested !== 'auto') {
    if (requested === 'bwrap' && platform === 'linux') return which('bwrap');
    return null;
  }
  if (platform === 'linux') return which('bwrap');
  return null;
}

function boundaryLimits(overrides = {}) {
  const limits = {...DEFAULT_LIMITS, ...overrides};
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`invalid compiler boundary limit ${name}`);
  }
  return limits;
}

function assertNoSymlinkEscape(root, candidate, label) {
  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  const relative = path.relative(realRoot, realCandidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new BoundaryUnavailableError(`${label} escapes the disposable job tree`);
  }
}

function shellCommand(command, limits) {
  return [
    `ulimit -t ${Math.ceil(limits.cpuSeconds)} || exit 97`,
    `ulimit -f ${Math.ceil(limits.fileBlocks)} || exit 97`,
    `ulimit -n ${Math.ceil(limits.openFiles)} || exit 97`,
    `exec ${command}`,
  ].join('\n');
}

function escapeProfile(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sandboxProfile(jobDir, readRoots, limits) {
  const reads = readRoots.map((root) => `  (subpath "${escapeProfile(root)}")`).join('\n');
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*',
    reads,
    '  (literal "/dev/null")',
    '  (literal "/dev/urandom")',
    '  (literal "/dev/random"))',
    '(allow file-write*',
    `  (subpath "${escapeProfile(jobDir)}")`,
    '  (literal "/dev/null"))',
    '(allow file-read-metadata (subpath "/"))',
    '(deny network*)',
  ].join('\n');
}

function tomlPath(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function ensureCodexHome(jobDir, readRoots) {
  const home = path.join(jobDir, 'codex-home');
  fs.mkdirSync(home, {recursive: true});
  const reads = [':minimal', ...readRoots.filter((root) => root !== jobDir)];
  const filesystem = reads.map((root) => `  ${tomlPath(root)} = "read"`).join('\n');
  const config = [
    'default_permissions = "compiler-boundary"',
    '',
    '[permissions.compiler-boundary]',
    'description = "Controller compiler boundary; no host auth, home or general project access."',
    '',
    '[permissions.compiler-boundary.filesystem]',
    filesystem,
    `  ${tomlPath(jobDir)} = "write"`,
    '',
    '[permissions.compiler-boundary.network]',
    'enabled = false',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(home, 'config.toml'), config);
  return home;
}

function boundaryArgv({adapter, command, cwd, jobDir, readRoots, limits, env = {}}) {
  const cleanEnv = Object.entries(env).filter(([key]) => key !== 'BOUNDARY_CANARY');
  if (path.basename(adapter) === 'codex') {
    const envArgs = Object.entries(env).filter(([key]) => key !== 'BOUNDARY_CANARY').flatMap(([key, value]) => [`${key}=${value}`]);
    return {file: adapter, args: ['sandbox', '-P', 'compiler-boundary', '-C', cwd, '--', '/usr/bin/env', '-i', ...envArgs, '/bin/sh', '-c', shellCommand(command, limits)]};
  }
  if (adapter.endsWith('/bwrap') || path.basename(adapter) === 'bwrap') {
    const args = [
      '--unshare-all', '--die-with-parent', '--new-session',
      '--proc', '/proc', '--dev', '/dev',
      '--chdir', cwd,
    ];
    for (const root of readRoots.filter((value) => value !== jobDir)) args.push('--ro-bind', root, root);
    args.push('--bind', jobDir, jobDir, '--clearenv');
    for (const [key, value] of cleanEnv) args.push('--setenv', key, value);
    args.push('--', '/bin/sh', '-c', shellCommand(command, limits));
    return {file: adapter, args};
  }
  if (adapter.endsWith('/sandbox-exec') || path.basename(adapter) === 'sandbox-exec') {
    const profile = sandboxProfile(jobDir, readRoots, limits);
    return {file: adapter, args: ['-p', profile, '/usr/bin/env', '-i', ...cleanEnv.flatMap(([key, value]) => [`${key}=${value}`]), '/bin/sh', '-c', shellCommand(command, limits)]};
  }
  throw new BoundaryUnavailableError('no supported compiler launcher is available', {adapter});
}

function minimalEnv({cwd, jobDir, toolchainEnv = {}}) {
  const home = path.join(jobDir, 'home');
  const tmp = path.join(jobDir, 'tmp');
  const cargoHome = path.join(jobDir, 'cargo-home');
  const rustupHome = path.join(jobDir, 'rustup-home');
  fs.mkdirSync(home, {recursive: true});
  fs.mkdirSync(tmp, {recursive: true});
  fs.mkdirSync(cargoHome, {recursive: true});
  fs.mkdirSync(rustupHome, {recursive: true});
  // Cargo may read its registry cache, but it must never receive the user's
  // Cargo home: that can contain credentials.toml and unrelated config.
  const sourceCargo = toolchainEnv.CARGO_HOME;
  for (const name of ['registry', 'git']) {
    const source = sourceCargo ? path.join(sourceCargo, name) : null;
    const target = path.join(cargoHome, name);
    if (source && fs.existsSync(source) && !fs.existsSync(target)) {
      try { fs.symlinkSync(source, target, 'dir'); } catch {}
    }
  }
  const env = {
    PATH: [toolchainEnv.CARGO && path.dirname(toolchainEnv.CARGO), '/usr/bin', '/bin', '/usr/local/bin'].filter(Boolean).join(path.delimiter),
    HOME: home,
    TMPDIR: tmp,
    CARGO_HOME: cargoHome,
    CODEX_HOME: path.join(jobDir, 'codex-home'),
    RUSTUP_HOME: rustupHome,
    CARGO_TARGET_DIR: path.join(jobDir, 'target'),
    CARGO_NET_OFFLINE: 'true',
    RUSTUP_TOOLCHAIN: toolchainEnv.RUSTUP_TOOLCHAIN || '',
    CARGO: toolchainEnv.CARGO || 'cargo',
    RUSTC: toolchainEnv.RUSTC || 'rustc',
  };
  for (const key of ['DEVELOPER_DIR', 'SDKROOT', 'CC', 'CXX', 'LD']) {
    if (toolchainEnv[key] && !String(toolchainEnv[key]).startsWith(os.homedir())) env[key] = toolchainEnv[key];
  }
  return env;
}

function readRoots({cwd, jobDir, toolchainEnv = {}}) {
  const toolchainRoot = toolchainEnv.CARGO ? path.dirname(path.dirname(toolchainEnv.CARGO)) : null;
  const cargoCache = toolchainEnv.CARGO_HOME ? [
    path.join(toolchainEnv.CARGO_HOME, 'registry'),
    path.join(toolchainEnv.CARGO_HOME, 'git'),
  ] : [];
  return uniqueExisting([
    cwd,
    jobDir,
    '/usr', '/usr/local', '/bin', '/sbin', '/lib', '/lib64',
    '/System', '/Library/Developer/CommandLineTools',
    '/etc/alternatives',
    '/etc/ld.so.cache',
    toolchainRoot,
    ...cargoCache,
    toolchainEnv.DEVELOPER_DIR,
    toolchainEnv.SDKROOT,
    path.dirname(process.execPath),
  ]);
}

const SUPERVISOR = String.raw`'use strict';
const fs = require('node:fs');
const {spawn, spawnSync} = require('node:child_process');
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const initialPpid = process.ppid;
let stdout = '', stderr = '', bytes = 0, timedOut = false, outputLimit = false, finished = false, closing = false;
let timer = null;
let parentWatch = null;
let trackTimer = null;
const tracked = new Set();
const child = spawn(spec.file, spec.args, {cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
tracked.add(child.pid);
function writeResult(result) {
  try { fs.writeFileSync(spec.result, JSON.stringify(result)); } catch {}
}
function killGroup(signal) {
  try { process.kill(-child.pid, signal); } catch {}
  for (const pid of tracked) { try { process.kill(pid, signal); } catch {} }
}
function groupAlive() {
  try { process.kill(-child.pid, 0); return true; } catch {}
  for (const pid of tracked) { try { process.kill(pid, 0); return true; } catch {} }
  return false;
}
function childPids() {
  const pids = new Set();
  try {
    for (const name of require('node:fs').readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(name)) continue;
      try {
        const stat = require('node:fs').readFileSync('/proc/' + name + '/stat', 'utf8');
        const close = stat.lastIndexOf(')');
        const fields = stat.slice(close + 2).split(' ');
        pids.add({pid: Number(name), ppid: Number(fields[1])});
      } catch {}
    }
  } catch {
    try {
      const rows = spawnSync('ps', ['-axo', 'pid=,ppid='], {encoding: 'utf8', timeout: 1000}).stdout || '';
      for (const row of rows.trim().split('\n')) {
        const [pid, ppid] = row.trim().split(/\s+/).map(Number);
        if (pid && ppid) pids.add({pid, ppid});
      }
    } catch {}
  }
  return pids;
}
function trackDescendants() {
  const all = childPids();
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of all) {
      if (tracked.has(entry.ppid) && !tracked.has(entry.pid)) { tracked.add(entry.pid); changed = true; }
    }
  }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function finish(result) {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  if (parentWatch) clearInterval(parentWatch);
  if (trackTimer) clearInterval(trackTimer);
  killGroup('SIGKILL');
  writeResult(result);
  process.stdout.write(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
async function stop(result) {
  if (finished || closing) return;
  closing = true;
  killGroup('SIGTERM');
  const termDeadline = Date.now() + 1500;
  while (groupAlive() && Date.now() < termDeadline) await sleep(50);
  if (groupAlive()) killGroup('SIGKILL');
  const killDeadline = Date.now() + 750;
  while (groupAlive() && Date.now() < killDeadline) await sleep(25);
  killGroup('SIGKILL');
  finish(result);
}
child.stdout.on('data', (chunk) => {
  if (bytes + chunk.length > spec.outputBytes) { outputLimit = true; void stop({ok: false, outputLimit: true, timedOut, stdout, stderr}); return; }
  bytes += chunk.length; stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  if (bytes + chunk.length > spec.outputBytes) { outputLimit = true; void stop({ok: false, outputLimit: true, timedOut, stdout, stderr}); return; }
  bytes += chunk.length; stderr += chunk;
});
child.on('error', (error) => { void stop({ok: false, error: error.message, timedOut, outputLimit, stdout, stderr}); });
child.on('close', (status, signal) => {
  void stop({ok: !timedOut && !outputLimit && status === 0, status, signal, timedOut, outputLimit, stdout, stderr});
});
timer = setTimeout(() => {
  timedOut = true;
  void stop({ok: false, timedOut: true, outputLimit, stdout, stderr});
}, spec.timeoutMs);
trackTimer = setInterval(trackDescendants, 100);
parentWatch = setInterval(() => {
  if (process.ppid !== initialPpid) void stop({ok: false, error: 'supervisor parent exited', timedOut, outputLimit, stdout, stderr});
}, 250);
process.on('SIGTERM', () => { void stop({ok: false, error: 'supervisor terminated', timedOut, outputLimit, stdout, stderr}); });
process.on('SIGINT', () => { void stop({ok: false, error: 'supervisor interrupted', timedOut, outputLimit, stdout, stderr}); });
process.on('exit', () => { killGroup('SIGKILL'); });
`;
function runSupervised({file, args, cwd, env, jobDir, limits}) {
  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-boundary-control-'));
  fs.chmodSync(controlDir, 0o700);
  const supervisor = path.join(controlDir, 'supervisor.cjs');
  const specPath = path.join(controlDir, 'spec.json');
  const resultPath = path.join(controlDir, 'result.json');
  fs.writeFileSync(supervisor, SUPERVISOR, {mode: 0o700});
  fs.writeFileSync(specPath, JSON.stringify({file, args, cwd, env, timeoutMs: limits.wallMs, outputBytes: limits.outputBytes, result: resultPath}), {mode: 0o600});
  let outer;
  let result = null;
  try {
    outer = spawnSync(process.execPath, [supervisor, specPath], {
      cwd: jobDir,
      env: process.env,
      encoding: 'utf8',
      timeout: limits.wallMs + 5000,
      maxBuffer: limits.outputBytes + 1024 * 1024,
    });
    try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch {
      result = {ok: false, error: (outer.stderr || outer.stdout || 'compiler boundary supervisor produced no result').trim(), timedOut: outer.error?.code === 'ETIMEDOUT'};
    }
  } finally {
    fs.rmSync(controlDir, {recursive: true, force: true});
  }
  return {...result, supervisorStatus: outer?.status ?? null, supervisorSignal: outer?.signal ?? null};
}

function probeBoundary({cwd, jobDir, toolchainEnv = {}, platform = process.platform, adapter = adapterFor(platform), limits = boundaryLimits()}) {
  if (!adapter) {
    return {ok: false, code: CODE, reason: `no enforced compiler launcher available on ${platform}`, platform, adapter: null, limits};
  }
  try {
    fs.mkdirSync(jobDir, {recursive: true});
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-boundary-outside-'));
    const outsideFile = path.join(outsideDir, 'outside.txt');
    const insideFile = path.join(jobDir, 'inside.txt');
    fs.writeFileSync(outsideFile, 'outside-canary');
    const probeScript = path.join(jobDir, 'probe.sh');
    const resultFile = path.join(jobDir, 'probe-result.json');
    const port = 30000 + (process.pid % 20000);
    fs.writeFileSync(probeScript, `#!/bin/sh
outside="$1"; inside="$2"; result="$3"; port="$4"
outside_read=0; outside_write=0; inside_write=0; env_leak=0; network=probe-unavailable
if cat "$outside" >/dev/null 2>&1; then outside_read=1; fi
if (echo escaped > "$outside") >/dev/null 2>&1; then outside_write=1; fi
if (echo ok > "$inside") >/dev/null 2>&1; then inside_write=1; fi
if [ -n "\${BOUNDARY_CANARY:-}" ]; then env_leak=1; fi
if command -v nc >/dev/null 2>&1; then
  if nc -z -w 1 127.0.0.1 "$port" >/dev/null 2>&1; then network=connected; else network=blocked; fi
elif [ -x /bin/bash ]; then
  if /bin/bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" >/dev/null 2>&1; then network=connected; else network=blocked; fi
fi
bool() { if [ "$1" = 1 ]; then printf true; else printf false; fi; }
printf '{\"outsideRead\":%s,\"outsideWrite\":%s,\"insideWrite\":%s,\"envLeak\":%s,\"network\":\"%s\"}\n' "$(bool $outside_read)" "$(bool $outside_write)" "$(bool $inside_write)" "$(bool $env_leak)" "$network" > "$result"
`);
    fs.chmodSync(probeScript, 0o700);
    const listener = spawn(process.execPath, ['-e', `const net=require('node:net');const s=net.createServer(c=>c.end());s.listen(${port},'127.0.0.1');setTimeout(()=>process.exit(0),5000);`], {stdio: 'ignore', detached: true});
    const wait = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(wait, 0, 0, 250);
    const outsidePositive = spawnSync(process.execPath, ['-e', `const net=require('node:net');const s=net.connect(${port},'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1000);`], {timeout: 3000});
    const readRootsList = uniqueExisting([cwd, jobDir, ...readRoots({cwd, jobDir, toolchainEnv})]);
    const innerEnv = minimalEnv({cwd, jobDir, toolchainEnv});
    if (path.basename(adapter) === 'codex') ensureCodexHome(jobDir, readRootsList);
    const outerEnv = {...innerEnv, BOUNDARY_CANARY: 'must-not-leak'};
    const argv = boundaryArgv({adapter, command: `/bin/sh ${[probeScript, outsideFile, insideFile, resultFile, port].map((value) => `'${String(value).replace(/'/g, `'\\''`)}'`).join(' ')}`, cwd, jobDir, readRoots: readRootsList, limits, env: innerEnv});
    const run = runSupervised({...argv, cwd, env: outerEnv, jobDir, limits: {...limits, wallMs: Math.min(limits.wallMs, 15000)}});
    listener.kill('SIGKILL');
    let result = null;
    try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}
    const outsideControl = outsidePositive.status === 0;
    const checks = {
      outsideControl,
      outsideReadDenied: result?.outsideRead === false,
      outsideWriteDenied: result?.outsideWrite === false,
      insideWriteAllowed: result?.insideWrite === true,
      environmentCanaryAbsent: result?.envLeak === false,
      networkDenied: result && result.network !== 'connected',
    };
    fs.rmSync(outsideDir, {recursive: true, force: true});
    const ok = outsideControl && Object.values(checks).every(Boolean) && run.ok;
    return {ok, code: ok ? null : CODE, reason: ok ? null : 'compiler boundary probe failed', platform, adapter, limits, guarantees: GUARANTEES, checks, run, result};
  } catch (error) {
    return {ok: false, code: CODE, reason: error.message, platform, adapter, limits};
  }
}

function prepareBuild({appliedDir, outDir, toolchainEnv, command, artifact = 'target/wasm32-unknown-unknown/release/sputnikdao2.wasm', platform = process.platform}) {
  const jobDir = path.join(outDir, 'boundary');
  fs.mkdirSync(jobDir, {recursive: true});
  assertNoSymlinkEscape(outDir, appliedDir, 'applied source');
  const adapter = adapterFor(platform);
  if (!adapter) throw new BoundaryUnavailableError(`no enforced compiler launcher available on ${platform}`, {platform});
  const limits = boundaryLimits();
  const cwd = appliedDir;
  const readRootsList = uniqueExisting([cwd, jobDir, ...readRoots({cwd, jobDir, toolchainEnv})]);
  const env = minimalEnv({cwd, jobDir, toolchainEnv});
  if (path.basename(adapter) === 'codex') ensureCodexHome(jobDir, readRootsList);
  return {jobDir, adapter, limits, cwd, readRoots: readRootsList, env, artifact: path.join(jobDir, artifact), argv: boundaryArgv({adapter, command, cwd, jobDir, readRoots: readRootsList, limits, env})};
}

module.exports = {
  CODE, BoundaryUnavailableError, DEFAULT_LIMITS, GUARANTEES, adapterFor, boundaryLimits, probeBoundary,
  prepareBuild, runSupervised, assertNoSymlinkEscape, minimalEnv, readRoots, boundaryArgv, sha256,
};
