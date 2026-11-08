'use strict';
/*
 * Browser adapter for a downloaded repair-review bundle.
 *
 * The CLI entry point remains the only implementation of verification,
 * replay and acceptance. This module owns run state, history and an
 * intentionally narrow public projection: no host paths or credentials
 * leave the server.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {checkBundle} = require('../../scripts/repair-review.cjs');
const {verifyToolchain} = require('../../case-triage/rehearsal-repair/repair-pipeline.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const REVIEW = path.join(ROOT, 'scripts/repair-review.cjs');
const EXAMPLE_BUNDLE = path.join(ROOT, 'test-fixtures/repair-browser-export-1de7b8c5.json');
const DEFAULT_RUNS_ROOT = path.join(ROOT, 'out/sputnik-ui/review-runs');
const CASE_ID = 'sputnik-238-async-bond';
const SCHEMA = 'near-rehearsal/repair-review-bundle/v1';
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_LOG = 180;
const RUN_LIMIT_MS = 35 * 60 * 1000;
const SOURCE_COMMIT = '5434a59dec23ee0c49df8c8c4350c208a7e75b0b';
const BUILD_MANIFEST = path.join(ROOT, 'case-triage/rehearsal-repair/build-manifest.json');
const MODE_LABELS = {
  'recorded-wasm': {label: 'Recorded WASM replay', detail: 'Supplied artifact; no source build.'},
  'source-build': {label: 'Source build', detail: 'Build the supplied patch and replay it.'},
};
const SANDBOX_ENV_KEYS = ['REPAIR_SANDBOX_DIR', 'NEAR_SANDBOX_BIN_PATH', 'NEAR_SANDBOX_BINARY_PATH'];

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const nowIso = () => new Date().toISOString();
const readJson = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

function resolveSandboxDir(env = process.env) {
  for (const key of SANDBOX_ENV_KEYS) {
    if (env[key]) return path.resolve(env[key]);
  }
  return null;
}

function sourceState(env, expected = SOURCE_COMMIT) {
  const sourceDir = env.REPAIR_SOURCE_DIR ? path.resolve(env.REPAIR_SOURCE_DIR) : null;
  if (!sourceDir) return {configured: false, missing: ['REPAIR_SOURCE_DIR'], head: null, clean: null};
  if (!fs.existsSync(path.join(sourceDir, '.git'))) return {configured: false, missing: ['REPAIR_SOURCE_DIR'], head: null, clean: null};
  const headRun = spawnSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], {encoding: 'utf8', timeout: 10_000});
  const head = headRun.status === 0 ? headRun.stdout.trim() : null;
  if (!head) return {configured: false, missing: ['REPAIR_SOURCE_DIR'], head: null, clean: null};
  if (head !== expected) return {configured: false, missing: ['REPAIR_SOURCE_DIR'], head, clean: null};
  const statusRun = spawnSync('git', ['-C', sourceDir, 'status', '--porcelain', '--untracked-files=all'], {encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024});
  const clean = statusRun.status === 0 && !statusRun.stdout.trim();
  return {configured: clean, missing: clean ? [] : ['REPAIR_SOURCE_DIR'], head, clean};
}

function toolchainState() {
  try {
    const manifest = JSON.parse(fs.readFileSync(BUILD_MANIFEST, 'utf8'));
    const toolchain = verifyToolchain(manifest);
    const target = spawnSync(toolchain.env.RUSTC, ['--print', 'target-libdir', '--target', manifest.toolchain.target], {
      env: {...process.env, ...toolchain.env}, encoding: 'utf8', timeout: 10_000,
    });
    if (target.status !== 0 || !fs.existsSync(target.stdout.trim())) throw new Error('wasm32 target is not installed');
    return {configured: true, cargo: toolchain.cargoVersion, rustc: toolchain.rustcVersion, target: manifest.toolchain.target};
  } catch (error) {
    return {configured: false, error: error.message};
  }
}

function modeStatus(mode, bundle, env, rust = toolchainState()) {
  if (!MODE_LABELS[mode]) return {mode, configured: false, missing: ['unknown mode'], label: mode, detail: ''};
  const sandboxDir = resolveSandboxDir(env);
  const missing = [];
  if (!sandboxDir || !fs.existsSync(path.join(sandboxDir, 'near-sandbox'))) missing.push('REPAIR_SANDBOX_DIR');
  let source = null;
  if (mode === 'source-build') {
    source = sourceState(env, bundle?.source?.commit || SOURCE_COMMIT);
    if (!source.configured) missing.push('REPAIR_SOURCE_DIR');
    if (!rust.configured) missing.push('Rust 1.86.0 + wasm32-unknown-unknown');
  }
  return {
    mode,
    label: MODE_LABELS[mode].label,
    detail: MODE_LABELS[mode].detail,
    configured: missing.length === 0,
    missing: [...new Set(missing)],
    source: source ? {configured: source.configured, head: source.head, clean: source.clean} : null,
    rust: mode === 'source-build' ? {configured: rust.configured, target: rust.target || null} : null,
  };
}

function resolveReviewConfig(env = process.env, bundle = null) {
  const rust = toolchainState();
  const modes = {
    'recorded-wasm': modeStatus('recorded-wasm', bundle, env, rust),
    'source-build': modeStatus('source-build', bundle, env, rust),
  };
  const defaultMode = modes['source-build'].configured ? 'source-build' : 'recorded-wasm';
  return {
    configured: modes[defaultMode].configured,
    defaultMode,
    modes,
    missing: modes[defaultMode].missing,
  };
}

function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw Object.assign(new Error('The selected file is not a JSON object.'), {statusCode: 400});
  }
  const text = JSON.stringify(bundle);
  if (Buffer.byteLength(text, 'utf8') > MAX_BUNDLE_BYTES) {
    throw Object.assign(new Error('The selected bundle is larger than the 8 MB browser limit.'), {statusCode: 413});
  }
  try {
    checkBundle(bundle);
  } catch (error) {
    throw Object.assign(new Error(error.message), {statusCode: 400});
  }
  return {
    bundle,
    canonicalSha256: sha256(text),
    runId: bundle.runId,
    caseId: bundle.caseId,
    source: {
      repository: bundle.source.repository,
      commit: bundle.source.commit,
      path: bundle.source.path,
      issue: bundle.source.issue || null,
    },
    candidate: {
      patchSha256: bundle.candidate.patch.sha256,
      wasmSha256: bundle.candidate.wasm.sha256,
      sourceSha256: bundle.recovery?.artifacts?.source?.sha256 || bundle.candidate.identity?.source?.sha256 || null,
    },
    createdAt: bundle.createdAt || null,
  };
}

function cleanError(value) {
  return String(value || '')
    .replace(/\/[\w.@+-]+(?:\/[\w.@+-]+)+/g, '<local-path>')
    .replace(/\b[A-Za-z]:[\\/][^\s:'"]+/g, '<local-path>')
    .slice(-2400);
}

function redactPathString(value) {
  return String(value)
    .replace(/(^|[\s"'(])(\/(?:Users|home|tmp|workspace|opt|var|private|root|mnt)\/[^\s"',)]*)/g, '$1<local-path>')
    .replace(/\b[A-Za-z]:[\\/][^\s"',)]*/g, '<local-path>');
}

