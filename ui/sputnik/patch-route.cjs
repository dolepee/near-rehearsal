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
const {buildReviewBundle} = require('../../case-triage/rehearsal-repair/review-bundle.cjs');
const {checkBundle} = require('../../scripts/repair-review.cjs');
const SOURCE_PATH = 'sputnikdao2/src/proposals.rs';

function checkerRevision() {
  const run = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8', timeout: 10_000});
  return run.status === 0 ? run.stdout.trim() : null;
}
const names = {status:'review-status.json',report:'review-report.md',patch:'submitted.patch',bundle:'review-bundle.json'};
const max = 65536;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024;
const PACKAGE_FORMAT = 3;
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
  if (key === 'bundle') return path.join(dir, names.bundle);
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

function writeReviewBundle(dir, job) {
  const bundlePath = path.join(dir, names.bundle);
  if (job.status !== 'accepted') { fs.rmSync(bundlePath, {force: true}); return null; }
  const out = path.join(dir, 'evidence');
  const pipeline = path.join(out, 'pipeline');
  const pipelineJson = readJson(path.join(pipeline, 'pipeline.json'), {});
  const candidateReport = path.join(pipeline, 'replay', 'issue238-local.json');
  const baseReport = pipelineJson?.baseReport || path.join(root, 'case-triage/rehearsal-repair/out/issue238-local.json');
  const recovery = path.join(out, 'evidence', 'persisted-recovery.json');
  const acceptance = path.join(out, 'evidence', 'persisted-recovery-acceptance.json');
  const mixed = path.join(out, 'evidence', 'mixed-obligation.json');
  const settlement = path.join(out, 'evidence', 'settlement-refund.json');
  const identity = path.join(pipeline, 'candidate-identity.json');
  const wasm = path.join(pipeline, 'applied', 'target', 'wasm32-unknown-unknown', 'release', 'sputnikdao2.wasm');
  const patch = path.join(dir, names.patch);
  for (const file of [baseReport, candidateReport, recovery, acceptance, mixed, settlement, identity, wasm, patch]) {
    if (!exists(file)) { fs.rmSync(bundlePath, {force: true}); return null; }
  }
  try {
    const bundle = buildReviewBundle({
      runId: job.id,
      createdAt: job.createdAt,
      patchPath: patch,
      wasmPath: wasm,
      candidateIdentityPath: identity,
      baseReportPath: baseReport,
      candidateReportPath: candidateReport,
      recoveryPath: recovery,
      acceptancePath: acceptance,
      mixedPath: mixed,
      settlementPath: settlement,
      producer: {runId: job.id, status: job.status, createdAt: job.createdAt},
      policy: statusDocument(dir)?.policy || null,
    });
    checkBundle(bundle);
    fs.writeFileSync(bundlePath, json(bundle), {mode: 0o600});
    return bundlePath;
  } catch {
    fs.rmSync(bundlePath, {force: true});
    return null;
  }
}

