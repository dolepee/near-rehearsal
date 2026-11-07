'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {findToolchain, verifyToolchain, verifySandbox} = require('./repair-pipeline.cjs');

function fakeSandbox(version, commit = 'bc4e9e8cfb03d9e82f027883055624e18576993e', protocol = 88) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-sandbox-'));
  const binary = path.join(dir, 'near-sandbox');
  fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' 'neard (release ${version}) (build ${version}) (commit ${commit}) (rustc 1.95.0) (min_protocol 84) (protocol ${protocol}) (db 51)'\n`);
  fs.chmodSync(binary, 0o755);
  return dir;
}

try {
  const toolchain = findToolchain({toolchain: {rust: '1.86.0'}});
  assert.match(toolchain.name, /^1\.86\.0-/);
  assert.equal(toolchain.root, '/workspace/.rustup');

  const verified = verifyToolchain({toolchain: {rust: '1.86.0'}});
  assert.match(verified.cargoVersion, /^cargo 1\.86\.0 /);
  assert.match(verified.rustcVersion, /^rustc 1\.86\.0 /);
  assert.equal(verified.rustupHome, '/workspace/.rustup');

  assert.throws(() => verifyToolchain({toolchain: {rust: '1.85.0'}}), /toolchain not found|not 1\.85\.0/);

  const good = fakeSandbox('2.14.0');
  const sandbox = verifySandbox({localRuntime: {sandbox: '2.14.0'}}, good);
  assert.equal(sandbox.versionOutput.includes('release 2.14.0'), true);
  assert.equal(sandbox.binarySha256, sandbox.targetSha256);

  const bad = fakeSandbox('2.6.2', '2f9ddb711ebd94a306eaec06030d87ef8dfc51fa', 77);
  assert.throws(() => verifySandbox({localRuntime: {sandbox: '2.14.0'}}, bad), /not the declared 2\.14\.0/);
  assert.throws(() => verifySandbox({localRuntime: {sandbox: '2.14.0'}}, path.join(os.tmpdir(), 'does-not-exist')), /wrapper was not found|Sandbox binary not found/);

  console.log(JSON.stringify({
    schema: 'near-rehearsal/repair-pipeline-guards-tests/v1',
    passed: true,
    checks: ['rustup-home', 'cargo-1.86', 'rustc-1.86', 'wrong-toolchain-rejected', 'sandbox-2.14-accepted', 'sandbox-2.6-rejected', 'missing-sandbox-rejected'],
  }, null, 2));
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
