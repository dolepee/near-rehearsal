'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {CODE, BoundaryUnavailableError, adapterFor, probeBoundary, boundaryLimits, assertNoSymlinkEscape, prepareBuild, runSupervised, minimalEnv, boundaryArgv} = require('./compiler-boundary.cjs');

assert.throws(() => boundaryLimits({wallMs: 0}), /invalid compiler boundary limit/);
assert.equal(adapterFor('darwin'), null, 'macOS source-build must fail closed without descendant teardown');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-boundary-test-'));
try {
  const inside = path.join(root, 'inside');
  fs.mkdirSync(inside);
  assert.doesNotThrow(() => assertNoSymlinkEscape(root, inside, 'inside'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-boundary-outside-test-'));
  assert.throws(() => assertNoSymlinkEscape(root, outside, 'outside'), (error) => error instanceof BoundaryUnavailableError && error.code === CODE);
  fs.rmSync(outside, {recursive: true, force: true});

  const env = minimalEnv({cwd: process.cwd(), jobDir: path.join(root, 'env'), toolchainEnv: {CARGO_HOME: '/host/cargo', RUSTUP_HOME: '/host/rustup'}});
  assert.equal(env.CARGO_HOME.startsWith(path.join(root, 'env')), true);
  assert.equal(env.RUSTUP_HOME.startsWith(path.join(root, 'env')), true);
  assert.equal(Object.hasOwn(env, 'BOUNDARY_CANARY'), false);

  const probe = probeBoundary({cwd: process.cwd(), jobDir: path.join(root, 'probe'), toolchainEnv: {}});
  if (probe.ok) {
    assert.equal(probe.checks.outsideControl, true);
    assert.equal(probe.checks.outsideReadDenied, true);
    assert.equal(probe.checks.outsideWriteDenied, true);
    assert.equal(probe.checks.insideWriteAllowed, true);
    assert.equal(probe.checks.environmentCanaryAbsent, true);
    assert.equal(probe.checks.networkDenied, true);
  } else {
    assert.equal(probe.code, CODE);
    assert.ok(probe.reason);
  }

  const unsupported = {platform: 'unsupported', adapter: null};
  assert.throws(() => prepareBuild({appliedDir: inside, outDir: root, toolchainEnv: {}, command: 'true', ...unsupported}), (error) => error instanceof BoundaryUnavailableError && error.code === CODE);

  const timeoutDir = path.join(root, 'timeout');
  fs.mkdirSync(timeoutDir);
  const pidFile = path.join(timeoutDir, 'child.pid');
  const timeoutRun = runSupervised({
    file: process.execPath,
    args: ['-e', `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setTimeout(()=>{},30000)']);fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>{},30000);`],
    cwd: timeoutDir,
    env: {PATH: process.env.PATH || '/usr/bin:/bin'},
    jobDir: timeoutDir,
    limits: boundaryLimits({wallMs: 400}),
  });
  assert.equal(timeoutRun.timedOut, true);
  assert.equal(timeoutRun.ok, false);
  const assertDead = (pid) => {
    let alive = true;
    for (let i = 0; i < 20; i += 1) {
      try { process.kill(pid, 0); } catch { alive = false; break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    assert.equal(alive, false, `process ${pid} survived supervisor cleanup`);
  };
  assertDead(Number(fs.readFileSync(pidFile, 'utf8')));

  const linuxAdapter = process.platform === 'linux' ? adapterFor('linux') : null;
  const namespaceRequired = process.argv.includes('--require-namespace');
  if (namespaceRequired) assert.ok(linuxAdapter, 'required Linux PID-namespace launcher is unavailable; do not skip this CI gate');
  if (linuxAdapter) {
    // Namespace-local PIDs cannot be checked against the host PID table.
    // bwrap's status channel gives its child PID in the caller's namespace.
    const namespaceDir = path.join(root, 'namespace');
    fs.mkdirSync(namespaceDir);
    const heartbeat = path.join(namespaceDir, 'heartbeat');
    const writer = path.join(namespaceDir, 'owned-writer.sh');
    fs.writeFileSync(writer, 'trap "" TERM\nwhile :; do printf x >> "$1"; sleep 0.03; done\n');
    const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
    for (const mode of ['normal-close', 'timeout']) {
      fs.rmSync(heartbeat, {force: true});
      const limits = boundaryLimits({wallMs: mode === 'timeout' ? 1200 : 3000});
      const detached = `/bin/sh -c ${quote(`setsid /bin/sh ${quote(writer)} ${quote(heartbeat)} &`)};
      const script = `${detached}; while [ ! -s ${quote(heartbeat)} ]; do sleep 0.02; done; ${mode === 'timeout' ? 'sleep 30' : 'sleep 0.1'}`;
      const command = `/bin/sh -c ${quote(script)}`;
      const argv = boundaryArgv({
        adapter: linuxAdapter, command, cwd: namespaceDir, jobDir: namespaceDir,
        readRoots: [namespaceDir, '/usr', '/bin', '/lib', '/lib64', '/etc/ld.so.cache'].filter((value) => fs.existsSync(value)),
        limits, env: {PATH: '/usr/bin:/bin', HOME: namespaceDir, TMPDIR: namespaceDir},
      });
      argv.args.unshift('--json-status-fd', '1');
      let hostPid;
      try {
        const result = runSupervised({...argv, cwd: namespaceDir, env: {PATH: '/usr/bin:/bin'}, jobDir: namespaceDir, limits, pidNamespace: true, requirePidNamespace: true});
        const status = (result.stdout || '').split('\n').filter(Boolean).map((line) => JSON.parse(line));
        hostPid = status.find((entry) => Number.isInteger(entry['child-pid']))?.['child-pid'];
        assert.ok(Number.isInteger(hostPid) && hostPid > 1, `bwrap did not report a host child PID: ${result.stderr || ''}`);
        assert.ok(fs.existsSync(heartbeat) && fs.statSync(heartbeat).size > 0, 'owned detached writer must actually execute');
        if (mode === 'timeout') assert.equal(result.timedOut, true);
        else assert.equal(result.ok, true, JSON.stringify(result));
        assertDead(hostPid);
        const size = fs.statSync(heartbeat).size;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
        assert.equal(fs.statSync(heartbeat).size, size, 'detached writer continued after boundary completion');
      } finally {
        // Failure cleanup is limited to the test-owned namespace child.
        if (hostPid) {
          try {
            const commandLine = fs.readFileSync(`/proc/${hostPid}/cmdline`, 'utf8');
            if (commandLine.includes(namespaceDir)) process.kill(hostPid, 'SIGKILL');
          } catch {}
        }
      }
    }
    console.log('compiler-boundary: real bwrap detached-child retained-pipe normal-close and timeout checks passed');
  }

  assert.throws(() => runSupervised({
    file: process.execPath,
    args: ['-e', 'setTimeout(()=>{},1000)'],
    cwd: timeoutDir,
    env: {PATH: process.env.PATH || '/usr/bin:/bin'},
    jobDir: timeoutDir,
    limits: boundaryLimits({wallMs: 200}),
    requirePidNamespace: true,
    pidNamespace: false,
  }), (error) => error instanceof BoundaryUnavailableError && /descendant teardown/.test(error.message));

} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
console.log('compiler-boundary: probe, path-escape rejection, typed unavailable, fail-closed non-namespace launcher and no-fallback checks passed');
