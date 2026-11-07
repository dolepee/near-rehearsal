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

function fakeRustup(version, cargoVersion = version, rustcVersion = version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-rustup-'));
  const bin = path.join(root, 'toolchains', `${version}-test`, 'bin');
  fs.mkdirSync(bin, {recursive: true});
  for (const [name, printed] of [['cargo', cargoVersion], ['rustc', rustcVersion]]) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${name} ${printed}'\n`);
    fs.chmodSync(file, 0o755);
  }
  return root;
}

try {
  const configuredRoots = [process.env.RUSTUP_HOME, path.join(os.homedir(), '.rustup'), '/workspace/.rustup'].filter(Boolean);
  const toolchain = findToolchain({toolchain: {rust: '1.86.0'}});
  assert.match(toolchain.name, /^1\.86\.0-/);
  assert.ok(configuredRoots.includes(toolchain.root), `selected root ${toolchain.root} is a configured/default rustup home`);

  const verified = verifyToolchain({toolchain: {rust: '1.86.0'}});
  assert.match(verified.cargoVersion, /^cargo 1\.86\.0 /);
  assert.match(verified.rustcVersion, /^rustc 1\.86\.0 /);
  assert.equal(verified.rustupHome, toolchain.root);

  const wrongRoot = fakeRustup('1.86.0', '1.85.0', '1.85.0');
  const previousRoot = process.env.RUSTUP_HOME;
  process.env.RUSTUP_HOME = wrongRoot;
  try {
    assert.throws(() => verifyToolchain({toolchain: {rust: '1.86.0'}}), /cargo version .* is not 1\.86\.0/);
  } finally {
    if (previousRoot === undefined) delete process.env.RUSTUP_HOME;
    else process.env.RUSTUP_HOME = previousRoot;
  }

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
    checks: ['rustup-home', 'cargo-1.86', 'rustc-1.86', 'wrong-toolchain-version-rejected', 'sandbox-2.14-accepted', 'sandbox-2.6-rejected', 'missing-sandbox-rejected'],
  }, null, 2));
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
