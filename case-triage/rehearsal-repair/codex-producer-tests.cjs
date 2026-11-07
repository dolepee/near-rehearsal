'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {buildCodexArgv, extractPatch, normalizePatch, prepareRuntime, cleanupRuntime} = require('./codex-producer.cjs');

const checks = [];
function check(name, fn) {
  try { fn(); checks.push(name); }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

const file = 'sputnikdao2/src/proposals.rs';
const original = 'first line\nsecond line\n';
const malformed = [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -1,99 +1,99 @@',
  '-first line',
  '+FIRST LINE',
  '',
].join('\n');

check('extract fenced malformed diff', () => {
  const text = 'Here is the repair:\n```diff\n' + malformed + '```\nDone.';
  const patch = extractPatch(text);
  assert.match(patch, /^diff --git /);
  assert.match(patch, /\+FIRST LINE/);
});

check('tool-free argv', () => {
  const args = buildCodexArgv({workspace: '/tmp/ws', lastMessage: '/tmp/last', noDaemon: true});
  assert.equal(args.includes('--sandbox'), false);
  assert.equal(args.includes('-s'), false);
  assert.equal(args.includes('--no-daemon'), true);
  assert.equal(args.includes('--ephemeral'), true);
  assert.equal(args.includes('--ignore-user-config'), true);
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'code_mode_host']) {
    const at = args.indexOf(feature);
    assert.notEqual(at, -1, `${feature} disabled`);
    assert.equal(args[at - 1], '--disable');
  }
});

check('recount canonicalization', () => {
  const result = normalizePatch(malformed, original, file);
  assert.deepEqual(result.changedPaths, [file]);
  assert.match(result.patch, /^diff --git /);
  assert.match(result.patch, /\+FIRST LINE/);
  assert.equal(result.changedSource.startsWith('FIRST LINE'), true);
});

check('unexpected changed path rejected', () => {
  const extra = [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    '-first line',
    '+FIRST LINE',
    'diff --git a/extra.txt b/extra.txt',
    '--- /dev/null',
    '+++ b/extra.txt',
    '@@ -0,0 +1 @@',
    '+intruder',
    '',
  ].join('\n');
  assert.throws(() => normalizePatch(extra, original, file), /unexpected path|unexpected paths|rejected the agent diff/);
});

check('runtime auth is a transient read-only reference', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-provider-test-'));
  const auth = path.join(root, 'auth.json');
  fs.writeFileSync(auth, '{"token":"fixture-only"}\n');
  const runtimeDir = path.join(root, 'runtime');
  const runtime = prepareRuntime({privateRuntime: runtimeDir, authSource: auth});
  try {
    assert.equal(fs.lstatSync(path.join(runtimeDir, 'auth.json')).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(path.join(runtimeDir, 'auth.json')), fs.realpathSync(auth));
    assert.equal(fs.statSync(runtimeDir).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(auth, 'utf8'), '{"token":"fixture-only"}\n');
  } finally {
    cleanupRuntime(runtime);
  }
  assert.equal(fs.existsSync(runtimeDir), false);
  assert.equal(fs.readFileSync(auth, 'utf8'), '{"token":"fixture-only"}\n');
});



check('raw symlink/type changes rejected before apply', () => {
  const sentinel = path.join(os.tmpdir(), `repair-sentinel-${process.pid}`);
  fs.writeFileSync(sentinel, 'harmless external sentinel\n');
  const raw = [
    `diff --git a/${file} b/${file}`,
    'new file mode 120000',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${file}`,
    '@@ -0,0 +1 @@',
    `+${sentinel}`,
    '',
  ].join('\n');
  assert.throws(() => normalizePatch(raw, original, file), /unsafe patch metadata|new or deleted/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'harmless external sentinel\n');
  fs.rmSync(sentinel, {force: true});
});

check('one-command adapter with fake tool-free CLI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-producer-test-'));
  const wrapper = path.join(root, 'sandbox.sh');
  const fake = path.join(root, 'fake-codex.cjs');
  const fixture = path.join(root, 'source');
  const out = path.join(root, 'out');
  fs.mkdirSync(path.join(fixture, 'sputnikdao2/src'), {recursive: true});
  fs.writeFileSync(path.join(fixture, file), original);
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'base']]) {
    const result = require('node:child_process').spawnSync('git', args, {cwd: fixture, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  const commit = require('node:child_process').spawnSync('git', ['rev-parse', 'HEAD'], {cwd: fixture, encoding: 'utf8'}).stdout.trim();
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({source: {commit}, allowedPaths: [file]}));
  fs.writeFileSync(wrapper, [
    '#!/bin/sh',
    'workspace="$1"; shift',
    'case " $* " in *repair.patch*|*.sandbox-write-probe*) exit 1;; esac',
    'exec "$@"',
    '',
  ].join('\n'));
  fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(fake, [
    '#!/usr/bin/env node',
    "const fs=require('fs'),path=require('path');",
    'const a=process.argv.slice(2);',
    "const input=fs.readFileSync(0,'utf8'); fs.writeFileSync(path.join(process.cwd(),'prompt-capture.txt'),input);",
    "const cd=a[a.indexOf('--cd')+1];",
    "const last=a[a.indexOf('--output-last-message')+1];",
    "const f='sputnikdao2/src/proposals.rs';",
    "const N=String.fromCharCode(10); const p=path.join(cd,f); const first=fs.readFileSync(p,'utf8').split(N)[0];",
    "const diff=`--- a/${f}${N}+++ b/${f}${N}@@ -1,99 +1,99 @@${N}-${first}${N}+// producer fixture${N}`;",
    "fs.mkdirSync(path.dirname(last),{recursive:true}); fs.writeFileSync(last,'```diff'+N+diff+'```'+N);",
    "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'message',text:'```diff'+N+diff+'```'}})+N);",
    '',
  ].join('\n'));
  fs.chmodSync(fake, 0o755);
  const auth = path.join(root, 'auth.json');
  fs.writeFileSync(auth, '{"token":"fixture-only"}\n');
  const env = {...process.env, MODEL_PRODUCER_SANDBOX_CMD: JSON.stringify(['/bin/sh', wrapper, '{workspace}'])};
  const result = spawnSync(process.execPath, [path.join(__dirname, 'codex-producer.cjs'), '--source', fixture, '--manifest', manifest, '--out', out, '--profile', 'test-profile', '--private-runtime', path.join(root, 'runtime'), '--auth-source', auth, '--codex-bin', fake, '--no-pipeline'], {encoding: 'utf8', timeout: 60000, env});
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'producer.json')));
  assert.deepEqual(report.changedPaths, [file]);
  assert.match(report.canonicalPatchSha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(out, 'attempt', 'transcript.jsonl')), true);
  assert.equal(fs.existsSync(path.join(out, 'attempt', 'raw.patch')), true);
  assert.equal(fs.existsSync(path.join(root, 'runtime')), false);
  const capturedPrompt = fs.readFileSync(path.join(report.workspace, 'prompt-capture.txt'), 'utf8');
  assert.match(capturedPrompt, /Pinned source \(sputnikdao2\/src\/proposals\.rs\):/);
  assert.match(capturedPrompt, /first line/);
});

console.log(JSON.stringify({schema: 'near-rehearsal/codex-producer-tests/v1', passed: true, checks}, null, 2));
