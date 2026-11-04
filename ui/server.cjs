'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, execFile} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CASE = path.join(ROOT, 'cases/refund-v1/case.json');
const REPORT = path.join(ROOT, 'out/refund-report.json');
const OUT = path.join(ROOT, 'out');
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_LOG_LINES = 160;

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

function reportMtime() {
  try { return fs.statSync(REPORT).mtimeMs; } catch { return 0; }
}

function readReport() {
  try { return JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch { return null; }
}

function startRun() {
  if (activeRunId) {
    return {error: 'A rehearsal is already running.', run: publicRun(runs.get(activeRunId))};
  }
  const id = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const before = reportMtime();
  const run = {
    id,
    status: 'running',
    startedAt,
    finishedAt: null,
    logs: [],
    report: null,
    error: null,
    exitCode: null,
    reportProduced: false,
    finalized: false,
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
    const after = reportMtime();
    if (after > before) {
      const report = readReport();
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
  const wrapper = '/workspace/tools/near-sandbox-wrapper';
  if (!env.NEAR_SANDBOX_BIN_PATH && fs.existsSync(wrapper)) env.NEAR_SANDBOX_BIN_PATH = wrapper;
  if (!env.NEAR_SANDBOX_BINARY_PATH && fs.existsSync(wrapper)) env.NEAR_SANDBOX_BINARY_PATH = wrapper;

  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const command = `ulimit -n 65535 2>/dev/null || true; exec ${quote(process.execPath)} ${quote(path.join(ROOT, 'scripts/refund-three-way.cjs'))} --case ${quote(CASE)}`;
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

  child.on('error', (error) => {
    run.error = error.message;
    finish(null);
  });

  child.on('close', (code) => finish(code));

  // Some local Sandbox children keep a stdio pipe open briefly after the
  // report is written. Finalize on the report rather than waiting forever.
  watch = setInterval(() => {
    if (run.finalized) return;
    if (reportMtime() > before) finish(null);
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
  };
}

const server = http.createServer((req, res) => {
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
    const result = startRun();
    sendJson(res, result.error ? 409 : 202, result);
    return;
  }
  if (requestUrl.pathname === '/api/export' && req.method === 'POST') {
    if (activeRunId) { sendJson(res, 409, {error: 'Wait for the active rehearsal to finish.'}); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch { sendJson(res, 400, {error: 'Invalid JSON.'}); return; }
      const run = runs.get(payload.runId);
      if (!run || !run.report || run.status !== 'complete' || run.report.result?.status !== 'complete') {
        sendJson(res, 409, {error: 'Only a validated complete run can be exported.'});
        return;
      }
      const temp = path.join(OUT, `export-source-${run.id}.json`);
      fs.writeFileSync(temp, JSON.stringify(run.report, null, 2) + '\n');
      execFile(process.execPath, [path.join(ROOT, 'scripts/export-refund-replay.cjs'), '--report', temp], {
        cwd: ROOT, env: {...process.env}, timeout: 120000, maxBuffer: 2 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        try { fs.unlinkSync(temp); } catch {}
        if (error) {
          sendJson(res, 500, {error: stderr || error.message});
          return;
        }
        let parsed;
        try { parsed = JSON.parse(stdout); } catch { sendJson(res, 500, {error: 'Export returned invalid output.'}); return; }
        sendJson(res, 200, parsed);
      });
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
  if (requestUrl.pathname === '/app.js' || requestUrl.pathname === '/styles.css') {
    sendFile(res, path.join(PUBLIC, requestUrl.pathname.slice(1)));
    return;
  }
  res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Rehearsal UI: http://${HOST}:${PORT}`);
  console.log(`Case: ${CASE}`);
});
