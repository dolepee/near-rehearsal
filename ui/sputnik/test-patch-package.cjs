'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawnSync} = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-patch-package-'));
const routeDir = path.join(root, 'ui/sputnik');
const routeFile = path.join(routeDir, 'patch-route.cjs');
const cli = path.join(root, 'scripts/review-patch.cjs');
const source = path.join(root, 'source');
const sandbox = path.join(root, 'sandbox');

function fakeChecker() {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const out = args[args.indexOf('--out') + 1];",
    "fs.mkdirSync(path.join(out, 'pipeline/applied/target/wasm32-unknown-unknown/release'), {recursive: true});",
    "fs.mkdirSync(path.join(out, 'pipeline/applied/target/debug/incremental'), {recursive: true});",
    "fs.mkdirSync(path.join(out, 'pipeline/applied/sputnikdao2/src'), {recursive: true});",
    "fs.writeFileSync(path.join(out, 'pipeline/applied/target/wasm32-unknown-unknown/release/sputnikdao2.wasm'), Buffer.from([0, 97, 115, 109]));",
    "fs.writeFileSync(path.join(out, 'pipeline/applied/target/debug/incremental/cache.bin'), 'cache');",
    "fs.writeFileSync(path.join(out, 'pipeline/applied/sputnikdao2/src/proposals.rs'), 'fixture source');",
    "fs.writeFileSync(path.join(out, 'pipeline/pipeline.json'), JSON.stringify({paths: [process.env.HOME]}));",
    "fs.writeFileSync(path.join(out, 'pipeline/candidate-identity.json'), JSON.stringify({source: 'fixture'}));",
    "fs.writeFileSync(path.join(out, 'review-status.json'), JSON.stringify({status: 'accepted', checks: [{id: 'bond-recovered-once', status: 'pass', detail: 'fixture'}], summary: {firstRecovery: {gross: '1 NEAR', endedFailed: true}, retry: {}, healthy: {settledTransfer: '0.1 NEAR', pendingTransfer: '0.1 NEAR'}}, verified: {patchSha256: 'a'.repeat(64), builtWasmSha256: 'b'.repeat(64), sourceCommitPinned: 'fixture-commit'}, policy: {policySha256: 'c'.repeat(64)}}));",
    "fs.writeFileSync(path.join(out, 'review-report.md'), '# fixture accepted\\n');",
    "process.exit(0);",
  ].join('\n');
}

fs.mkdirSync(routeDir, {recursive: true});
fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
fs.mkdirSync(path.join(root, 'case-triage/rehearsal-repair'), {recursive: true});
fs.mkdirSync(source, {recursive: true});
fs.mkdirSync(sandbox, {recursive: true});
fs.copyFileSync(path.join(__dirname, 'patch-route.cjs'), routeFile);
fs.copyFileSync(path.join(__dirname, '../../case-triage/rehearsal-repair/review-bundle.cjs'), path.join(root, 'case-triage/rehearsal-repair/review-bundle.cjs'));
fs.writeFileSync(path.join(root, 'case-triage/rehearsal-repair/controller-manifest.json'), JSON.stringify({source: {commit: 'fixture-commit'}}));
fs.writeFileSync(cli, fakeChecker());
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(__dirname, '../../', name), path.join(root, name));
fs.mkdirSync(path.join(root, 'LICENSES'), {recursive: true});
fs.copyFileSync(path.join(__dirname, '../../LICENSES/sputnik-dao-contract-MIT.txt'), path.join(root, 'LICENSES/sputnik-dao-contract-MIT.txt'));

process.env.REPAIR_SOURCE_DIR = source;
process.env.REPAIR_SANDBOX_DIR = sandbox;

(async () => {
  const adapter = require(routeFile);
  const send = (res, n, obj) => { res.writeHead(n, {'content-type': 'application/json'}); res.end(JSON.stringify(obj)); };
  const server = http.createServer((req, res) => adapter.handle({req, res, url: new URL(req.url, 'http://127.0.0.1'), send}).catch((e) => send(res, 400, {error: e.message})));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const started = await fetch(`${origin}/api/patch/runs`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({patch: 'fixture diff'})}).then((r) => r.json());
    let run;
    for (let i = 0; i < 100; i++) {
      run = await fetch(`${origin}/api/patch/runs/${started.id}`).then((r) => r.json());
      if (run.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(run.status, 'accepted');
    assert.ok(run.packageName, 'terminal run materializes a package');
    const packageFile = path.join(root, '.local/browser-patch-runs', started.id, run.packageName);
    assert.ok(fs.existsSync(packageFile));
    const listing = spawnSync('unzip', ['-l', packageFile], {encoding: 'utf8', timeout: 15_000});
    assert.equal(listing.status, 0);
    assert.match(listing.stdout, /artifact\/sputnikdao2\.wasm/);
    assert.match(listing.stdout, /source\/proposals\.rs/);
    assert.match(listing.stdout, /LICENSE/);
    assert.match(listing.stdout, /THIRD_PARTY_NOTICES\.md/);
    assert.doesNotMatch(listing.stdout, /applied\/|target\/|Cargo\.lock|incremental/);
    const meta = spawnSync('unzip', ['-p', packageFile, 'run.json'], {encoding: 'utf8', timeout: 15_000});
    assert.equal(meta.status, 0);
    assert.match(meta.stdout, /"status": "accepted"/);
    assert.match(meta.stdout, /"exitCode": 0/);
    assert.match(meta.stdout, /"termination": "process-closed"/);
    assert.doesNotMatch(meta.stdout, /"status": "running"/);
    const readme = spawnSync('unzip', ['-p', packageFile, 'README.md'], {encoding: 'utf8', timeout: 15_000});
    assert.match(readme.stdout, /Package format: 3/);
    assert.match(readme.stdout, /Get the checker before running/);
    assert.match(readme.stdout, /does \*\*not\*\* include the Rehearsal application checkout/);
    assert.doesNotMatch(readme.stdout, /\/workspace|\/tmp\//);
    console.log('patch package: final metadata precedes packaging and the allowlist excludes the Cargo tree');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().finally(() => fs.rmSync(root, {recursive: true, force: true})).catch((error) => { console.error(error); process.exitCode = 1; });
