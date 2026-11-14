'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {CODE, BoundaryUnavailableError, probeBoundary, boundaryLimits, assertNoSymlinkEscape, prepareBuild, runSupervised, minimalEnv} = require('./compiler-boundary.cjs');

assert.throws(() => boundaryLimits({wallMs: 0}), /invalid compiler boundary limit/);
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
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 10; i += 1) {
    try { process.kill(childPid, 0); } catch { alive = false; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  assert.equal(alive, false);
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
console.log('compiler-boundary: probe, path-escape rejection, typed unavailable result and no-fallback checks passed');
