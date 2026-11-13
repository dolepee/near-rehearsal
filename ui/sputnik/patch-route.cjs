'use strict';
// Adapter only. Candidate acceptance belongs to the versioned CLI.
//
// The browser job is durable: a run has an on-disk metadata record, its
// submitted diff and the checker's evidence. A server restart reloads terminal
// runs and marks an interrupted process inconclusive. Opening an old result
// never starts a new build.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const cli = path.join(root, 'scripts/review-patch.cjs');
const output = path.join(root, '.local/browser-patch-runs');
const manifest = require('../../case-triage/rehearsal-repair/controller-manifest.json');
const names = {status:'review-status.json',report:'review-report.md',patch:'submitted.patch'};
const max = 65536;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const memory = new Map();
let active = null;
let currentChild = null;
let stopping = false;

const STATUSES = ['accepted','rejected','input_error','build_error','inconclusive'];
const NOTES = {
  accepted: 'The candidate passed the declared checks for this local Sputnik case.',
  rejected: 'The candidate failed a defined check. Inspect the report before considering an upgrade.',
  input_error: 'The checker could not apply this input. No economic conclusion follows.',
  build_error: 'Compilation failed before the money checks could finish.',
  inconclusive: 'No complete, recognized checker verdict was available.',
};

function safeId(id) { return /^[a-f0-9-]{36}$/.test(String(id || '')); }
function dirFor(id) { return path.join(output, id); }
function metaPath(dir) { return path.join(dir, 'run.json'); }
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sha256File(file) { return sha256(fs.readFileSync(file)); }
function nowIso() { return new Date().toISOString(); }
function exists(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function dirExists(dir) { try { return fs.statSync(dir).isDirectory(); } catch { return false; } }

function artifactPath(dir, key) {
  if (key === 'patch') return path.join(dir, names.patch);
  if (key === 'package') {
    for (const name of ['review-package.zip', 'review-package.tar.gz']) {
      const file = path.join(dir, name);
      if (exists(file)) return file;
    }
    return null;
  }
  if (!['status', 'report'].includes(key)) return null;
  return path.join(dir, 'evidence', names[key]);
}
function artifact(dir, key) {
  const file = artifactPath(dir, key);
  if (!file || !exists(file) || fs.statSync(file).size > MAX_PACKAGE_BYTES) return null;
  try {
    if (fs.realpathSync(file) !== file) return null;
    return fs.readFileSync(file);
  } catch { return null; }
}
function artifactInfo(dir, key) {
  const file = artifactPath(dir, key);
  if (!file || !exists(file)) return null;
  return {file, bytes: fs.statSync(file).size, sha256: sha256File(file)};
}

function statusDocument(dir) {
  const parsed = readJson(path.join(dir, 'evidence', names.status));
  if (!parsed || typeof parsed !== 'object') return null;
  const label = typeof parsed.status === 'string' ? parsed.status.toLowerCase().replace(/-/g, '_') : '';
  return STATUSES.includes(label) ? parsed : null;
}
function reportText(dir) {
  const file = path.join(dir, 'evidence', names.report);
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function patchBytes(dir) {
  try { return fs.readFileSync(path.join(dir, names.patch)); } catch { return null; }
}

function packageReadme(dir, job) {
  const status = statusDocument(dir) || {};
  const verified = status.verified || {};
  const policy = status.policy || {};
  const source = verified.sourceCommitPinned || verified.sourceCommit || manifest.source.commit;
  const patchSha = verified.patchSha256 || job.patchSha256 || 'unknown';
  const wasm = verified.builtWasmSha256 || 'not produced';
  return [
    '# Rehearsal source-patch evidence package',
    '',
    `Status: **${job.status}**`,
    '',
    NOTES[job.status] || NOTES.inconclusive,
    '',
    status.status ? '' : 'No completed checker report was produced for this run. The submitted diff and run metadata are preserved; no success is implied.',
    '',
    'This is the source-patch review package, not the older `repair:review` bundle format.',
    '',
    '## Bound identities',
    '',
    `- Pinned source commit: ${source}`,
    `- Submitted patch SHA-256: ${patchSha}`,
    `- Built WASM SHA-256: ${wasm}`,
    `- Checker policy SHA-256: ${policy.policySha256 || 'not available in this incomplete run'}`,
    '',
    '## Reproduce with the supported CLI',
    '',
    '```sh',
    'npm run review:patch -- \\',
    '  --patch submitted.patch \\',
    '  --source <clean checkout at ' + source + '> \\',
    '  --out <new directory> \\',
    '  --sandbox-dir <directory containing near-sandbox>',
    '```',
    '',
    'The source checkout must be clean and at the pinned commit. The output directory must be new or empty. Compare the source commit, patch SHA-256, built WASM and checker policy identities; do not treat the submitted labels as provenance.',
    '',
    'The original report and status are under `evidence/`. A rejected or incomplete package is evidence, not an accepted recovery packet.',
    '',
  ].join('\n');
}

function collectFiles(current, base) {
  const out = [];
  for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function writeSums(stage) {
  const files = collectFiles(stage, stage).filter((file) => file !== 'SHA256SUMS');
  const lines = files.sort().map((file) => `${sha256File(path.join(stage, file))}  ${file}`);
  fs.writeFileSync(path.join(stage, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

function ensurePackage(dir, job) {
  if (!dirExists(dir) || !job || job.status === 'running') return null;
  for (const name of ['review-package.zip', 'review-package.tar.gz']) {
    const existing = path.join(dir, name);
    if (exists(existing)) {
      job.packageName = name;
      return existing;
    }
  }
  const status = artifactPath(dir, 'status');
  const report = artifactPath(dir, 'report');
  const patch = artifactPath(dir, 'patch');
  if (!patch) return null;
  const stage = path.join(dir, `.package-${crypto.randomUUID()}`);
  try {
    fs.mkdirSync(path.join(stage, 'evidence'), {recursive: true});
    fs.copyFileSync(patch, path.join(stage, names.patch));
    if (status && exists(status)) fs.copyFileSync(status, path.join(stage, 'evidence', names.status));
    if (report && exists(report)) fs.copyFileSync(report, path.join(stage, 'evidence', names.report));
    if (exists(metaPath(dir))) fs.copyFileSync(metaPath(dir), path.join(stage, 'run.json'));
    const sourceEvidence = path.join(dir, 'evidence');
    if (dirExists(sourceEvidence)) for (const file of collectFiles(sourceEvidence, sourceEvidence)) {
      if (file === names.status || file === names.report) continue;
      const target = path.join(stage, 'evidence', file);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.copyFileSync(path.join(sourceEvidence, file), target);
    }
    fs.writeFileSync(path.join(stage, 'README.md'), packageReadme(dir, job));
    writeSums(stage);
    const zip = path.join(dir, 'review-package.zip');
    const zipped = spawnSync('zip', ['-q', '-r', zip, '.'], {cwd: stage, encoding: 'utf8', timeout: 30_000});
    if (zipped.status === 0 && exists(zip)) {
      fs.rmSync(stage, {recursive: true, force: true});
      job.packageName = path.basename(zip);
      return zip;
    }
    fs.rmSync(zip, {force: true});
    const tar = path.join(dir, 'review-package.tar.gz');
    const tarred = spawnSync('tar', ['-czf', tar, '-C', stage, '.'], {encoding: 'utf8', timeout: 30_000});
    if (tarred.status === 0 && exists(tar)) {
      fs.rmSync(stage, {recursive: true, force: true});
      job.packageName = path.basename(tar);
      return tar;
    }
    return null;
  } catch (error) {
    return null;
  } finally {
    fs.rmSync(stage, {recursive: true, force: true});
  }
}

function downloads(dir, job) {
  const keys = [];
  for (const key of ['status', 'report', 'patch']) if (artifactInfo(dir, key)) keys.push(key);
  if (ensurePackage(dir, job)) keys.push('package');
  return keys;
}

function publicJob(job, full = false) {
  const out = {
    id: job.id,
    status: job.status,
    note: job.note,
    createdAt: job.createdAt || null,
    finishedAt: job.finishedAt || null,
    patchSha256: job.patchSha256 || null,
    packageName: job.packageName || null,
    downloads: job.downloads || [],
    report: full ? job.report || null : undefined,
    checks: full ? job.checks || null : undefined,
    summary: full ? job.summary || null : undefined,
    verified: full ? job.verified || null : undefined,
    supplied: full ? job.supplied || null : undefined,
    policy: full ? job.policy || null : undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined));
}

function terminalStatus(dir, code, signal) {
  const doc = statusDocument(dir);
  const label = doc?.status ? doc.status.toLowerCase().replace(/-/g, '_') : '';
  if (signal) return 'inconclusive';
  if (!STATUSES.includes(label)) return 'inconclusive';
  if (label === 'accepted' && (code !== 0 || !reportText(dir))) return 'inconclusive';
  return label;
}

function enrich(job, dir) {
  const doc = statusDocument(dir);
  const report = reportText(dir);
  job.report = report || null;
  job.checks = doc?.checks || null;
  job.summary = doc?.summary || null;
  job.verified = doc?.verified || null;
  job.supplied = doc?.supplied || null;
  job.policy = doc?.policy || null;
  job.downloads = downloads(dir, job);
  job.note = job.note || NOTES[job.status] || NOTES.inconclusive;
  return job;
}

function writeMeta(dir, job) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const meta = {
    schema: 'near-rehearsal/patch-browser-run/v1',
    id: job.id, status: job.status, note: job.note || NOTES[job.status] || NOTES.inconclusive,
    createdAt: job.createdAt || nowIso(), finishedAt: job.finishedAt || null,
    patchSha256: job.patchSha256 || null, packageName: job.packageName || null,
  };
  fs.writeFileSync(metaPath(dir), json(meta), {mode: 0o600});
  return meta;
}

function load(id) {
  if (!safeId(id)) return null;
  if (memory.has(id)) return memory.get(id);
  const dir = dirFor(id);
  if (!dirExists(dir)) return null;
  const meta = readJson(metaPath(dir));
  if (!meta || meta.id !== id) return null;
  const job = {
    id, status: meta.status, createdAt: meta.createdAt, finishedAt: meta.finishedAt,
    patchSha256: meta.patchSha256, packageName: meta.packageName,
  };
  const doc = statusDocument(dir);
  if (doc) {
    const actual = terminalStatus(dir, 0, null);
    if (job.status !== actual) {
      job.status = actual;
      job.finishedAt = job.finishedAt || nowIso();
      writeMeta(dir, job);
    }
  } else if (job.status === 'running') {
    job.status = 'inconclusive';
    job.finishedAt = job.finishedAt || nowIso();
    job.note = 'The server restarted before this patch check completed. This run is not accepted evidence and was not resumed.';
    writeMeta(dir, job);
  } else if (!reportText(dir)) {
    job.status = 'inconclusive';
    job.finishedAt = job.finishedAt || nowIso();
    job.note = 'The completed checker verdict is unavailable; this run is not accepted evidence.';
    writeMeta(dir, job);
  }
  enrich(job, dir);
  memory.set(id, job);
  return job;
}

function list() {
  if (!dirExists(output)) return [];
  const jobs = [];
  for (const entry of fs.readdirSync(output, {withFileTypes: true})) {
    if (!entry.isDirectory() || !safeId(entry.name)) continue;
    try {
      const job = load(entry.name);
      if (job) jobs.push(job);
    } catch {}
  }
  return jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 20).map((job) => publicJob(job, false));
}

function recover() {
  if (!dirExists(output)) return;
  for (const entry of fs.readdirSync(output, {withFileTypes: true})) {
    if (entry.isDirectory() && safeId(entry.name)) {
      try { load(entry.name); } catch {}
    }
  }
}

function finish(job, dir, code, signal) {
  job.status = terminalStatus(dir, code, signal);
  job.finishedAt = nowIso();
  enrich(job, dir);
  writeMeta(dir, job);
}

async function body(req) {
  let n = 0; const chunks = [];
  for await (const chunk of req) {
    n += chunk.length;
    if (n > max * 6 + 128) throw new Error('Patch request too large.');
    chunks.push(chunk);
  }
  const {patch} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof patch !== 'string' || !patch.trim() || Buffer.byteLength(patch) > max) throw new Error('Enter a source diff of up to 64 KiB.');
  return patch;
}

function localOnly(req) {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?$/.test(req.headers.host || '') &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
    (!req.headers.origin || req.headers.origin === 'http://' + req.headers.host);
}

async function handle({req, res, url, send}) {
  if (!localOnly(req)) return send(res, 403, {error: 'Use the local Rehearsal server.'});
  if (url.pathname === '/api/patch/runs' && req.method === 'GET') {
    return send(res, 200, {runs: list(), active});
  }
  if (url.pathname === '/api/patch/runs' && req.method === 'POST') {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 415, {error: 'Expected a JSON patch request.'});
    const patch = await body(req);
    if (stopping) return send(res, 503, {error: 'Server is stopping.'});
    if (active) return send(res, 409, {error: 'A patch check is already running. Wait for it to finish.'});
    if (!fs.existsSync(cli)) return send(res, 503, {error: 'The patch checker is not installed in this build. Your diff has not been run.'});
    if (!process.env.REPAIR_SOURCE_DIR || !process.env.REPAIR_SANDBOX_DIR) return send(res, 503, {error: 'Configure the pinned source and local Sandbox before running a patch.'});
    const id = crypto.randomUUID(), dir = dirFor(id), input = path.join(dir, names.patch);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    fs.writeFileSync(input, patch, {flag: 'wx', mode: 0o600});
    const job = {id, status: 'running', createdAt: nowIso(), finishedAt: null, patchSha256: sha256(Buffer.from(patch)), downloads: []};
    writeMeta(dir, job);
    memory.set(id, job); active = id;
    const args = [cli, '--patch', input, '--base', manifest.source.commit, '--source', path.resolve(process.env.REPAIR_SOURCE_DIR), '--out', path.join(dir, 'evidence')];
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['HOME','PATH','TMPDIR','LANG','CARGO_HOME','RUSTUP_HOME','REPAIR_SANDBOX_DIR','CARGO_NET_OFFLINE'].includes(k)));
    let child;
    try { child = spawn(process.execPath, args, {cwd: root, env, stdio: 'ignore', detached: true}); }
    catch { active = null; job.status = 'inconclusive'; writeMeta(dir, job); return send(res, 503, {error: 'The local checker could not start.'}); }
    currentChild = child;
    const timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 20 * 60 * 1000);
    timer.unref();
    child.on('error', () => {});
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      try { finish(job, dir, code, signal); } finally { active = null; currentChild = null; }
    });
    return send(res, 202, publicJob(job, true));
  }
  const m = url.pathname.match(/^\/api\/patch\/runs\/([a-f0-9-]{36})(?:\/(status|report|patch|package))?$/);
  if (req.method === 'GET' && m) {
    const job = load(m[1]);
    if (!job) return send(res, 404, {error: 'Unknown patch review.'});
    if (!m[2]) return send(res, 200, publicJob(job, true));
    const file = artifactPath(dirFor(job.id), m[2]);
    if (!file || !exists(file)) return send(res, 404, {error: 'Evidence is unavailable.'});
    const data = fs.readFileSync(file);
    const name = m[2] === 'package' ? (job.packageName || path.basename(file)) : names[m[2]];
    const type = m[2] === 'patch' ? 'text/x-diff; charset=utf-8' : m[2] === 'package' ? (name.endsWith('.zip') ? 'application/zip' : 'application/gzip') : 'application/octet-stream';
    res.writeHead(200, {'content-type': type, 'cache-control': 'no-store', 'content-length': data.length, 'content-disposition': `attachment; filename="${name}"`});
    return res.end(data);
  }
  return send(res, 404, {error: 'Unknown patch review.'});
}

async function shutdown() {
  stopping = true;
  const child = currentChild;
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', resolve);
    const timeout = setTimeout(resolve, 3000); timeout.unref();
  });
}

recover();
module.exports = {handle, shutdown, list, recover};
