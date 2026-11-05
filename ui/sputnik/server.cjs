'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const CASE = path.join(ROOT, 'case-triage/sputnik-public-capture');
const RUNNER = path.join(CASE, 'local-three-branch.cjs');
const VERIFIER = path.join(CASE, 'verify-local-three.cjs');
const FAMILY = JSON.parse(fs.readFileSync(path.join(CASE, 'supported-family.json'), 'utf8'));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4174);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 8 * 1024 * 1024;
const MAX_LOG = 180;
const MAX_RUN_MS = 12 * 60 * 1000;

const runs = new Map();
const RUNS_ROOT = path.join(ROOT, 'out/sputnik-ui/runs');
let activeId = null;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const send = (res, status, data) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body)});
  res.end(body);
};
const file = (res, name) => {
  const ext = path.extname(name);
  const type = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'}[ext] || 'application/octet-stream';
  fs.readFile(path.join(PUBLIC, name), (e, data) => {
    if (e) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {'content-type': type, 'cache-control': 'no-store'}); res.end(data);
  });
};
const readBody = (req) => new Promise((resolve, reject) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { raw += c; if (Buffer.byteLength(raw) > MAX_BODY) { reject(new Error('request too large')); req.destroy(); } });
  req.on('end', () => resolve(raw));
  req.on('error', reject);
});

