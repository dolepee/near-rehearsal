'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawnSync} = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-patch-persistence-'));
const routeDir = path.join(root, 'ui/sputnik');
const runsRoot = path.join(root, '.local/browser-patch-runs');
fs.mkdirSync(routeDir, {recursive: true});
fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
fs.mkdirSync(path.join(root, 'case-triage/rehearsal-repair'), {recursive: true});
fs.writeFileSync(path.join(root, 'case-triage/rehearsal-repair/controller-manifest.json'), JSON.stringify({source: {commit: '5434a59dec23ee0c49df8c8c4350c208a7e75b0b'}}));
fs.writeFileSync(path.join(root, 'scripts/review-patch.cjs'), 'throw new Error("A restart or result read must not start the checker");');
fs.copyFileSync(path.join(__dirname, 'patch-route.cjs'), path.join(routeDir, 'patch-route.cjs'));
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(__dirname, '../../', name), path.join(root, name));
fs.mkdirSync(path.join(root, 'LICENSES'), {recursive: true});
fs.copyFileSync(path.join(__dirname, '../../LICENSES/sputnik-dao-contract-MIT.txt'), path.join(root, 'LICENSES/sputnik-dao-contract-MIT.txt'));

const acceptedId = '11111111-1111-4111-8111-111111111111';
const interruptedId = '22222222-2222-4222-8222-222222222222';
function completed(id, status) {
  const dir = path.join(runsRoot, id);
  fs.mkdirSync(path.join(dir, 'evidence'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'submitted.patch'), 'diff --git a/x b/x\n');
  fs.writeFileSync(path.join(dir, 'evidence/review-status.json'), JSON.stringify({
    status,
    checks: [{id: 'bond-recovered-once', status: status === 'accepted' ? 'pass' : 'fail', detail: 'fixture'}],
    summary: {firstRecovery: {gross: status === 'accepted' ? '1 NEAR' : '0 NEAR', endedFailed: true}, retry: {gross: '0 NEAR'}, healthy: {settledTransfer: '0.1 NEAR', pendingTransfer: '0.1 NEAR'}},
    verified: {patchSha256: 'a'.repeat(64), builtWasmSha256: status === 'accepted' ? 'b'.repeat(64) : null, sourceCommitPinned: '5434a59dec23ee0c49df8c8c4350c208a7e75b0b'},
    policy: {policySha256: 'c'.repeat(64)},
  }));
  fs.writeFileSync(path.join(dir, 'evidence/review-report.md'), `# fixture ${status}\n`);
  if (status === 'accepted') {
    const pipeline = path.join(dir, 'evidence/pipeline');
    fs.mkdirSync(path.join(pipeline, 'applied/target/wasm32-unknown-unknown/release'), {recursive: true});
    fs.mkdirSync(path.join(pipeline, 'applied/sputnikdao2/src'), {recursive: true});
    fs.writeFileSync(path.join(pipeline, 'applied/target/wasm32-unknown-unknown/release/sputnikdao2.wasm'), Buffer.from([0, 97, 115, 109]));
    fs.mkdirSync(path.join(pipeline, 'applied/target/debug/incremental'), {recursive: true});
    fs.writeFileSync(path.join(pipeline, 'applied/target/debug/incremental/cache.bin'), 'cache');
    fs.writeFileSync(path.join(pipeline, 'applied/Cargo.lock'), 'lock');
    fs.mkdirSync(path.join(pipeline, 'applied/sputnikdao2/target/release'), {recursive: true});
    fs.writeFileSync(path.join(pipeline, 'applied/sputnikdao2/target/release/object.o'), 'object');
    fs.writeFileSync(path.join(pipeline, 'applied/sputnikdao2/src/proposals.rs'), 'fixture source\n');
    fs.writeFileSync(path.join(pipeline, 'candidate-identity.json'), '{}');
    fs.writeFileSync(path.join(pipeline, 'pipeline.json'), '{}');
    fs.writeFileSync(path.join(pipeline, 'build.log'), 'exit=0\n');
    fs.writeFileSync(path.join(pipeline, 'replay.log'), 'fixture\n');
  }
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({schema: 'near-rehearsal/patch-browser-run/v1', id, status, createdAt: '2026-11-13T10:00:00.000Z', finishedAt: '2026-11-13T10:01:00.000Z', patchSha256: 'a'.repeat(64), checkerRevision: 'f'.repeat(40), exitCode: status === 'accepted' ? 0 : 1, signal: null, termination: 'process-closed'}));
}
completed(acceptedId, 'accepted');
const oldStage = path.join(root, 'old-package');
fs.mkdirSync(oldStage, {recursive: true});
fs.writeFileSync(path.join(oldStage, 'README.md'), '# old package\n');
fs.writeFileSync(path.join(oldStage, 'run.json'), JSON.stringify({status: 'running'}));
spawnSync('zip', ['-q', '-r', path.join(runsRoot, acceptedId, 'review-package.zip'), '.'], {cwd: oldStage, timeout: 15_000});
fs.mkdirSync(path.join(runsRoot, interruptedId), {recursive: true});
fs.writeFileSync(path.join(runsRoot, interruptedId, 'submitted.patch'), 'diff --git a/x b/x\n');
fs.mkdirSync(path.join(runsRoot, interruptedId, 'evidence'), {recursive: true});
fs.writeFileSync(path.join(runsRoot, interruptedId, 'evidence/review-status.json'), JSON.stringify({status: 'accepted', checks: [{id: 'leftover', status: 'pass'}], summary: {retry: {gross: '0 NEAR'}}, verified: {patchSha256: 'd'.repeat(64)}, policy: {policySha256: 'e'.repeat(64)}}));
fs.writeFileSync(path.join(runsRoot, interruptedId, 'evidence/review-report.md'), '# leftover accepted report\n');
fs.writeFileSync(path.join(runsRoot, interruptedId, 'run.json'), JSON.stringify({schema: 'near-rehearsal/patch-browser-run/v1', id: interruptedId, status: 'running', createdAt: '2026-11-13T10:02:00.000Z', finishedAt: null, patchSha256: 'd'.repeat(64), checkerRevision: 'f'.repeat(40), exitCode: null, signal: null, termination: null}));
const missingStatusId = '33333333-3333-4333-8333-333333333333';
const missingStatusDir = path.join(runsRoot, missingStatusId);
fs.mkdirSync(path.join(missingStatusDir, 'evidence'), {recursive: true});
fs.writeFileSync(path.join(missingStatusDir, 'submitted.patch'), 'diff --git a/x b/x\n');
fs.writeFileSync(path.join(missingStatusDir, 'evidence/review-report.md'), '# accepted-looking report without status\n');
fs.writeFileSync(path.join(missingStatusDir, 'run.json'), JSON.stringify({schema: 'near-rehearsal/patch-browser-run/v1', id: missingStatusId, status: 'accepted', createdAt: '2026-11-13T10:03:00.000Z', finishedAt: '2026-11-13T10:04:00.000Z', patchSha256: 'f'.repeat(64), checkerRevision: 'f'.repeat(40), exitCode: 0, signal: null, termination: 'process-closed'}));

