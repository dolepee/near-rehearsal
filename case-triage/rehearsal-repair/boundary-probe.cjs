#!/usr/bin/env node
'use strict';
/*
 * Standalone compiler-boundary readiness check.
 *
 * Runs the same live probe the pipeline runs before it builds, so a CI job can
 * fail on a missing or broken launcher with one clear annotation instead of an
 * INCONCLUSIVE review further down. Exits 0 only when the probe passed.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {probeBoundary} = require('./compiler-boundary.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

function toolchainEnv() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-manifest.json'), 'utf8'));
    const {verifyToolchain} = require('./repair-pipeline.cjs');
    return verifyToolchain(manifest).env;
  } catch {
    return {};
  }
}

function main() {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-boundary-probe-'));
  let probe;
  try {
    probe = probeBoundary({cwd: ROOT, jobDir, toolchainEnv: toolchainEnv()});
  } finally {
    fs.rmSync(jobDir, {recursive: true, force: true});
  }
  process.stdout.write(JSON.stringify({
    ok: probe.ok,
    platform: probe.platform,
    adapter: probe.adapter,
    reason: probe.reason,
    checks: probe.checks || null,
    guarantees: probe.guarantees || null,
  }, null, 2) + '\n');
  if (!probe.ok) process.exit(1);
}

main();
