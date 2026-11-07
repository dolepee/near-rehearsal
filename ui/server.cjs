'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, execFile} = require('node:child_process');
const {validateInput} = require('../scripts/refund-input.cjs');
const {validateCase} = require('../scripts/refund-three-way.cjs');

const ROOT = path.join(__dirname, '..');
const CASE = path.join(ROOT, 'cases/refund-v1/case.json');
const OUT = path.join(ROOT, 'out');
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_LOG_LINES = 160;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const runs = new Map();
let activeRunId = null;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(res, file) {
  const ext = path.extname(file);
  const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'};
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store'});
    res.end(data);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > limit) {
        reject(new Error(`request body exceeds ${limit} bytes`));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
function readReport(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function buildRunCase(input) {
  const base = validateCase(CASE);
  const inputDir = path.join(OUT, 'inputs', input.sha256);
  fs.mkdirSync(inputDir, {recursive: true});
  const candidatePath = path.join(inputDir, 'candidate.wasm');
  fs.writeFileSync(candidatePath, input.bytes);
  const runId = crypto.randomUUID();
  const runDir = path.join(OUT, 'runs', runId);
  fs.mkdirSync(runDir, {recursive: true});
  const caseConfig = {
    ...base,
    label: `${base.label} / ${input.filename}`,
    candidates: {
      bad: {
        id: 'supplied-candidate',
        label: input.filename,
        wasm: rel(candidatePath),
        sha256: input.sha256,
      },
      corrected: base.candidates.corrected,
    },
    migration: input.migration,
    operation: input.operation,
    expected: {...base.expected, bad: 'candidate'},
  };
  const casePath = path.join(runDir, 'case.json');
  fs.writeFileSync(casePath, JSON.stringify(caseConfig, null, 2) + '\n');
  validateCase(casePath);
  return {
    runId,
    runDir,
    casePath,
    reportPath: path.join(runDir, 'report.json'),
    candidatePath,
    input: {
      family: input.family,
      filename: input.filename,
      sha256: input.sha256,
      bytes: input.bytes.length,
      exports: input.exports,
      migration: input.migration,
      operation: input.operation,
    },
  };
}

function startRun(input) {
  if (activeRunId) {
    return {error: 'A rehearsal is already running.', run: publicRun(runs.get(activeRunId))};
  }
  const built = buildRunCase(input);
  const id = built.runId;
  const before = mtime(built.reportPath);
  const run = {
    id,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [],
    report: null,
    error: null,
    exitCode: null,
    reportProduced: false,
    finalized: false,
    input: built.input,
    casePath: built.casePath,
    reportPath: built.reportPath,
  };
  runs.set(id, run);
  activeRunId = id;
  let watch = null;

  const finish = (code) => {
    if (run.finalized) return;
    run.finalized = true;
    if (watch) clearInterval(watch);
    if (code !== undefined) run.exitCode = code;
    run.finishedAt = new Date().toISOString();
    if (activeRunId === id) activeRunId = null;
    if (mtime(run.reportPath) > before) {
      const report = readReport(run.reportPath);
      if (report) {
        run.report = report;
        run.reportProduced = true;
        run.status = (code === 0 || code === null || code === undefined) && report.result?.status === 'complete' ? 'complete' : 'incomplete';
        if (code !== 0 && code !== null && code !== undefined && !run.error) run.error = `Rehearsal exited with code ${code}.`;
        return;
      }
    }
    run.status = 'error';
    if (!run.error) run.error = code === 0 ? 'The rehearsal finished without writing a report.' : `Rehearsal exited with code ${code ?? 'unknown'}.`;
  };

  const env = {...process.env};

  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const command = `ulimit -n 65535 2>/dev/null || true; exec ${quote(process.execPath)} ${quote(path.join(ROOT, 'scripts/refund-three-way.cjs'))} --case ${quote(run.casePath)} --report ${quote(run.reportPath)}`;
  const child = spawn('/bin/bash', ['-lc', command], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const append = (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      run.logs.push(line.slice(0, 1200));
    }
    if (run.logs.length > MAX_LOG_LINES) run.logs.splice(0, run.logs.length - MAX_LOG_LINES);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (error) => { run.error = error.message; finish(null); });
  child.on('close', (code) => finish(code));
  watch = setInterval(() => {
    if (run.finalized) return;
    if (mtime(run.reportPath) > before) finish(null);
  }, 500);

  return {run: publicRun(run)};
}

function publicRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    logs: run.logs,
    report: run.report,
    error: run.error,
    exitCode: run.exitCode,
    reportProduced: run.reportProduced,
    input: run.input,
  };
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  if (requestUrl.pathname === '/api/health') {
    sendJson(res, 200, {ok: true, running: !!activeRunId});
    return;
  }
  if (requestUrl.pathname === '/api/state') {
    sendJson(res, 200, {active: activeRunId ? publicRun(runs.get(activeRunId)) : null});
    return;
  }
  if (requestUrl.pathname === '/api/rehearse' && req.method === 'POST') {
    try {
      const body = await readBody(req, MAX_BODY_BYTES);
      const input = validateInput(JSON.parse(body || '{}'));
      const result = startRun(input);
      sendJson(res, result.error ? 409 : 202, result);
    } catch (error) {
      sendJson(res, 400, {error: error.message});
    }
    return;
  }
  if (requestUrl.pathname === '/api/export' && req.method === 'POST') {
    if (activeRunId) { sendJson(res, 409, {error: 'Wait for the active rehearsal to finish.'}); return; }
    let payload;
    try { payload = JSON.parse(await readBody(req, 10000) || '{}'); } catch { sendJson(res, 400, {error: 'Invalid JSON.'}); return; }
    const run = runs.get(payload.runId);
    if (!run || !run.report || run.status !== 'complete' || run.report.result?.status !== 'complete') {
      sendJson(res, 409, {error: 'Only a validated complete run can be exported.'});
      return;
    }
    execFile(process.execPath, [
      path.join(ROOT, 'scripts/export-refund-replay.cjs'),
      '--case', run.casePath,
      '--report', run.reportPath,
      '--capture', path.join(ROOT, 'out/refund-capture.json'),
    ], {
      cwd: ROOT, env: {...process.env}, timeout: 120000, maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) { sendJson(res, 500, {error: stderr || error.message}); return; }
      try { sendJson(res, 200, JSON.parse(stdout)); } catch { sendJson(res, 500, {error: 'Export returned invalid output.'}); }
    });
    return;
  }
  const match = requestUrl.pathname.match(/^\/api\/runs\/([0-9a-f-]+)$/);
  if (match && req.method === 'GET') {
    const run = runs.get(match[1]);
    if (!run) { sendJson(res, 404, {error: 'Run not found.'}); return; }
    sendJson(res, 200, publicRun(run));
    return;
  }
  if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
    sendFile(res, path.join(PUBLIC, 'index.html'));
    return;
  }
  if (requestUrl.pathname === '/app.js' || requestUrl.pathname === '/styles.css' || requestUrl.pathname === '/polling.js') {
    sendFile(res, path.join(PUBLIC, requestUrl.pathname.slice(1)));
    return;
  }
  const fixture = requestUrl.pathname.match(/^\/fixtures\/(refund-v2-bad|refund-v2-fixed)\.wasm$/);
  if (fixture) {
    sendFile(res, path.join(ROOT, 'contracts', `${fixture[1]}.wasm`));
    return;
  }
  res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Rehearsal UI: http://${HOST}:${PORT}`);
  console.log(`Case: ${CASE}`);
});
