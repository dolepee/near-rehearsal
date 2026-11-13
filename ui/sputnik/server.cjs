'use strict';
const http = require('node:http');
const {apiRequestError} = require('../local-api-guard.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const {createManager: createRepairManager} = require('./repair-job.cjs');
const {createManager: createReviewManager, exampleBundleText} = require('./review-job.cjs');
const patchRoute = require('./patch-route.cjs');

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
const repairManager = createRepairManager();
const reviewManager = createReviewManager();

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
        // Only a run that reached its own clean terminal state can be recovered as complete.
        if (meta.status === 'complete' && run.report.status === 'complete') {
          run.status = 'complete';
        } else {
          run.status = 'inconclusive';
          run.error = meta.status === 'running'
            ? 'Server restarted before this run completed; the interrupted job is not evidence.'
            : (meta.error || 'Persisted report is not a clean completed run.');
        }
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

function finalizeRun(run, {code = null, signal = null, timedOut = false} = {}) {
  if (activeId === run.id) activeId = null;
  run.exitCode = code;
  run.finishedAt = new Date().toISOString();
  if (fs.existsSync(run.reportPath)) {
    try {
      run.report = JSON.parse(fs.readFileSync(run.reportPath, 'utf8'));
    } catch (e) {
      run.report = null;
      run.error = `Invalid report: ${e.message}`;
    }
  }
  if (run.report) {
    try {
      const bundlePath = path.join(run.outDir, 'local-frozen-bundle.json');
      run.frozenBundle = fs.existsSync(bundlePath) ? JSON.parse(fs.readFileSync(bundlePath, 'utf8')) : null;
    } catch (e) {
      run.frozenBundle = null;
      run.error = `Invalid frozen bundle: ${e.message}`;
      run.report = null;
    }
  }
  if (run.report) {
    const roles = [['candidate', 'candidate'], ['correction', 'corrected']];
    for (const [inputRole, artifactRole] of roles) {
      const expected = run.input?.[inputRole]?.sha256;
      const actual = run.report?.artifacts?.[artifactRole]?.sha256;
      if (!expected || !actual || expected !== actual) {
        run.report = null;
        run.error = !expected
          ? `Submitted ${inputRole} has no SHA-256.`
          : !actual
            ? `Report ${artifactRole} artifact has no SHA-256; expected ${expected}.`
            : `Report ${artifactRole} bytes ${actual} do not match submitted ${inputRole} ${expected}.`;
        break;
      }
    }
  }
  const cleanExit = code === 0 && !signal && !timedOut;
  if (run.report && cleanExit && run.report.status === 'complete') {
    run.status = 'complete';
  } else {
    run.status = 'inconclusive';
    if (timedOut) run.error = 'Runner exceeded the local 12-minute limit; this run is not evidence.';
    else if (signal) run.error = `Runner stopped by ${signal}; this run is not evidence.`;
    else if (!run.report && !run.error) run.error = `Runner exited ${code ?? 'without a report'}; this run is not evidence.`;
    else if (run.report && run.report.status !== 'complete') run.error = run.report.error?.message || 'Runner reported an inconclusive result.';
    else if (run.report) run.error = `Runner exited ${code}; a complete report from an unclean exit is not accepted.`;
  }
  writeRunMeta(run);
  return run;
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
    FROZEN_BUNDLE_OUT: path.join(outDir, 'local-frozen-bundle.json'),
    ...(frozenPath ? {USE_FROZEN: '1', FROZEN_BUNDLE: frozenPath} : {}),
  };
  const child = spawn(process.execPath, [RUNNER], {cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']});
  const add = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) if (line) run.logs.push(line.slice(0, 1200));
    if (run.logs.length > MAX_LOG) run.logs.splice(0, run.logs.length - MAX_LOG);
  };
  let ended = false;
  let timedOut = false;
  const finish = (code, signal) => {
    if (ended) return;
    ended = true;
    finalizeRun(run, {code, signal, timedOut});
  };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  child.on('error', (e) => { run.error = e.message; finish(null, null); });
  child.on('close', finish);
  const timer = setTimeout(() => {
    timedOut = true;
    run.error = 'Runner exceeded the local 12-minute limit; this run is not evidence.';
    run.status = 'inconclusive';
    activeId = null;
    child.kill('SIGKILL');
  }, MAX_RUN_MS);
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
    if (url.pathname.startsWith('/api/')) {
      const denied = apiRequestError(req);
      if (denied) return send(res, denied.status, {error: denied.error});
    }
    if (url.pathname === '/api/patch' || url.pathname.startsWith('/api/patch/')) {
      return await patchRoute.handle({req, res, url, send});
    }
    if (url.pathname === '/api/health') return send(res, 200, {ok: true, running: !!activeId, repairRunning: Boolean(repairManager.active()), reviewRunning: Boolean(reviewManager.active())});
    if (url.pathname === '/api/review/config' && req.method === 'GET') return send(res, 200, {
      case: reviewManager.case,
      ...reviewManager.config(),
      example: {filename: 'repair-browser-export-1de7b8c5.json', label: 'Recorded model candidate, fresh Sandbox execution'},
    });
    if (url.pathname === '/api/review/example' && req.method === 'GET') {
      try {
        const example = exampleBundleText();
        return send(res, 200, {bundle: example.bundle, sha256: example.sha256, filename: example.filename, label: 'Recorded model candidate, fresh Sandbox execution'});
      } catch (error) {
        return send(res, 500, {error: error.message});
      }
    }
    if (url.pathname === '/api/review/runs' && req.method === 'GET') return send(res, 200, {runs: reviewManager.list(), active: reviewManager.active()});
    if (url.pathname === '/api/review/runs' && req.method === 'POST') {
      const payload = JSON.parse(await readBody(req) || '{}');
      const run = reviewManager.start(payload.bundle, payload.mode);
      return send(res, 202, {run});
    }
    const reviewRun = url.pathname.match(/^\/api\/review\/runs\/([0-9a-f-]+)$/);
    if (reviewRun && req.method === 'GET') {
      const run = reviewManager.get(reviewRun[1]);
      if (!run) return send(res, 404, {error: 'Review run not found.'});
      return send(res, 200, reviewManager.publicRun(run));
    }
    const reviewDownload = url.pathname.match(/^\/api\/review\/runs\/([0-9a-f-]+)\/download$/);
    if (reviewDownload && req.method === 'GET') {
      const filePath = reviewManager.download(reviewDownload[1]);
      if (!filePath) return send(res, 404, {error: 'No accepted review result is available for this run.'});
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="review-result-${reviewDownload[1]}.json"`, 'content-length': data.length, 'cache-control': 'no-store'});
      res.end(data); return;
    }
    const reviewArtifact = url.pathname.match(/^\/api\/review\/runs\/([0-9a-f-]+)\/(input|evidence)$/);
    if (reviewArtifact && req.method === 'GET') {
      const [kind, id] = [reviewArtifact[2], reviewArtifact[1]];
      const filePath = kind === 'input' ? reviewManager.input(id) : reviewManager.evidence(id);
      if (!filePath) return send(res, 404, {error: kind === 'input' ? 'No input bundle is available for this run.' : 'No accepted evidence is available for this run.'});
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="review-${kind}-${id}.json"`, 'content-length': data.length, 'cache-control': 'no-store'});
      res.end(data); return;
    }
    if (url.pathname === '/api/repair/case') return send(res, 200, {
      case: repairManager.case,
      configured: repairManager.config.configured,
      providerConfigured: repairManager.config.providerConfigured,
      missing: repairManager.config.missing,
      timeouts: repairManager.config.timeouts,
    });
    if (url.pathname === '/api/repair/runs' && req.method === 'GET') return send(res, 200, {runs: repairManager.list(), active: repairManager.active()});
    if (url.pathname === '/api/repair/run' && req.method === 'POST') {
      const payload = JSON.parse(await readBody(req) || '{}');
      const run = repairManager.start(payload.caseId);
      return send(res, 202, {run});
    }
    const repairRun = url.pathname.match(/^\/api\/repair\/runs\/([0-9a-f-]+)$/);
    if (repairRun && req.method === 'GET') {
      const run = repairManager.publicRun(repairRun[1]);
      if (!run) return send(res, 404, {error: 'Repair run not found.'});
      return send(res, 200, run);
    }
    const repairDownload = url.pathname.match(/^\/api\/repair\/runs\/([0-9a-f-]+)\/(patch|bundle)$/);
    if (repairDownload && req.method === 'GET') {
      const id = repairDownload[1];
      if (repairDownload[2] === 'patch') {
        const patchFile = repairManager.patchFile(id);
        if (!patchFile || !fs.existsSync(patchFile)) return send(res, 404, {error: 'This run has no generated patch.'});
        const data = fs.readFileSync(patchFile);
        res.writeHead(200, {'content-type': 'text/x-diff; charset=utf-8', 'content-disposition': `attachment; filename="repair-${id}.patch"`, 'content-length': data.length, 'cache-control': 'no-store'});
        res.end(data); return;
      }
      const data = Buffer.from(JSON.stringify(repairManager.bundle(id), null, 2) + '\n');
      res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="repair-bundle-${id}.json"`, 'content-length': data.length, 'cache-control': 'no-store'});
      res.end(data); return;
    }
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
      const exportPath = path.join(run.runDir, 'export.json');
      const exportDoc = {
        schema: 'near-rehearsal/sputnik-export/v2', createdAt: new Date().toISOString(),
        family: FAMILY.family, runId: run.id, inputs: run.input,
        candidate: {filename: run.input.candidate.filename, sha256: run.input.candidate.sha256, label: run.input.candidate.label, provenance: run.input.candidate.provenance, bytesBase64: fs.readFileSync(path.join(run.runDir, 'candidate.wasm')).toString('base64')},
        correction: {filename: run.input.correction.filename, sha256: run.input.correction.sha256, label: run.input.correction.label, provenance: run.input.correction.provenance, bytesBase64: fs.readFileSync(path.join(run.runDir, 'correction.wasm')).toString('base64')},
        inputManifest, frozenBundle: run.frozenBundle,
        obligation: (() => {
          const proposal = run.frozenBundle?.proposal || run.report?.frozenBundle?.proposal || {};
          const transfer = proposal.kind?.Transfer || {};
          return {proposalId: proposal.id ?? null, status: proposal.status ?? null, recipient: transfer.receiver_id ?? null, amount: transfer.amount ?? null};
        })(),
        report: run.report,
        reportSha256: sha256(fs.readFileSync(run.reportPath)),
        verdictSha256: sha256(fs.readFileSync(path.join(run.outDir, 'local-three-verdict.json'))),
        verdict,
        verifyCommand: `node case-triage/sputnik-public-capture/export-helper.cjs verify --export <download.json> --out <new-dir>`,
        portableVerifyCommand: `node case-triage/sputnik-public-capture/export-helper.cjs verify --export <download.json> --out <new-dir>`,
        replayCommand: `node case-triage/sputnik-public-capture/export-helper.cjs replay --export <download.json> --out <new-dir> --sandbox-dir <near-sandbox-directory>`,
        portableReplayCommand: `node case-triage/sputnik-public-capture/export-helper.cjs replay --export <download.json> --out <new-dir> --sandbox-dir <near-sandbox-directory>`,
        downloadUrl: `/api/runs/${run.id}/export/download`,
        limitations: FAMILY.limitations,
      };
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
    if (url.pathname === '/') return file(res, 'home.html');
    if (url.pathname === '/compare' || url.pathname === '/compare/' || url.pathname === '/index.html') return file(res, 'index.html');
    if ((url.pathname === '/repair' || url.pathname === '/repair/') && url.searchParams.get('mode') === 'patch') return file(res, 'patch.html');
    if (url.pathname === '/repair' || url.pathname === '/repair/') return file(res, 'repair.html');
    if (url.pathname === '/review' || url.pathname === '/review/') return file(res, 'review.html');
    if (['/app.js', '/patch.js', '/styles.css', '/home.css', '/repair.js', '/repair.css', '/review.js', '/review.css'].includes(url.pathname)) return file(res, url.pathname.slice(1));
    return send(res, 404, {error: 'Not found.'});
  } catch (e) {
    return send(res, e.statusCode || 400, {error: e.message});
  }
});
if (require.main === module) {
  recoverRuns();
  patchRoute.recover();
  repairManager.recover();
  reviewManager.recover();
  server.listen(PORT, HOST, () => console.log(`Sputnik rehearsal UI: http://${HOST}:${PORT}`));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    try { await patchRoute.shutdown(); } catch {}
    try { await repairManager.shutdown(); } catch {}
    try { await reviewManager.shutdown(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  module.exports = {server, finalizeRun, repairManager, reviewManager};
}
