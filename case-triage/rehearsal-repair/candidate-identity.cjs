'use strict';
/*
 * Controller-owned identity for a model candidate.
 *
 * The model never supplies this file. After a clean apply and build, the
 * controller reads the patch, the applied allowlisted source and the built
 * WASM, hashes them here, and passes the result to acceptance. Acceptance
 * re-hashes the same files when it is given the candidate paths.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeIdentity({patch, source, wasm, sourcePath, commit, manifestPath = path.join(here, 'controller-manifest.json')} = {}) {
  if (!patch || !source || !wasm) throw new Error('patch, applied source and wasm are required');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const allowed = manifest.allowedPaths || [];
  if (!sourcePath || !allowed.includes(sourcePath)) throw new Error(`source path is not allowlisted: ${sourcePath}`);
  if (!commit) commit = manifest?.source?.commit;
  if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('pinned source commit is invalid');
  for (const [name, file] of [['patch', patch], ['source', source], ['wasm', wasm]]) {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`${name} is not a file`);
  }
  return {
    schema: 'near-rehearsal/repair-candidate-identity/v1',
    source: {
      repository: manifest?.source?.repository || null,
      commit,
      path: sourcePath,
      sha256: sha256File(source),
    },
    patch: {sha256: sha256File(patch)},
    wasm: {
      sha256: sha256File(wasm),
      bytes: fs.statSync(wasm).size,
    },
    controller: {
      generatedAt: new Date().toISOString(),
      generatedBy: 'repair-candidate-identity/v1',
    },
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--patch') opts.patch = path.resolve(args[++i]);
    else if (args[i] === '--source') opts.source = path.resolve(args[++i]);
    else if (args[i] === '--wasm') opts.wasm = path.resolve(args[++i]);
    else if (args[i] === '--source-path') opts.sourcePath = args[++i];
    else if (args[i] === '--commit') opts.commit = args[++i];
    else if (args[i] === '--out') opts.out = path.resolve(args[++i]);
    else throw new Error(`unknown argument: ${args[i]}`);
  }
  try {
    if (!opts.out) throw new Error('--out is required');
    const identity = makeIdentity(opts);
    fs.mkdirSync(path.dirname(opts.out), {recursive: true});
    fs.writeFileSync(opts.out, `${JSON.stringify(identity, null, 2)}\n`);
    console.log(JSON.stringify(identity, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {makeIdentity, sha256File};