function sanitizeEvidence(value) {
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeEvidence(item);
    return out;
  }
  return typeof value === 'string' ? redactPathString(value) : value;
}

function buildEvidence(run) {
  const recorded = run.mode !== 'source-build';
  const evidenceDir = recorded ? path.join(run.outDir, 'recorded-replay') : path.join(run.outDir, 'source-build');
  const persistedDir = recorded ? evidenceDir : path.join(evidenceDir, 'persisted');
  return sanitizeEvidence({
    schema: 'near-rehearsal/review-browser-evidence/v1',
    createdAt: run.finishedAt || nowIso(),
    mode: run.mode,
    bundle: run.bundle,
    result: run.result || null,
    pipeline: recorded ? null : readJson(path.join(evidenceDir, 'pipeline.json')),
    identity: recorded ? null : readJson(path.join(evidenceDir, 'candidate-identity.json')),
    recovery: readJson(path.join(persistedDir, 'persisted-recovery.json')),
    acceptance: readJson(path.join(persistedDir, 'persisted-recovery-acceptance.json')),
  });
}

function publicResult(result, meta) {
  if (!result) return null;
  return {
    schema: 'near-rehearsal/review-browser-result/v1',
    createdAt: result.createdAt || meta.finishedAt || nowIso(),
    bundle: {
      sha256: meta.bundleSha256,
      canonicalSha256: meta.bundle.canonicalSha256 || null,
      bytes: meta.bundle.bytes || null,
      runId: meta.bundle.runId,
      caseId: meta.bundle.caseId,
      source: meta.bundle.source,
      candidate: meta.bundle.candidate,
    },
    run: {
      mode: result.run?.mode || 'recorded-wasm',
      modeLabel: result.run?.modeLabel || 'recorded WASM replay (supplied artifact; no source build)',
      sourceHead: result.run?.sourceHead || null,
      wasmSha256: result.run?.wasmSha256 || result.run?.builtWasmSha256 || null,
      acceptance: result.run?.acceptance ? {
        ok: result.run.acceptance.ok === true,
        candidateWasmSha256: result.run.acceptance.candidateWasmSha256 || null,
        errors: Array.isArray(result.run.acceptance.errors) ? result.run.acceptance.errors.map(cleanError) : [],
      } : null,
    },
    summary: result.summary || null,
    boundary: result.boundary || 'Local NEAR Sandbox 2.14 only. No public write, deployment, production upgrade, or claim about other cases.',
  };
}

