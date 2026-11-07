'use strict';
/*
 * Controller-side source-only guard.
 *
 * It validates every patch section, not just `diff --git` headers, and can
 * apply the patch in a fresh copy of the pinned source tree to enumerate the
 * paths that actually changed. It never runs the acceptance suite or signs a
 * result.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const MAX_BUFFER = 256 * 1024 * 1024;

function normalizePath(raw) {
  let file = String(raw || '').trim();
  if (!file || file.startsWith('"') || file.startsWith('/') || file.includes('\\') || file.includes('\0')) {
    throw new Error(`patch path is not contained: ${raw}`);
  }
  if (file.startsWith('a/') || file.startsWith('b/')) file = file.slice(2);
  if (!file || file !== file.trim() || file.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`patch path is not contained: ${raw}`);
  }
  if (/\s/.test(file)) throw new Error(`patch path is ambiguous: ${raw}`);
  return file;
}

function headerPath(line, marker) {
  if (!line.startsWith(marker)) throw new Error(`malformed patch header: ${line}`);
  return normalizePath(line.slice(marker.length));
}

function parseGitHeader(line) {
  const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  if (!match) throw new Error(`patch has an ambiguous diff --git header: ${line}`);
  const oldPath = normalizePath(match[1]);
  const newPath = normalizePath(match[2]);
  if (oldPath !== newPath) throw new Error(`patch has mixed paths: ${oldPath} -> ${newPath}`);
  return oldPath;
}

function parseHunk(line) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) throw new Error(`malformed hunk header: ${line}`);
  return {
    old: match[2] === undefined ? 1 : Number(match[2]),
    new: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function scanSections(patch) {
  const lines = String(patch).split('\n');
  const sections = [];
  let current = [];
  let hunk = null;
  const finalize = () => {
    if (current.length) sections.push(current);
    current = [];
  };

  for (const line of lines) {
    if (hunk) {
      if (hunk.old === 0 && hunk.new === 0) {
        if (line.startsWith('\\ No newline at end of file')) {
          continue;
        }
        hunk = null;
      } else {
        if (line.startsWith('\\ No newline at end of file')) {
          continue;
        }
        if (line.startsWith('+')) {
          hunk.new -= 1;
          continue;
        }
        if (line.startsWith('-')) {
          hunk.old -= 1;
          continue;
        }
        if (line.startsWith(' ') || line === '') {
          hunk.old -= 1;
          hunk.new -= 1;
          continue;
        }
        throw new Error(`malformed hunk body: ${line}`);
      }
    }

    if (line.startsWith('@@')) {
      if (!current.length) throw new Error('hunk appears before a patch section');
      current.push(line);
      hunk = parseHunk(line);
      continue;
    }

    if (line.startsWith('diff --git ')) {
      finalize();
      current = [line];
      continue;
    }

    if (line.startsWith('--- ')) {
      const inGitSection = current.length && current[0].startsWith('diff --git ');
      const hasOldHeader = current.some((item) => item.startsWith('--- '));
      if (inGitSection && !hasOldHeader) {
        current.push(line);
      } else {
        finalize();
        current = [line];
      }
      continue;
    }

    if (line.startsWith('+++ ')) {
      if (!current.length || !current.some((item) => item.startsWith('--- '))) {
        throw new Error('new-file header without an old-file header');
      }
      current.push(line);
      continue;
    }

    if (!current.length) {
      if (line.trim()) throw new Error(`patch content before a section: ${line}`);
      continue;
    }
    current.push(line);
  }

  finalize();
  if (hunk) throw new Error('hunk has an incomplete body');
  return sections;
}

function parseSection(lines) {
  const errors = [];
  const first = lines[0];
  let headerPathValue = null;
  let oldPath = null;
  let newPath = null;
  let hunkSeen = false;
  let cursor = 0;

  try {
    if (first.startsWith('diff --git ')) {
      headerPathValue = parseGitHeader(first);
      cursor = 1;
    } else if (!first.startsWith('--- ')) {
      throw new Error(`patch section does not start with a header: ${first}`);
    }

    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.startsWith('--- ')) {
        if (oldPath !== null) throw new Error('patch section has multiple old-file headers');
        oldPath = headerPath(line, '--- ');
        const next = lines[cursor + 1];
        if (!next || !next.startsWith('+++ ')) throw new Error('old-file header has no matching new-file header');
        newPath = headerPath(next, '+++ ');
        cursor += 1;
        if (oldPath !== newPath) throw new Error(`patch has mixed paths: ${oldPath} -> ${newPath}`);
        if (headerPathValue && headerPathValue !== oldPath) throw new Error(`diff --git path differs from section header: ${headerPathValue} -> ${oldPath}`);
        continue;
      }
      if (line.startsWith('+++ ')) throw new Error('new-file header without an old-file header');
      if (line.startsWith('@@')) {
        if (oldPath === null) throw new Error('hunk appears before file headers');
        hunkSeen = true;
        continue;
      }
      if (line === '' || line.startsWith('\\ No newline at end of file')) continue;
      if (/^(index |old mode |new mode |similarity index )/.test(line)) {
        if (/^(old mode |new mode )/.test(line)) throw new Error(`mode-changing patch is not source-only: ${line}`);
        continue;
      }
      if (/^(deleted file mode |new file mode |rename from |rename to |copy from |copy to |Binary files |GIT binary patch)/.test(line)) {
        throw new Error(`patch changes file identity or encoding: ${line}`);
      }
      throw new Error(`unrecognized patch metadata: ${line}`);
    }

    if (!headerPathValue && oldPath) headerPathValue = oldPath;
    if (!headerPathValue || !oldPath || !newPath) throw new Error('patch section has no effective target');
    if (!hunkSeen) throw new Error('patch section has no hunk');
    return {path: headerPathValue, oldPath, newPath, errors};
  } catch (error) {
    errors.push(error.message);
    return {path: headerPathValue || oldPath || newPath, oldPath, newPath, errors};
  }
}

function parsePatch(patch) {
  const text = String(patch || '');
  if (!text.trim()) return {sections: [], paths: [], errors: ['patch is empty']};
  let sections;
  try {
    sections = scanSections(text);
  } catch (error) {
    return {sections: [], paths: [], errors: [error.message]};
  }
  const parsed = sections.map(parseSection);
  const errors = parsed.flatMap((section) => section.errors);
  const paths = [...new Set(parsed.flatMap((section) => [section.oldPath, section.newPath, section.path]).filter(Boolean))];
  return {sections: parsed, paths, errors};
}

function patchPaths(patch) {
  return parsePatch(patch).paths;
}

function verifyPatch(patch, manifest) {
  const parsed = parsePatch(patch);
  if (parsed.errors.length) return parsed.errors;
  const errors = [];
  const allowed = new Set(manifest.allowedPaths || []);
  const forbidden = manifest.forbiddenPaths || [];
  const seen = new Set();
  const changed = new Set();

  for (const section of parsed.sections) {
    const file = section.path;
    if (seen.has(file)) errors.push(`patch target is repeated or ambiguous: ${file}`);
    seen.add(file);
    changed.add(file);
    if (!file || path.isAbsolute(file) || file.split('/').includes('..')) errors.push(`patch path is not contained: ${file}`);
    if (!allowed.has(file)) errors.push(`patch path is not allowlisted: ${file}`);
    if (forbidden.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))) errors.push(`patch path is forbidden: ${file}`);
  }
  if (![...allowed].some((file) => changed.has(file))) errors.push('patch does not touch an allowlisted source file');
  return [...new Set(errors)];
}

function runGit(args, cwd, input, encoding = 'utf8') {
  return spawnSync('git', args, {
    cwd,
    input,
    encoding,
    timeout: 120000,
    maxBuffer: MAX_BUFFER,
    env: {...process.env, GIT_CONFIG_NOSYSTEM: '1'},
  });
}

function makeFreshTree(sourceDir) {
  const archive = runGit(['-C', sourceDir, 'archive', '--format=tar', 'HEAD'], process.cwd(), undefined, null);
  if (archive.status !== 0) throw new Error(`cannot archive pinned source: ${(archive.stderr || archive.stdout || '').trim()}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-apply-'));
  try {
    const extract = spawnSync('tar', ['-xf', '-', '-C', temp], {
      input: archive.stdout,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: MAX_BUFFER,
    });
    if (extract.status !== 0) throw new Error(`cannot extract pinned source: ${(extract.stderr || '').trim()}`);
    const init = runGit(['init', '-q'], temp);
    if (init.status !== 0) throw new Error(`cannot initialize disposable tree: ${(init.stderr || '').trim()}`);
    const add = runGit(['add', '-A'], temp);
    if (add.status !== 0) throw new Error(`cannot stage disposable tree: ${(add.stderr || '').trim()}`);
    const commit = runGit(['-c', 'user.name=repair-controller', '-c', 'user.email=repair-controller@localhost', 'commit', '-qm', 'base'], temp);
    if (commit.status !== 0) throw new Error(`cannot commit disposable tree: ${(commit.stderr || '').trim()}`);
    return temp;
  } catch (error) {
    fs.rmSync(temp, {recursive: true, force: true});
    throw error;
  }
}

function changedPaths(temp) {
  const result = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], temp);
  if (result.status !== 0) throw new Error(`cannot enumerate applied changes: ${(result.stderr || '').trim()}`);
  const paths = new Set();
  for (const entry of String(result.stdout || '').split('\0')) {
    if (!entry) continue;
    if (entry[0] === 'R' || entry[0] === 'C') throw new Error('renamed or copied path is not source-only');
    if (entry.length < 4) throw new Error(`malformed applied-change entry: ${entry}`);
    paths.add(entry.slice(3));
  }
  return [...paths];
}

function applyPatchInFreshTree(patch, sourceDir) {
  const temp = makeFreshTree(sourceDir);
  try {
    const check = runGit(['apply', '--check', '--whitespace=nowarn', '-'], temp, patch);
    if (check.status !== 0) throw new Error(`git apply --check failed: ${(check.stderr || check.stdout || '').trim()}`);
    const apply = runGit(['apply', '--whitespace=nowarn', '-'], temp, patch);
    if (apply.status !== 0) throw new Error(`git apply failed: ${(apply.stderr || apply.stdout || '').trim()}`);
    return changedPaths(temp);
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
}

function verifyPatchInTree(patch, manifest, sourceDir) {
  const staticErrors = verifyPatch(patch, manifest);
  if (staticErrors.length) return {errors: staticErrors, changedPaths: []};
  if (!sourceDir) return {errors: ['a pinned source tree is required for apply verification'], changedPaths: []};
  try {
    const head = runGit(['-C', sourceDir, 'rev-parse', 'HEAD'], process.cwd());
    if (head.status !== 0) throw new Error(`cannot read pinned source head: ${(head.stderr || '').trim()}`);
    const expected = manifest?.source?.commit;
    if (expected && String(head.stdout).trim() !== expected) {
      throw new Error(`source tree head ${String(head.stdout).trim()} does not match pinned ${expected}`);
    }
    const changed = applyPatchInFreshTree(patch, sourceDir);
    const allowed = new Set(manifest.allowedPaths || []);
    const errors = [];
    const changedSet = new Set(changed);
    for (const file of changedSet) {
      if (!allowed.has(file)) errors.push(`actual apply changed unallowlisted path: ${file}`);
    }
    if (![...allowed].some((file) => changedSet.has(file))) errors.push('actual apply did not change an allowlisted source file');
    return {errors, changedPaths: [...changedSet]};
  } catch (error) {
    return {errors: [error.message], changedPaths: []};
  }
}

if (require.main === module) {
  const patchFile = process.argv[2];
  const manifestFile = process.argv[3] || path.join(__dirname, 'controller-manifest.json');
  const sourceDir = process.argv[4] || process.env.REPAIR_SOURCE_DIR;
  if (!patchFile) {
    console.error('usage: node repair-controller.cjs <patch> [manifest] [source-dir]');
    process.exit(2);
  }
  try {
    const patch = fs.readFileSync(path.resolve(patchFile), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestFile), 'utf8'));
    const staticErrors = verifyPatch(patch, manifest);
    const applied = sourceDir && !staticErrors.length
      ? verifyPatchInTree(patch, manifest, path.resolve(sourceDir))
      : {errors: [], changedPaths: []};
    const errors = [...staticErrors, ...applied.errors];
    console.log(JSON.stringify({ok: errors.length === 0, errors, paths: patchPaths(patch), appliedPaths: applied.changedPaths}, null, 2));
    if (errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ok: false, errors: [error.message]}, null, 2));
    process.exitCode = 1;
  }
}

module.exports = {applyPatchInFreshTree, changedPaths, parsePatch, patchPaths, verifyPatch, verifyPatchInTree};
