'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {applyPatchInFreshTree, verifyPatch, verifyPatchInTree} = require('./repair-controller.cjs');
const here = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'controller-manifest.json'), 'utf8'));
const authored = fs.readFileSync(path.join(here, 'repair.patch'), 'utf8');
assert.deepEqual(verifyPatch(authored, manifest), []);
console.log('accepted: authored repair patch is source-only');

const forbidden = `diff --git a/sputnikdao2/src/proposals.rs b/sputnikdao2/src/proposals.rs
--- a/sputnikdao2/src/proposals.rs
+++ b/sputnikdao2/src/proposals.rs
@@ -1 +1 @@
-old
+new
diff --git a/Cargo.toml b/Cargo.toml
--- a/Cargo.toml
+++ b/Cargo.toml
@@ -1 +1 @@
-old
+new
`;
assert.ok(verifyPatch(forbidden, manifest).some((e) => /forbidden|not allowlisted/.test(e)));
console.log('rejected: build configuration in the patch');

const tests = `diff --git a/case-triage/rehearsal-repair/acceptance.cjs b/case-triage/rehearsal-repair/acceptance.cjs
--- a/case-triage/rehearsal-repair/acceptance.cjs
+++ b/case-triage/rehearsal-repair/acceptance.cjs
@@ -1 +1 @@
-old
+new
`;
assert.ok(verifyPatch(tests, manifest).some((e) => /forbidden|not allowlisted/.test(e)));
console.log('rejected: controller test path in the patch');

const escape = `diff --git a/../outside b/../outside
--- a/../outside
+++ b/../outside
@@ -1 +1 @@
-old
+new
`;
assert.ok(verifyPatch(escape, manifest).some((e) => /not contained|not allowlisted/.test(e)));
console.log('rejected: path escapes the source tree');

const mixed = `diff --git a/sputnikdao2/src/proposals.rs b/sputnikdao2/src/proposals.rs
--- a/sputnikdao2/src/proposals.rs
+++ b/sputnikdao2/src/proposals.rs
@@ -1 +1 @@
-old
+new
--- a/Cargo.toml
+++ b/Cargo.toml
@@ -1 +1 @@
-old
+new
`;
assert.ok(verifyPatch(mixed, manifest).some((e) => /Cargo\.toml/.test(e)));
console.log('rejected: traditional forbidden section after an allowed diff --git section');

assert.ok(verifyPatch('', manifest).length > 0);
console.log('rejected: empty patch');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-controller-test-'));
  fs.mkdirSync(path.join(dir, 'sputnikdao2', 'src'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'sputnikdao2', 'src', 'proposals.rs'), 'old\n');
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), 'old\n');
  execFileSync('git', ['init', '-q'], {cwd: dir});
  execFileSync('git', ['add', '-A'], {cwd: dir});
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'base'], {cwd: dir});
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: dir, encoding: 'utf8'}).trim();
  const testManifest = {...manifest, source: {...manifest.source, commit: head}};
  return {dir, manifest: testManifest};
}

const positiveTree = fixture();
try {
  const allowedApply = `diff --git a/sputnikdao2/src/proposals.rs b/sputnikdao2/src/proposals.rs
--- a/sputnikdao2/src/proposals.rs
+++ b/sputnikdao2/src/proposals.rs
@@ -1 +1 @@
-old
+new
`;
  const result = verifyPatchInTree(allowedApply, positiveTree.manifest, positiveTree.dir);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.changedPaths, ['sputnikdao2/src/proposals.rs']);
  console.log('accepted: apply enumeration sees exactly the allowed file');
} finally {
  fs.rmSync(positiveTree.dir, {recursive: true, force: true});
}

const mixedTree = fixture();
try {
  const changed = applyPatchInFreshTree(mixed, mixedTree.dir);
  assert.ok(changed.includes('sputnikdao2/src/proposals.rs'));
  assert.ok(changed.includes('Cargo.toml'));
  const result = verifyPatchInTree(mixed, mixedTree.manifest, mixedTree.dir);
  assert.ok(result.errors.some((e) => /Cargo\.toml/.test(e)));
  console.log('rejected: independent apply enumeration would expose Cargo.toml');
} finally {
  fs.rmSync(mixedTree.dir, {recursive: true, force: true});
}

console.log(JSON.stringify({
  schema: 'near-rehearsal/repair-controller-tests/v1',
  positiveControl: true,
  cases: [
    'authored-source-only',
    'build-config',
    'controller-test',
    'path-escape',
    'mixed-format-forbidden-section',
    'empty',
    'apply-enumeration-positive',
    'apply-enumeration-mixed',
  ],
  passed: true,
}, null, 2));