function publicRun(run) {
  return {
    id: run.id,
    status: run.status,
    phase: run.phase,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || null,
    elapsedMs: Math.max(0, Date.parse(run.finishedAt || nowIso()) - Date.parse(run.startedAt)),
    error: run.error ? cleanError(run.error) : null,
    logs: (run.logs || []).slice(-MAX_LOG).map(cleanError),
    bundle: run.bundle,
    mode: run.mode || 'recorded-wasm',
    result: run.result || null,
    downloadUrl: run.status === 'accepted' ? `/api/review/runs/${run.id}/download` : null,
    inputUrl: `/api/review/runs/${run.id}/input`,
    evidenceUrl: run.status === 'accepted' ? `/api/review/runs/${run.id}/evidence` : null,
  };
}

function summary(run) {
  return {
    id: run.id,
    status: run.status,
    phase: run.phase,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || null,
    elapsedMs: Math.max(0, Date.parse(run.finishedAt || nowIso()) - Date.parse(run.startedAt)),
    error: run.error ? cleanError(run.error) : null,
    bundle: run.bundle,
    accepted: run.result?.summary?.checks?.accepted === true,
    mode: run.mode || 'recorded-wasm',
    downloadUrl: run.status === 'accepted' ? `/api/review/runs/${run.id}/download` : null,
    inputUrl: `/api/review/runs/${run.id}/input`,
    evidenceUrl: run.status === 'accepted' ? `/api/review/runs/${run.id}/evidence` : null,
  };
}

