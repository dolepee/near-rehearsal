'use strict';
/*
 * Build the model input from the task prompt plus only the allowlisted source
 * file at the pinned commit. It deliberately has no path for tests, the
 * authored patch, acceptance files or the rest of the source tree.
 */
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const here = __dirname;

function gitShow(sourceDir, file) {
  return spawnSync('git', ['-C', sourceDir, 'show', `HEAD:${file}`], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
    env: {...process.env, GIT_CONFIG_NOSYSTEM: '1'},
  });
}

function pinnedHead(sourceDir) {
  const result = spawnSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 30000,
    env: {...process.env, GIT_CONFIG_NOSYSTEM: '1'},
  });
  if (result.status !== 0) throw new Error(`cannot read pinned source head: ${(result.stderr || '').trim()}`);
  return String(result.stdout).trim();
}

function buildPrompt({sourceDir, promptPath = path.join(here, 'model-prompt.md'), manifestPath = path.join(here, 'controller-manifest.json')} = {}) {
  if (!sourceDir) throw new Error('a pinned source tree is required to build the model input');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const allowed = manifest.allowedPaths || [];
  if (allowed.length !== 1) throw new Error('model input requires exactly one allowlisted source file');
  const head = pinnedHead(sourceDir);
  const expected = manifest?.source?.commit;
  if (expected && head !== expected) throw new Error(`source tree head ${head} does not match pinned ${expected}`);

  const file = allowed[0];
  if (!file || path.isAbsolute(file) || file.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`allowlisted source path is not confined: ${file}`);
  }
  const shown = gitShow(sourceDir, file);
  if (shown.status !== 0) throw new Error(`cannot read allowlisted source ${file}: ${(shown.stderr || '').trim()}`);
  const task = fs.readFileSync(promptPath, 'utf8').trim();
  return [
    task,
    '',
    '## Pinned allowed source',
    '',
    `Commit: ${head}`,
    `Path: ${file}`,
    '',
    '----- BEGIN PINNED SOURCE -----',
    String(shown.stdout).replace(/\s+$/, ''),
    '----- END PINNED SOURCE -----',
    '',
    'Return a unified diff for this file only. Do not modify tests, acceptance files, Cargo configuration, build scripts, or any other path.',
    '',
  ].join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const source = args[0] || process.env.REPAIR_SOURCE_DIR;
  try {
    process.stdout.write(buildPrompt({sourceDir: source}));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {buildPrompt, pinnedHead};
