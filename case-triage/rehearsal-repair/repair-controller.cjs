'use strict';
/*
 * Controller-side allowlist check for a source-only repair patch.
 * It does not run a model, apply a patch, build, or sign anything.
 */
const fs = require('node:fs');
const path = require('node:path');

const patchPaths = (patch) => {
  const paths = new Set();
  for (const line of String(patch).split('\n')) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) {
      paths.add(match[1]);
      paths.add(match[2]);
    }
  }
  return [...paths];
};

function verifyPatch(patch, manifest) {
  const errors = [];
  const text = String(patch || '');
  if (!text.trim()) return ['patch is empty'];
  const allowed = new Set(manifest.allowedPaths || []);
  const forbidden = manifest.forbiddenPaths || [];
  const paths = patchPaths(text);
  if (!paths.length) errors.push('patch has no diff --git paths');
  for (const raw of paths) {
    const file = raw.replace(/^\.\//, '');
    if (path.isAbsolute(file) || file.split('/').includes('..')) errors.push(`patch path is not contained: ${raw}`);
    if (!allowed.has(file)) errors.push(`patch path is not allowlisted: ${file}`);
    if (forbidden.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))) errors.push(`patch path is forbidden: ${file}`);
  }
  const changed = new Set(paths);
  if (![...allowed].some((file) => changed.has(file))) errors.push('patch does not touch an allowlisted source file');
  return errors;
}

if (require.main === module) {
  const patchFile = process.argv[2];
  const manifestFile = process.argv[3] || path.join(__dirname, 'controller-manifest.json');
  if (!patchFile) {
    console.error('usage: node repair-controller.cjs <patch> [manifest]');
    process.exit(2);
  }
  try {
    const patch = fs.readFileSync(path.resolve(patchFile), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestFile), 'utf8'));
    const errors = verifyPatch(patch, manifest);
    console.log(JSON.stringify({ok: errors.length === 0, errors, paths: patchPaths(patch)}, null, 2));
    if (errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ok: false, errors: [error.message]}, null, 2));
    process.exitCode = 1;
  }
}

module.exports = {verifyPatch, patchPaths};