function validateWasm(input, role) {
  if (!input || typeof input !== 'object') throw new Error(`${role} input is required`);
  if (!/^[a-f0-9]{64}$/.test(input.sha256 || '')) throw new Error(`${role} sha256 must be 64 lowercase hex characters`);
  if (typeof input.base64 !== 'string' || !input.base64) throw new Error(`${role} bytes are required`);
  const bytes = Buffer.from(input.base64, 'base64');
  if (!bytes.length || bytes.length > FAMILY.inputContract.maxWasmBytes) throw new Error(`${role} WASM is outside the supported size`);
  if (sha256(bytes) !== input.sha256) throw new Error(`${role} sha256 does not match its bytes`);
  let module;
  try { module = new WebAssembly.Module(bytes); } catch { throw new Error(`${role} is not valid WebAssembly`); }
  const exports = new Set(WebAssembly.Module.exports(module).map((x) => x.name));
  for (const name of ['update', 'migrate', 'act_proposal']) if (!exports.has(name)) throw new Error(`${role} is missing supported export ${name}`);
  return {bytes, sha256: input.sha256, filename: String(input.filename || `${role}.wasm`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || `${role}.wasm`, label: String(input.label || input.filename || `${role} supplied WASM`).slice(0, 120), provenance: String(input.provenance || 'uploaded candidate/correction WASM').slice(0, 200), exports: [...exports].sort()};
}

function artifact(role, choice) {
  const a = FAMILY.artifacts[choice];
  if (!a || !a.roles.includes(role)) throw new Error(`unsupported ${role} choice`);
  const filePath = path.resolve(CASE, a.path);
  const bytes = fs.readFileSync(filePath);
  if (sha256(bytes) !== a.sha256) throw new Error(`manifest hash mismatch for ${choice}`);
  return {bytes, sha256: a.sha256, filename: path.basename(filePath), label: a.label || choice, provenance: a.provenance || `manifest artifact ${choice}`, exports: null};
}

function publicRun(run) {
  return {
    id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
    logs: run.logs, report: run.report, verdict: run.verdict, error: run.error,
    exitCode: run.exitCode, input: run.input,
    frozenBundle: run.frozenBundle ? {stateHash: run.frozenBundle.stateHash, codeHash: run.frozenBundle.codeHash, contractBalance: run.frozenBundle.contractAccount.amount, actorBalance: run.frozenBundle.actorAccount.amount, recipientBalance: run.frozenBundle.recipientAmount, proposal: run.frozenBundle.proposal, identities: run.frozenBundle.identities} : null,
  };
}

function writeRunMeta(run) {
  const meta = {
    id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
    error: run.error, exitCode: run.exitCode, input: run.input, frozenBundlePath: run.input.frozenBundle,
  };
  try { fs.writeFileSync(path.join(run.runDir, 'run.json'), JSON.stringify(meta, null, 2) + '\n'); } catch {}
}

function recoverRuns() {
  if (!fs.existsSync(RUNS_ROOT)) return;
  for (const id of fs.readdirSync(RUNS_ROOT)) {
    const runDir = path.join(RUNS_ROOT, id);
    if (!fs.statSync(runDir).isDirectory()) continue;
    const outDir = path.join(runDir, 'out');
    const reportPath = path.join(outDir, 'local-three-branch.json');
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')); } catch {}
    if (!meta) continue;
    const run = {
      id, status: 'inconclusive', startedAt: meta.startedAt, finishedAt: new Date().toISOString(),
      logs: [], report: null, verdict: null, error: null, exitCode: null,
      runDir, outDir, reportPath, frozenBundle: null, input: meta.input,
    };
    if (fs.existsSync(reportPath)) {
      try {
        run.report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        run.status = run.report.status === 'complete' ? 'complete' : 'inconclusive';
        if (run.status !== 'complete') run.error = 'Persisted report is inconclusive.';
      } catch (e) { run.error = `Persisted report is invalid: ${e.message}`; }
    } else {
      run.status = 'inconclusive';
      run.error = 'Server restarted before this run completed; the interrupted job is not evidence.';
    }
    const bundlePath = path.join(outDir, 'local-frozen-bundle.json');
    if (fs.existsSync(bundlePath)) { try { run.frozenBundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8')); } catch {} }
    const verdictPath = path.join(outDir, 'local-three-verdict.json');
    if (fs.existsSync(verdictPath)) { try { run.verdict = JSON.parse(fs.readFileSync(verdictPath, 'utf8')); } catch {} }
    runs.set(id, run);
  }
}

function startRun(input, frozenBundle = null) {
  const id = crypto.randomUUID();
  const runDir = path.join(ROOT, 'out/sputnik-ui/runs', id);
  const outDir = path.join(runDir, 'out');
  fs.mkdirSync(outDir, {recursive: true});
  const candidatePath = path.join(runDir, 'candidate.wasm');
  const correctionPath = path.join(runDir, 'correction.wasm');
  fs.writeFileSync(candidatePath, input.candidate.bytes);
  fs.writeFileSync(correctionPath, input.correction.bytes);
  const reportPath = path.join(outDir, 'local-three-branch.json');
  const frozenPath = frozenBundle ? path.join(runDir, 'frozen-bundle.json') : null;
  if (frozenPath) fs.writeFileSync(frozenPath, JSON.stringify(frozenBundle, null, 2) + '\n');
  const run = {
    id, status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
    logs: [], report: null, verdict: null, error: null, exitCode: null,
    runDir, outDir, reportPath, frozenBundle: null,
    input: {
      family: FAMILY.family,
      candidate: {filename: input.candidate.filename, sha256: input.candidate.sha256, role: input.candidateRole, label: input.candidate.label, provenance: input.candidate.provenance},
      correction: {filename: input.correction.filename, sha256: input.correction.sha256, role: input.correctionRole, label: input.correction.label, provenance: input.correction.provenance},
      migration: FAMILY.inputContract.migration,
      operation: FAMILY.inputContract.operation,
      frozenBundle: frozenPath ? rel(frozenPath) : null,
    },
  };
  runs.set(id, run);
  activeId = id;
  writeRunMeta(run);
  const env = {
    ...process.env,
    CANDIDATE_WASM: candidatePath,
    CORRECTED_WASM: correctionPath,
    CANDIDATE_WASM_SHA256: input.candidate.sha256,
    CORRECTED_WASM_SHA256: input.correction.sha256,
    CANDIDATE_LABEL: input.candidate.label || input.candidate.filename,
    CANDIDATE_PROVENANCE: input.candidate.provenance || 'supplied candidate',
    CORRECTED_LABEL: input.correction.label || input.correction.filename,
    CORRECTED_PROVENANCE: input.correction.provenance || 'supplied correction',
    SPUTNIK_OUT_DIR: outDir,
    ...(frozenPath ? {USE_FROZEN: '1', FROZEN_BUNDLE: frozenPath} : {}),
  };
  const child = spawn(process.execPath, [RUNNER], {cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']});
  const add = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) if (line) run.logs.push(line.slice(0, 1200));
    if (run.logs.length > MAX_LOG) run.logs.splice(0, run.logs.length - MAX_LOG);
  };
  let ended = false;
  const finish = (code, signal) => {
    if (ended) return;
    ended = true;
    if (activeId === id) activeId = null;
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();
    if (fs.existsSync(reportPath)) {
      try { run.report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch (e) { run.error = `Invalid report: ${e.message}`; }
    }
    if (run.report) {
      run.frozenBundle = fs.existsSync(path.join(outDir, 'local-frozen-bundle.json'))
        ? JSON.parse(fs.readFileSync(path.join(outDir, 'local-frozen-bundle.json'), 'utf8')) : null;
      run.status = run.report.status === 'complete' ? 'complete' : 'inconclusive';
      if (run.status !== 'complete') run.error = run.report.error?.message || 'Runner reported an inconclusive result.';
    } else {
      run.status = 'error';
      if (!run.error) run.error = `Runner exited ${code ?? signal ?? 'without a report'}.`;
    }
    if (signal) run.error = run.error || `Runner stopped by ${signal}.`;
    writeRunMeta(run);
  };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  child.on('error', (e) => { run.error = e.message; finish(null, null); });
  child.on('close', finish);
  const timer = setTimeout(() => { run.error = 'Runner exceeded the local 12-minute limit.'; run.status = 'error'; activeId = null; child.kill('SIGKILL'); }, MAX_RUN_MS);
  child.on('close', () => clearTimeout(timer));
  return run;
}

function verify(run) {
  if (run.status !== 'complete') throw new Error('Only a complete report can be verified/exported.');
  const child = spawnSync(process.execPath, [VERIFIER], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: {...process.env, CASE_DIR: run.runDir},
  });
  if (child.status !== 0) throw new Error((child.stderr || child.stdout || 'Verifier rejected the report.').trim().slice(-2000));
  run.verdict = JSON.parse(fs.readFileSync(path.join(run.outDir, 'local-three-verdict.json'), 'utf8'));
  return run.verdict;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  try {
    if (url.pathname === '/api/health') return send(res, 200, {ok: true, running: !!activeId});
    if (url.pathname === '/api/supported') return send(res, 200, {
      family: FAMILY.family, label: FAMILY.label, expected: FAMILY.expected, limitations: FAMILY.limitations,
      artifacts: Object.fromEntries(Object.entries(FAMILY.artifacts).map(([k, v]) => [k, {sha256: v.sha256, label: v.label || k, provenance: v.provenance || `manifest artifact ${k}`, roles: v.roles}])),
      inputContract: FAMILY.inputContract,
    });
    if (url.pathname === '/api/run' && req.method === 'POST') {
      if (activeId) return send(res, 409, {error: 'A run is already active.'});
      const payload = JSON.parse(await readBody(req) || '{}');
      if (payload.family !== FAMILY.family) throw new Error('unsupported contract family');
      const candidate = payload.candidate?.sha256 ? validateWasm(payload.candidate, 'candidate') : artifact('candidate', payload.candidate?.choice || 'candidate');
      const correction = payload.correction?.sha256 ? validateWasm(payload.correction, 'correction') : artifact('correction', payload.correction?.choice || 'corrected');
      const run = startRun({candidate, correction, candidateRole: payload.candidate?.choice || 'candidate', correctionRole: payload.correction?.choice || 'corrected'});
      return send(res, 202, {run: publicRun(run)});
    }
    if (url.pathname === '/api/correction' && req.method === 'POST') {
      if (activeId) return send(res, 409, {error: 'A run is already active.'});
      const payload = JSON.parse(await readBody(req) || '{}');
      const previous = runs.get(payload.runId);
      if (!previous?.frozenBundle) throw new Error('That run has no frozen bundle to reuse.');
      if (!payload.correction) throw new Error('Correct this run with an explicit correction selection.');
      const candidate = {bytes: fs.readFileSync(path.join(previous.runDir, 'candidate.wasm')), ...previous.input.candidate};
      const correction = payload.correction.sha256 ? validateWasm(payload.correction, 'correction') : artifact('correction', payload.correction.choice || 'corrected');
      const run = startRun({candidate, correction, candidateRole: candidate.role, correctionRole: payload.correction.choice || 'correction'}, previous.frozenBundle);
      return send(res, 202, {run: publicRun(run)});
    }
    const match = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)$/);
    if (match && req.method === 'GET') {
      const run = runs.get(match[1]);
      if (!run) return send(res, 404, {error: 'Run not found.'});
      return send(res, 200, publicRun(run));
    }
    const action = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/(verify|export)$/);
    if (action && req.method === 'POST') {
      const run = runs.get(action[1]);
      if (!run) return send(res, 404, {error: 'Run not found.'});
      const verdict = verify(run);
      if (action[2] === 'verify') return send(res, 200, {verdict});
      const inputManifest = JSON.parse(fs.readFileSync(path.join(run.outDir, 'input-manifest.json'), 'utf8'));
      const exportDoc = {
        schema: 'near-rehearsal/sputnik-export/v2', createdAt: new Date().toISOString(),
        family: FAMILY.family, runId: run.id, inputs: run.input,
        candidate: {filename: run.input.candidate.filename, sha256: run.input.candidate.sha256, label: run.input.candidate.label, provenance: run.input.candidate.provenance, bytesBase64: fs.readFileSync(path.join(run.runDir, 'candidate.wasm')).toString('base64')},
        correction: {filename: run.input.correction.filename, sha256: run.input.correction.sha256, label: run.input.correction.label, provenance: run.input.correction.provenance, bytesBase64: fs.readFileSync(path.join(run.runDir, 'correction.wasm')).toString('base64')},
        inputManifest, frozenBundle: run.frozenBundle,
        report: run.report,
        reportSha256: sha256(fs.readFileSync(run.reportPath)),
        verdictSha256: sha256(fs.readFileSync(path.join(run.outDir, 'local-three-verdict.json'))),
        verdict,
        verifyCommand: `cd ${ROOT} && CASE_DIR=${run.runDir} ${process.execPath} ${VERIFIER}`,
        replayCommand: `cd ${ROOT} && d=$(mktemp -d) && SPUTNIK_OUT_DIR="$d" USE_FROZEN=1 FROZEN_BUNDLE=${path.join(run.outDir, 'local-frozen-bundle.json')} CANDIDATE_WASM=${path.join(run.runDir, 'candidate.wasm')} CORRECTED_WASM=${path.join(run.runDir, 'correction.wasm')} ${process.execPath} ${RUNNER}`,
        downloadUrl: `/api/runs/${run.id}/export/download`,
        limitations: FAMILY.limitations,
      };
      const exportPath = path.join(run.runDir, 'export.json');
      fs.writeFileSync(exportPath, JSON.stringify(exportDoc, null, 2) + '\n');
      return send(res, 200, {export: exportDoc, exportPath: rel(exportPath)});
    }
    const download = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/export\/download$/);
    if (download && req.method === 'GET') {
      const run = runs.get(download[1]);
      if (!run) return send(res, 404, {error: 'Run not found.'});
      verify(run);
      const exportPath = path.join(run.runDir, 'export.json');
      if (!fs.existsSync(exportPath)) return send(res, 404, {error: 'Export not created.'});
      const data = fs.readFileSync(exportPath);
      res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="sputnik-export-${run.id}.json"`, 'content-length': data.length, 'cache-control': 'no-store'});
      res.end(data);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return file(res, 'index.html');
    if (['/app.js', '/styles.css'].includes(url.pathname)) return file(res, url.pathname.slice(1));
    return send(res, 404, {error: 'Not found.'});
  } catch (e) {
    return send(res, 400, {error: e.message});
  }
});
recoverRuns();
server.listen(PORT, HOST, () => console.log(`Sputnik rehearsal UI: http://${HOST}:${PORT}`));