function createManager(options = {}) {
  const runsRoot = options.runsRoot || DEFAULT_RUNS_ROOT;
  const spawnImpl = options.spawn || spawn;
  const env = options.env || process.env;
  const runs = new Map();
  let activeId = null;

  function ensureRoot() { fs.mkdirSync(runsRoot, {recursive: true}); }
  function runDir(id) { return path.join(runsRoot, id); }
  function writeMeta(run) {
    fs.mkdirSync(runDir(run.id), {recursive: true});
    const meta = {
      schema: 'near-rehearsal/review-browser-run/v1',
      id: run.id,
      status: run.status,
      phase: run.phase,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt || null,
      error: run.error ? cleanError(run.error) : null,
      bundle: run.bundle,
      mode: run.mode || 'recorded-wasm',
      result: run.result || null,
      logs: (run.logs || []).slice(-MAX_LOG).map(cleanError),
    };
    fs.writeFileSync(path.join(runDir(run.id), 'run.json'), json(meta));
    if (run.status !== 'running') fs.writeFileSync(path.join(runDir(run.id), 'result.json'), json(publicRun(run)));
  }

  function appendLog(run, chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line) run.logs.push(line.slice(0, 1200));
    }
    if (run.logs.length > MAX_LOG) run.logs.splice(0, run.logs.length - MAX_LOG);
  }

  function finish(run, {code = null, signal = null, timedOut = false} = {}) {
    if (run.finishedAt) return;
    if (activeId === run.id) activeId = null;
    run.finishedAt = nowIso();
    run.currentChild = null;
    if (timedOut) {
      run.status = 'interrupted';
      run.phase = 'interrupted';
      run.error = 'The recorded replay exceeded its 20-minute limit; it is not accepted.';
    } else {
      const resultPath = path.join(run.outDir, 'review-result.json');
      const result = readJson(resultPath);
      if (code === 0 && result && result.summary?.checks?.accepted === true) {
        run.status = 'accepted';
        run.phase = 'accepted';
        run.result = publicResult(result, {bundle: run.bundle, bundleSha256: run.bundleSha256, finishedAt: run.finishedAt});
        fs.writeFileSync(path.join(runDir(run.id), 'download.json'), json(run.result));
        fs.writeFileSync(path.join(runDir(run.id), 'evidence.json'), json(buildEvidence(run)));
      } else {
        run.status = 'rejected';
        run.phase = 'rejected';
        const detail = run.logs.slice(-4).join(' ').trim();
        run.error = cleanError(result?.summary?.checks?.accepted === false
          ? `The recorded replay did not pass acceptance.${detail ? ` ${detail}` : ''}`
          : `The recorded replay did not produce an accepted result${code === null ? '.' : ` (exit ${code}).`}${detail ? ` ${detail}` : ''}`);
      }
    }
    if (!run.error && code !== 0 && code !== null) run.error = `The recorded replay exited ${code}.`;
    writeMeta(run);
  }

  async function execute(run, bundlePath) {
    const args = [
      REVIEW,
      '--bundle', bundlePath,
      '--out', run.outDir,
      '--mode', run.mode,
    ];
    if (run.sandboxDir) args.push('--sandbox-dir', run.sandboxDir);
    if (run.mode === 'source-build' && run.sourceDir) args.push('--source', run.sourceDir);
    return new Promise((resolve) => {
      let settled = false;
      const done = (options = {}) => {
        if (settled) return;
        settled = true;
        finish(run, options);
        resolve();
      };
      let child;
      try {
        child = spawnImpl(process.execPath, args, {
          cwd: ROOT,
          env: {...process.env},
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        run.status = 'rejected';
        run.phase = 'rejected';
        run.error = cleanError(error.message);
        run.finishedAt = nowIso();
        activeId = activeId === run.id ? null : activeId;
        writeMeta(run);
        resolve();
        return;
      }
      run.currentChild = child;
      child.stdout?.on('data', (chunk) => appendLog(run, chunk));
      child.stderr?.on('data', (chunk) => appendLog(run, chunk));
      const watch = setInterval(() => {
        if (settled || run.finishedAt) return;
        if (fs.existsSync(path.join(run.outDir, 'recorded-replay', 'persisted-recovery.json'))) {
          run.phase = 'accepting';
          writeMeta(run);
        }
      }, 500);
      watch.unref?.();
      const timer = setTimeout(() => {
        run.timedOut = true;
        try { child.kill('SIGKILL'); } catch {}
      }, RUN_LIMIT_MS);
      timer.unref?.();
      child.on('error', (error) => {
        clearTimeout(timer);
        clearInterval(watch);
        done({code: null, signal: null, timedOut: run.timedOut});
        if (!run.error) run.error = cleanError(error.message);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        clearInterval(watch);
        done({code, signal, timedOut: run.timedOut});
      });
    });
  }

  function start(bundle, requestedMode = 'source-build') {
    if (activeId) throw Object.assign(new Error('A review is already active.'), {statusCode: 409});
    if (!MODE_LABELS[requestedMode]) throw Object.assign(new Error('Choose source-build or recorded-wasm.'), {statusCode: 400});
    const validated = validateBundle(bundle);
    const status = modeStatus(requestedMode, bundle, env);
    if (!status.configured) {
      throw Object.assign(new Error(`The ${requestedMode} mode is not ready: ${status.missing.join(', ')}.`), {statusCode: 409});
    }
    ensureRoot();
    const id = crypto.randomUUID();
    const dir = runDir(id);
    const outDir = path.join(dir, 'review');
    fs.mkdirSync(dir, {recursive: true});
    const bundlePath = path.join(dir, 'bundle.json');
    const storedBundle = json(bundle);
    fs.writeFileSync(bundlePath, storedBundle);
    const storedBundleSha256 = sha256(Buffer.from(storedBundle, 'utf8'));
    const run = {
      id,
      status: 'running',
      phase: 'replaying',
      startedAt: nowIso(),
      finishedAt: null,
      error: null,
      logs: [],
      mode: requestedMode,
      sourceDir: requestedMode === 'source-build' ? path.resolve(env.REPAIR_SOURCE_DIR) : null,
      bundle: {
        sha256: storedBundleSha256,
        canonicalSha256: validated.canonicalSha256,
        bytes: Buffer.byteLength(storedBundle),
        runId: validated.runId,
        caseId: validated.caseId,
        source: validated.source,
        candidate: validated.candidate,
        createdAt: validated.createdAt,
      },
      bundleSha256: storedBundleSha256,
      outDir,
      sandboxDir: resolveSandboxDir(env),
      currentChild: null,
    };
    runs.set(id, run);
    activeId = id;
    writeMeta(run);
    run.done = execute(run, bundlePath);
    return publicRun(run);
  }

  function recover() {
    ensureRoot();
    for (const id of fs.readdirSync(runsRoot)) {
      const dir = runDir(id);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      const meta = readJson(path.join(dir, 'run.json'));
      if (!meta) continue;
      const result = readJson(path.join(dir, 'result.json'));
      const run = {
        id,
        status: meta.status,
        phase: meta.phase || meta.status,
        startedAt: meta.startedAt,
        finishedAt: meta.finishedAt || null,
        error: meta.error || null,
        logs: meta.logs || [],
        mode: meta.mode || 'recorded-wasm',
        bundle: meta.bundle || null,
        bundleSha256: meta.bundle?.sha256 || null,
        result: meta.result || null,
        outDir: path.join(dir, 'review'),
      };
      if (meta.status === 'running') {
        run.status = 'interrupted';
        run.phase = 'interrupted';
        run.error = 'Server restarted before this review completed; it is not accepted.';
        run.finishedAt = nowIso();
        fs.writeFileSync(path.join(dir, 'run.json'), json({
          ...meta,
          status: run.status,
          phase: run.phase,
          error: run.error,
          finishedAt: run.finishedAt,
        }));
      } else if (!run.result && result?.result) {
        run.result = result.result;
      }
      runs.set(id, run);
    }
  }

  function get(id) { return runs.get(id) || null; }
  function active() { return activeId; }
  function list() {
    return [...runs.values()]
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .map(summary);
  }
  function download(id) {
    const run = runs.get(id);
    if (!run || run.status !== 'accepted') return null;
    const file = path.join(runDir(id), 'download.json');
    return fs.existsSync(file) ? file : null;
  }
  function input(id) {
    const run = runs.get(id);
    if (!run) return null;
    const file = path.join(runDir(id), 'bundle.json');
    return fs.existsSync(file) ? file : null;
  }
  function evidence(id) {
    const run = runs.get(id);
    if (!run || run.status !== 'accepted') return null;
    const file = path.join(runDir(id), 'evidence.json');
    if (!fs.existsSync(file)) {
      try { fs.writeFileSync(file, json(buildEvidence(run))); } catch { return null; }
    }
    return fs.existsSync(file) ? file : null;
  }
  async function shutdown() {
    const run = runs.get(activeId);
    if (!run?.currentChild) return;
    try { run.currentChild.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { run.currentChild?.kill('SIGKILL'); } catch {} }, 1500).unref?.();
    await Promise.race([run.done, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }

  return {
    case: {id: CASE_ID, schema: SCHEMA, example: path.basename(EXAMPLE_BUNDLE)},
    start,
    get,
    list,
    active,
    recover,
    shutdown,
    publicRun,
    download,
    input,
    evidence,
    runsRoot,
    config(bundle = null) { return resolveReviewConfig(env, bundle); },
    configured: Boolean(resolveSandboxDir(env)),
    missing: resolveSandboxDir(env) ? [] : ['REPAIR_SANDBOX_DIR'],
  };
}

function exampleBundleText() {
  const text = fs.readFileSync(EXAMPLE_BUNDLE, 'utf8');
  const bundle = JSON.parse(text);
  const checked = validateBundle(bundle);
  return {bundle, sha256: sha256(Buffer.from(text, 'utf8')), canonicalSha256: checked.canonicalSha256, filename: path.basename(EXAMPLE_BUNDLE)};
}

module.exports = {
  CASE_ID,
  EXAMPLE_BUNDLE,
  MAX_BUNDLE_BYTES,
  SCHEMA,
  createManager,
  exampleBundleText,
  publicResult,
  resolveSandboxDir,
  validateBundle,
};
