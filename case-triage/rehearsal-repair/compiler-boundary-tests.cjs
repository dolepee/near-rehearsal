'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {CODE, BoundaryUnavailableError, probeBoundary, boundaryLimits, assertNoSymlinkEscape, prepareBuild} = require('./compiler-boundary.cjs');

assert.throws(() => boundaryLimits({wallMs: 0}), /invalid compiler boundary limit/);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-boundary-test-'));
try {
  const inside = path.join(root, 'inside');
  fs.mkdirSync(inside);
  assert.doesNotThrow(() => assertNoSymlinkEscape(root, inside, 'inside'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-boundary-outside-test-'));
  assert.throws(() => assertNoSymlinkEscape(root, outside, 'outside'), (error) => error instanceof BoundaryUnavailableError && error.code === CODE);
  fs.rmSync(outside, {recursive: true, force: true});

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
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
console.log('compiler-boundary: probe, path-escape rejection, typed unavailable result and no-fallback checks passed');
