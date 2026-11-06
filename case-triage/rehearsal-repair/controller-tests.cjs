'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verifyPatch} = require('./repair-controller.cjs');
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

assert.ok(verifyPatch('', manifest).length > 0);
console.log('rejected: empty patch');

console.log(JSON.stringify({
  schema: 'near-rehearsal/repair-controller-tests/v1',
  positiveControl: true,
  cases: ['authored-source-only', 'build-config', 'controller-test', 'path-escape', 'empty'],
  passed: true,
}, null, 2));