function packageReadme(dir, job) {
  const status = statusDocument(dir) || {};
  const verified = status.verified || {};
  const policy = status.policy || {};
  const source = verified.sourceCommitPinned || verified.sourceCommit || manifest.source.commit;
  const patchSha = verified.patchSha256 || job.patchSha256 || 'unknown';
  const wasm = verified.builtWasmSha256 || 'not produced';
  const checker = job.checkerRevision || 'the revision that produced this packet';
  return [
    '# Rehearsal source-patch evidence package',
    '',
    `Status: **${job.status}**`,
    '',
    NOTES[job.status] || NOTES.inconclusive,
    '',
    status.status ? '' : 'No completed checker report was produced for this run. The submitted diff and run metadata are preserved; no success is implied.',
    '',
    `Package format: ${PACKAGE_FORMAT} (source-patch review)`,
    '',
    'This is the source-patch review package, not the older `repair:review` bundle format.',
    '',
    '## Bound identities',
    '',
    `- Pinned source commit: ${source}`,
    `- Submitted patch SHA-256: ${patchSha}`,
    `- Built WASM SHA-256: ${wasm}`,
    `- Checker policy SHA-256: ${policy.policySha256 || 'not available in this incomplete run'}`,
    `- Checker revision: ${checker}`,
    '',
    '## Artifact and notices',
    '',
    `- Built artifact: ${wasm === 'not produced' ? 'not produced for this run' : 'artifact/sputnikdao2.wasm'}`,
    '- Submitted source diff: submitted.patch',
    '- Reviewer-compatible bundle (when accepted): review-bundle.json; open it in /review for recorded-WASM or source-build verification.',
    '- Same-DAO mixed-obligation evidence: evidence/mixed-obligation.json; the primary gate rejects a candidate that erases Bob’s locked liability.',
    '- Root project license: LICENSE',
    '- Third-party and upstream notices: THIRD_PARTY_NOTICES.md and LICENSES/',
    '- No Cargo build tree is included. Only the selected evidence, built artifact and notices are packaged.',
    '',
    '## Get the checker before running',
    '',
    'This packet does **not** include the Rehearsal application checkout or its `package.json`; do not run `npm` from the extracted packet. Extract the packet, then obtain the Rehearsal checkout at the checker revision above and install its dependencies there:',
    '',
    '```sh',
    'cd <rehearsal-checkout-at-' + checker + '>',
    'npm ci',
    '```',
    '',
    '## Reproduce with the supported CLI',
    '',
    'Run this from the Rehearsal checkout, not from the extracted packet:',
    '',
    '```sh',
    'npm run review:patch -- \\',
    '  --patch <extracted-packet>/submitted.patch \\',
    '  --source <clean Sputnik checkout at ' + source + '> \\',
    '  --out <new output directory> \\',
    '  --sandbox-dir <directory containing near-sandbox>',
    '```',
    '',
    'The source checkout must be clean and at the pinned commit. The output directory must be new or empty. Compare the source commit, patch SHA-256, built WASM and checker policy identities; do not treat the submitted labels as provenance. No original absolute path is required: use paths in your own extracted packet and checkouts.',
    '',
    'The original report and status are under `evidence/`. A rejected or incomplete package is evidence, not an accepted recovery packet.',
    '',
    'Source-build mode runs the compiler inside the controller enforced boundary when its probe passes; the probe checks host canaries, network denial and disposable-job writes before the build. If no supported launcher is available, source-build is blocked rather than falling back to host execution.',
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

function archiveEntry(file, name) {
  const zip = file.endsWith('.zip');
  const run = spawnSync(zip ? 'unzip' : 'tar', zip ? ['-p', file, name] : ['-xzOf', file, name], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: MAX_PACKAGE_BYTES,
  });
  if (run.error) return null;
  return run.status === 0 ? run.stdout : null;
}

function packageCurrent(file, job) {
  const readme = archiveEntry(file, 'README.md');
  if (!readme || !readme.includes(`Package format: ${PACKAGE_FORMAT}`)) return false;
  const raw = archiveEntry(file, 'run.json');
  if (!raw) return false;
  try {
    const meta = JSON.parse(raw);
    if (!meta || meta.status !== job.status) return false;
    if (job.status !== 'accepted') return true;
    const bundleRaw = archiveEntry(file, names.bundle);
    if (!bundleRaw) return false;
    checkBundle(JSON.parse(bundleRaw));
    return true;
  } catch { return false; }
}

function ensurePackage(dir, job) {
  if (!dirExists(dir) || !job || job.status === 'running') return null;
  const bundle = writeReviewBundle(dir, job);
  if (job.status === 'accepted' && !bundle) {
    for (const name of ['review-package.zip', 'review-package.tar.gz']) fs.rmSync(path.join(dir, name), {force: true});
    job.packageName = null;
    return null;
  }
  let existing = null;
  for (const name of ['review-package.zip', 'review-package.tar.gz']) {
    const file = path.join(dir, name);
    if (exists(file)) { existing = file; break; }
  }
  if (existing && packageCurrent(existing, job)) {
    job.packageName = path.basename(existing);
    return existing;
  }
  // Old packages copied the complete Cargo tree and can carry a stale running
  // run.json. Remove them so the next read regenerates from this allowlist.
  for (const name of ['review-package.zip', 'review-package.tar.gz']) fs.rmSync(path.join(dir, name), {force: true});
  job.packageName = null;
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
    const output = path.join(dir, 'evidence');
    const add = (from, relative, limit = MAX_EVIDENCE_FILE_BYTES) => {
      if (!exists(from)) return false;
      if (fs.statSync(from).size > limit) return false;
      const target = path.join(stage, relative);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.copyFileSync(from, target);
      return true;
    };
    add(status, 'review-status.json', MAX_PACKAGE_BYTES);
    add(report, 'review-report.md', MAX_PACKAGE_BYTES);
    for (const name of ['recovery-packet.json', 'rejected-evidence.json', 'review-evidence.json', 'mixed-obligation.json', 'mixed.log']) add(path.join(output, name), name);
    for (const name of ['evidence', 'persisted']) {
      const from = path.join(output, name);
      if (dirExists(from)) for (const file of collectFiles(from, from)) {
        add(path.join(from, file), path.join('evidence', name, file));
      }
    }
    const pipeline = path.join(output, 'pipeline');
    for (const name of ['pipeline.json', 'candidate-identity.json', 'build.log', 'replay.log']) {
      add(path.join(pipeline, name), path.join('evidence', 'pipeline', name));
    }
    add(path.join(pipeline, 'applied', 'target', 'wasm32-unknown-unknown', 'release', 'sputnikdao2.wasm'), 'artifact/sputnikdao2.wasm', MAX_PACKAGE_BYTES);
    add(path.join(pipeline, 'applied', SOURCE_PATH), 'source/proposals.rs');
    if (bundle) add(bundle, 'review-bundle.json', MAX_PACKAGE_BYTES);
    add(path.join(root, 'LICENSE'), 'LICENSE');
    add(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'THIRD_PARTY_NOTICES.md');
    const licenses = path.join(root, 'LICENSES');
    if (dirExists(licenses)) for (const file of collectFiles(licenses, licenses)) {
      add(path.join(licenses, file), path.join('licenses', file));
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
  if (ensurePackage(dir, job)) keys.push('package');
  for (const key of ['status', 'report', 'patch', 'bundle']) if (artifactInfo(dir, key)) keys.push(key);
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
    checkerRevision: job.checkerRevision || null,
    exitCode: job.exitCode === undefined ? null : job.exitCode,
    signal: job.signal || null,
    termination: job.termination || null,
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
    checkerRevision: meta.checkerRevision || null,
    exitCode: meta.exitCode === undefined ? null : meta.exitCode,
    signal: meta.signal || null,
    termination: meta.termination || null,
  };
  if (job.status === 'running') {
    // A leftover status/report from an interrupted process is not evidence of
    // a successful exit. Never infer exit code zero from the files alone.
    job.status = 'inconclusive';
    job.finishedAt = job.finishedAt || nowIso();
    job.termination = job.termination || 'server-restart';
    job.note = 'The server restarted before this patch check completed. This run is not accepted evidence and was not resumed.';
    writeMeta(dir, job);
  } else if (!reportText(dir)) {
    job.status = 'inconclusive';
    job.finishedAt = job.finishedAt || nowIso();
    job.termination = job.termination || 'missing-verdict';
    job.note = 'The completed checker verdict is unavailable; this run is not accepted evidence.';
    writeMeta(dir, job);
  } else if (job.status === 'accepted' && !statusDocument(dir)) {
    job.status = 'inconclusive';
    job.finishedAt = job.finishedAt || nowIso();
    job.termination = job.termination || 'missing-status';
    job.note = 'The accepted run is missing its structured checker status; this run is not accepted evidence.';
    writeMeta(dir, job);
  } else if (job.status === 'accepted' && ((job.exitCode !== null && job.exitCode !== 0) || job.signal)) {
    job.status = 'inconclusive';
    job.finishedAt = job.finishedAt || nowIso();
    job.note = 'The recorded process termination does not support an accepted verdict; this run is not accepted evidence.';
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
  job.exitCode = Number.isInteger(code) ? code : null;
  job.signal = signal || null;
  job.termination = 'process-closed';
  job.downloads = ['status', 'report', 'patch'].filter((key) => artifactInfo(dir, key));
  // Persist the final verdict and process evidence before materialising the
  // package, so the packet cannot carry stale running metadata.
  writeMeta(dir, job);
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
    const job = {id, status: 'running', createdAt: nowIso(), finishedAt: null, patchSha256: sha256(Buffer.from(patch)), downloads: [], checkerRevision: checkerRevision(), exitCode: null, signal: null, termination: null};
    writeMeta(dir, job);
    memory.set(id, job); active = id;
    const args = [cli, '--patch', input, '--base', manifest.source.commit, '--source', path.resolve(process.env.REPAIR_SOURCE_DIR), '--out', path.join(dir, 'evidence')];
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['HOME','PATH','TMPDIR','LANG','CARGO_HOME','RUSTUP_HOME','REPAIR_SANDBOX_DIR','CARGO_NET_OFFLINE'].includes(k)));
    let child;
    try { child = spawn(process.execPath, args, {cwd: root, env, stdio: 'ignore', detached: true}); }
    catch { active = null; job.status = 'inconclusive'; job.termination = 'not-started'; writeMeta(dir, job); return send(res, 503, {error: 'The local checker could not start.'}); }
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
  const m = url.pathname.match(/^\/api\/patch\/runs\/([a-f0-9-]{36})(?:\/(status|report|patch|package|bundle))?$/);
  if (req.method === 'GET' && m) {
    const job = load(m[1]);
    if (!job) return send(res, 404, {error: 'Unknown patch review.'});
    if (!m[2]) return send(res, 200, publicJob(job, true));
    const file = artifactPath(dirFor(job.id), m[2]);
    if (!file || !exists(file)) return send(res, 404, {error: 'Evidence is unavailable.'});
    const data = fs.readFileSync(file);
    const name = m[2] === 'package' ? (job.packageName || path.basename(file)) : names[m[2]];
    const type = m[2] === 'patch' ? 'text/x-diff; charset=utf-8' : m[2] === 'package' ? (name.endsWith('.zip') ? 'application/zip' : 'application/gzip') : m[2] === 'bundle' ? 'application/json; charset=utf-8' : 'application/octet-stream';
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