const route = require(path.join(routeDir, 'patch-route.cjs'));
const runs = route.list();
assert.equal(runs.find((run) => run.id === acceptedId).status, 'accepted');
assert.equal(runs.find((run) => run.id === interruptedId).status, 'inconclusive');
assert.match(runs.find((run) => run.id === interruptedId).note, /restarted|not accepted/);
assert.equal(runs.find((run) => run.id === missingStatusId).status, 'inconclusive', 'accepted metadata without review-status.json is not accepted');
assert.equal(fs.readFileSync(path.join(runsRoot, acceptedId, 'run.json'), 'utf8').includes('"accepted"'), true);

(async () => {
  const send = (res, n, obj) => { res.writeHead(n, {'content-type': 'application/json'}); res.end(JSON.stringify(obj)); };
  const server = http.createServer((req, res) => route.handle({req, res, url: new URL(req.url, 'http://127.0.0.1'), send}).catch((e) => send(res, 400, {error: e.message})));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const one = await fetch(`${origin}/api/patch/runs/${acceptedId}`).then((r) => r.json());
    assert.equal(one.status, 'accepted');
    assert.ok(one.summary.firstRecovery.gross, 'completed summary survives reload');
    const list = await fetch(`${origin}/api/patch/runs`).then((r) => r.json());
    assert.equal(list.runs.length, 3);
    const pkg = await fetch(`${origin}/api/patch/runs/${acceptedId}/package`);
    assert.equal(pkg.status, 200);
    const bytes = Buffer.from(await pkg.arrayBuffer());
    assert.ok(bytes.length > 100, 'package has bytes');
    const file = path.join(runsRoot, acceptedId, 'review-package.zip');
    assert.ok(fs.existsSync(file), 'zip package is materialized');
    const listing = spawnSync('unzip', ['-l', file], {encoding: 'utf8', timeout: 15_000});
    assert.equal(listing.status, 0);
    assert.match(listing.stdout, /submitted\.patch/);
    assert.match(listing.stdout, /evidence\/review-status\.json/);
    assert.match(listing.stdout, /README\.md/);
    assert.match(listing.stdout, /SHA256SUMS/);
    const packageMarker = spawnSync('unzip', ['-p', file, 'README.md'], {encoding: 'utf8', timeout: 15_000});
    assert.match(packageMarker.stdout, /Package format: 2/);
    assert.doesNotMatch(packageMarker.stdout, /^# old package/m);
    assert.match(listing.stdout, /REPRODUCE|review-report\.md/);
    assert.match(listing.stdout, /artifact\/sputnikdao2\.wasm/);
    assert.match(listing.stdout, /source\/proposals\.rs/);
    assert.match(listing.stdout, /LICENSE/);
    assert.match(listing.stdout, /THIRD_PARTY_NOTICES\.md/);
    assert.match(listing.stdout, /licenses\/sputnik-dao-contract-MIT\.txt/);
    assert.doesNotMatch(listing.stdout, /applied\/|target\/|Cargo\.lock/);
    const packageReadme = spawnSync('unzip', ['-p', file, 'README.md'], {encoding: 'utf8', timeout: 15_000});
    assert.match(packageReadme.stdout, /No Cargo build tree/);
    assert.match(packageReadme.stdout, /artifact\/sputnikdao2\.wasm/);
    assert.match(packageReadme.stdout, /Get the checker before running/);
    assert.match(packageReadme.stdout, /does \*\*not\*\* include the Rehearsal application checkout/);
    assert.doesNotMatch(packageReadme.stdout, /\/workspace|\/tmp\//);
    assert.doesNotMatch(packageReadme.stdout, /applied\/|target\/|Cargo\.lock/);
    const packagedRun = spawnSync('unzip', ['-p', file, 'run.json'], {encoding: 'utf8', timeout: 15_000});
    assert.equal(packagedRun.status, 0);
    assert.match(packagedRun.stdout, /"status":"accepted"/);
    assert.doesNotMatch(packagedRun.stdout, /"status":"running"/);
    const incomplete = await fetch(`${origin}/api/patch/runs/${interruptedId}/package`);
    assert.equal(incomplete.status, 200);
    const incompleteFile = path.join(runsRoot, interruptedId, 'review-package.zip');
    assert.ok(fs.existsSync(incompleteFile), 'interrupted run still has an evidence package');
    const incompleteListing = spawnSync('unzip', ['-l', incompleteFile], {encoding: 'utf8', timeout: 15_000});
    assert.equal(incompleteListing.status, 0);
    assert.match(incompleteListing.stdout, /submitted\.patch/);
    assert.match(incompleteListing.stdout, /run\.json/);
    const incompleteReadme = spawnSync('unzip', ['-p', incompleteFile, 'README.md'], {encoding: 'utf8', timeout: 15_000});
    assert.equal(incompleteReadme.status, 0);
    assert.match(incompleteReadme.stdout, /inconclusive|not accepted evidence|No completed checker report/i);
    const missing = await fetch(`${origin}/api/patch/runs/44444444-4444-4444-8444-444444444444`).then((r) => r.status);
    assert.equal(missing, 404);
    console.log('patch persistence: completed results load, interrupted runs become inconclusive, package includes patch/evidence/checksums/reproduce instructions');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().finally(() => fs.rmSync(root, {recursive: true, force: true})).catch((error) => { console.error(error); process.exitCode = 1; });
