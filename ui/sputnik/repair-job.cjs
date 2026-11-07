'use strict';
/*
 * Thin browser job adapter for the supported issue #238 repair.
 *
 * It owns only the browser-facing run state and the three bounded child
 * processes: fresh baseline reproduction, the existing tool-free producer
 * (generation/controller normalization) and the existing repair pipeline
 * (build, replay, acceptance). It never reimplements provider arguments,
 * patch validation, build commands or acceptance predicates.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REPAIR = path.join(ROOT, 'case-triage/rehearsal-repair');
const ISSUE238 = path.join(REPAIR, 'issue238-local.cjs');
const PRODUCER = path.join(REPAIR, 'codex-producer.cjs');
const PIPELINE = path.join(REPAIR, 'repair-pipeline.cjs');
const CONTROLLER_MANIFEST = path.join(REPAIR, 'controller-manifest.json');
const BUILD_MANIFEST = path.join(REPAIR, 'build-manifest.json');
const DEFAULT_BASE_WASM = path.join(REPAIR, 'bundle/artifacts/base.wasm');
const DEFAULT_RUNS_ROOT = path.join(ROOT, 'out/sputnik-ui/repair-runs');

const CASE_ID = 'sputnik-238-async-bond';
const CASE = {
  id: CASE_ID,
  label: 'Sputnik DAO v2 — failed async proposal bond',
  shortLabel: 'Sputnik #238 bond repair',
  description: 'A local reproduction from pinned upstream Sputnik source. The failed async FunctionCall proposal retains its 1 NEAR bond; a generated source repair must return it exactly once without changing the healthy Transfer payout.',
  source: {
    repository: 'https://github.com/near-daos/sputnik-dao-contract',
    commit: '5434a59dec23ee0c49df8c8c4350c208a7e75b0b',
    path: 'sputnikdao2/src/proposals.rs',
    issue: 'https://github.com/near-daos/sputnik-dao-contract/issues/238',
  },
  obligation: {
    failedAction: 'FunctionCall',
    failedProposalId: 0,
    healthyAction: 'Transfer',
    healthyProposalId: 0,
    bond: '1000000000000000000000000',
    bondNear: '1',
    transfer: '100000000000000000000000',
    transferNear: '0.1',
    recipient: 'recipient.test.near',
    proposer: 'proposer.test.near',
  },
  boundary: 'Local reproduction from pinned upstream source. Not a live DAO, a public-state migration, or an arbitrary-contract repair.',
  timeouts: {
    baselineMs: 5 * 60 * 1000,
    generationMs: 20 * 60 * 1000,
    pipelineMs: 25 * 60 * 1000,
    jobMs: 45 * 60 * 1000,
  },
};

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sha256File = (file) => sha256(fs.readFileSync(file));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const nowIso = () => new Date().toISOString();
const elapsedMs = (startedAt, finishedAt = nowIso()) => Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function resolveConfig(env = process.env) {
  const sourceDir = env.REPAIR_SOURCE_DIR ? path.resolve(env.REPAIR_SOURCE_DIR) : null;
  const baseWasm = path.resolve(env.REPAIR_BASE_WASM || DEFAULT_BASE_WASM);
  const sandboxDir = env.REPAIR_SANDBOX_DIR
    ? path.resolve(env.REPAIR_SANDBOX_DIR)
    : (env.NEAR_SANDBOX_BIN_PATH ? path.resolve(env.NEAR_SANDBOX_BIN_PATH) : null);
  const codexBin = env.CODEX_BIN || 'codex';
  const profile = env.CODEX_PERMISSION_PROFILE || null;
  const privateRuntime = path.resolve(env.CODEX_PRIVATE_RUNTIME || path.join(os.tmpdir(), 'near-repair-provider-runtime'));
  const authSource = env.CODEX_AUTH_SOURCE ? path.resolve(env.CODEX_AUTH_SOURCE) : path.join(os.homedir(), '.codex', 'auth.json');
  const sandboxCmd = env.MODEL_PRODUCER_SANDBOX_CMD || null;
  const model = env.CODEX_MODEL || null;
  const missing = [];
  const buildManifest = readJson(BUILD_MANIFEST, {});
  const expectedBaseSha = buildManifest?.build?.artifactSha256 || null;
  if (!sourceDir || !fs.existsSync(path.join(sourceDir, '.git'))) missing.push('REPAIR_SOURCE_DIR');
  if (!fs.existsSync(baseWasm)) missing.push('REPAIR_BASE_WASM');
  else if (!expectedBaseSha || sha256File(baseWasm) !== expectedBaseSha) missing.push('REPAIR_BASE_WASM');
  if (!sandboxDir || !fs.existsSync(path.join(sandboxDir, 'near-sandbox'))) missing.push('REPAIR_SANDBOX_DIR');
  if (!sandboxCmd) missing.push('MODEL_PRODUCER_SANDBOX_CMD');
  if (!profile) missing.push('CODEX_PERMISSION_PROFILE');
  if (!authSource || !fs.existsSync(authSource)) missing.push('CODEX_AUTH_SOURCE');
  return {
    sourceDir, baseWasm, sandboxDir, codexBin, profile, privateRuntime, authSource, sandboxCmd, model,
    baseWasmSha256: fs.existsSync(baseWasm) ? sha256File(baseWasm) : null,
    providerConfigured: Boolean(sandboxCmd && profile && authSource && fs.existsSync(authSource)),
    configured: missing.length === 0,
    missing,
    timeouts: {...CASE.timeouts},
  };
}

function readPinnedManifest() {
  return {
    controller: readJson(CONTROLLER_MANIFEST, {}),
    build: readJson(BUILD_MANIFEST, {}),
  };
}

function sanitizeValue(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (['binary', 'baseReport', 'candidateReport', 'identity', 'cargo', 'rustupHome', 'runDir', 'outDir', 'privateRuntime', 'workspace', 'authSource', 'codexBin'].includes(k)) continue;
      out[k] = sanitizeValue(v, k);
    }
    return out;
  }
  // Relative paths are useful evidence; machine-local absolute paths are not.
  if (typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))) return '<local-path>';
  return value;
}

function metrics(report) {
  const failed = report?.failed || {};
  const healthy = report?.healthy || {};
  const retry = failed.retry || {};
  const deltas = (branch) => ({
    contract: BigInt(branch?.deltas?.contract ?? 0),
    proposer: BigInt(branch?.deltas?.proposer ?? 0),
    recipient: BigInt(branch?.deltas?.recipient ?? 0),
  });
  const failedDeltas = deltas(failed);
  const healthyDeltas = deltas(healthy);
  const retryDeltas = deltas(retry);
  return {
    failedStatus: failed?.after?.proposal?.status ?? null,
    healthyStatus: healthy?.after?.proposal?.status ?? null,
    failedContract: failedDeltas.contract,
    failedRecipient: failedDeltas.recipient,
    healthyContract: healthyDeltas.contract,
    healthyRecipient: healthyDeltas.recipient,
    retryFinal: retry?.final ?? null,
    retryContract: retryDeltas.contract,
    retryRecipient: retryDeltas.recipient,
    retryGas: BigInt(retry?.summary?.totalTokensBurntYocto ?? 0),
    baselineBond: BigInt(report?.failed?.bondDeclaredYocto ?? 0),
    transfer: BigInt(report?.healthy?.transferDeclaredYocto ?? 0),
    sourceWasmSha256: report?.source?.wasmSha256 ?? null,
    sourceCommit: report?.source?.commit ?? null,
    sandbox: report?.runtime?.sandbox ?? null,
    sandboxCommit: report?.runtime?.commit ?? null,
    sandboxProtocol: report?.runtime?.protocol ?? null,
  };
}

function deriveConsequence(baseline, candidate) {
  if (!baseline || !candidate) return null;
  const base = metrics(baseline);
  const next = metrics(candidate);
  const bond = base.baselineBond || BigInt(CASE.obligation.bond);
  const transfer = base.transfer || BigInt(CASE.obligation.transfer);
  return {
    bond: bond.toString(),
    bondNear: String(Number(bond) / 1e24),
    transfer: transfer.toString(),
    transferNear: String(Number(transfer) / 1e24),
    baseline: {
      bondRetained: base.failedContract === bond && base.failedRecipient === 0n,
      failedContract: base.failedContract.toString(),
      failedRecipient: base.failedRecipient.toString(),
      failedStatus: base.failedStatus,
    },
    candidate: {
      bondReturned: next.failedContract === 0n,
      failedContract: next.failedContract.toString(),
      failedRecipient: next.failedRecipient.toString(),
      failedStatus: next.failedStatus,
      retryNoSecondRefund: next.retryContract === 0n && next.retryRecipient === 0n,
      retryFinal: next.retryFinal,
      retryGas: next.retryGas.toString(),
      healthyPayoutUnchanged: base.healthyRecipient === transfer && next.healthyRecipient === transfer && base.healthyContract === -transfer && next.healthyContract === -transfer,
      healthyRecipient: next.healthyRecipient.toString(),
      healthyContract: next.healthyContract.toString(),
      healthyStatus: next.healthyStatus,
    },
    checks: {
      baselineBondRetained: base.failedContract === bond && base.failedRecipient === 0n,
      candidateBondReturned: next.failedContract === 0n,
      authorizedRetryNoSecondRefund: next.retryFinal === 'FINAL' && next.retryContract === 0n && next.retryRecipient === 0n,
      healthyPayoutUnchanged: base.healthyRecipient === transfer && next.healthyRecipient === transfer && base.healthyContract === -transfer && next.healthyContract === -transfer,
      baseAndCandidateStartSameState: (() => {
        const baseBefore = baseline?.healthy?.before || {};
        const nextBefore = candidate?.healthy?.before || {};
        return JSON.stringify(baseBefore.state ?? null) === JSON.stringify(nextBefore.state ?? null)
          && JSON.stringify(baseBefore.policy ?? null) === JSON.stringify(nextBefore.policy ?? null);
      })(),
      gasSeparated: next.retryGas > 0n,
    },
  };
}

function normalizedRun(run) {
  return {
    id: run.id,
    caseId: run.caseId,
    status: run.status,
    phase: run.phase,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || null,
    elapsedMs: elapsedMs(run.startedAt, run.finishedAt || nowIso()),
    error: run.error || null,
    logs: (run.logs || []).slice(-160),
    phaseLog: run.phaseLog || [],
    source: CASE.source,
    obligation: CASE.obligation,
    boundary: CASE.boundary,
    baseline: run.baseline || null,
    candidate: run.candidate || null,
    consequence: run.consequence || null,
    checks: run.checks || null,
    patch: run.patch ? {filename: 'repair.patch', text: run.patch.text, sha256: run.patch.sha256, bytes: run.patch.bytes} : null,
    patchUrl: run.patch ? `/api/repair/runs/${run.id}/patch` : null,
    bundleUrl: run.status === 'accepted' ? `/api/repair/runs/${run.id}/bundle` : null,
    evidence: run.evidence ? sanitizeValue(run.evidence) : null,
  };
}

function summary(run) {
  return {
    id: run.id, status: run.status, phase: run.phase, startedAt: run.startedAt,
    finishedAt: run.finishedAt || null, elapsedMs: elapsedMs(run.startedAt, run.finishedAt || nowIso()),
    error: run.error || null, bundleUrl: run.status === 'accepted' ? `/api/repair/runs/${run.id}/bundle` : null,
  };
}

function probePrivateRuntime(dir) {
  if (!dir) return null;
  let stat;
  try { stat = fs.statSync(dir); } catch (error) {
    if (error.code === 'ENOENT') return {existed: false, isDirectory: false, wasEmpty: null};
    // Ownership cannot be established; cleanup must leave the path alone.
    return {existed: true, isDirectory: false, wasEmpty: null};
  }
  if (!stat.isDirectory()) return {existed: true, isDirectory: false, wasEmpty: null};
  return {existed: true, isDirectory: true, wasEmpty: fs.readdirSync(dir).length === 0};
}

// A run may only remove a runtime it created itself. An existing directory is
// reused only when it starts empty, and is restored to empty rather than removed.
// Preexisting contents are never touched: the producer refuses to reuse a
// nonempty runtime, and cleanup must not enforce that refusal by deleting it.
function cleanupPrivateRuntime(dir, probe) {
  if (!dir || !probe) return;
  try {
    if (!probe.existed) { fs.rmSync(dir, {recursive: true, force: true}); return; }
    if (!probe.isDirectory || !probe.wasEmpty) return;
    for (const entry of fs.readdirSync(dir)) {
      try { fs.rmSync(path.join(dir, entry), {recursive: true, force: true}); } catch {}
    }
  } catch {}
}

function createManager(options = {}) {
  const env = options.env || process.env;
  const config = options.config || resolveConfig(env);
  const runsRoot = options.runsRoot || DEFAULT_RUNS_ROOT;
  const spawnImpl = options.spawn || spawn;
  const now = options.now || (() => new Date());
  const runs = new Map();
  let activeId = null;
  const pinned = readPinnedManifest();

  function ensureRoot() { fs.mkdirSync(runsRoot, {recursive: true}); }
  function runDir(id) { return path.join(runsRoot, id); }

  function writeMeta(run) {
    const meta = {
      schema: 'near-rehearsal/repair-browser-run/v1',
      id: run.id, caseId: run.caseId, status: run.status, phase: run.phase,
      startedAt: run.startedAt, finishedAt: run.finishedAt || null,
      error: run.error || null, phaseLog: run.phaseLog || [], source: CASE.source,
      obligation: CASE.obligation, baseline: run.baseline || null, candidate: run.candidate || null,
      consequence: run.consequence || null, checks: run.checks || null,
    };
    fs.mkdirSync(runDir(run.id), {recursive: true});
    fs.writeFileSync(path.join(runDir(run.id), 'run.json'), json(meta));
    if (run.status !== 'running') fs.writeFileSync(path.join(runDir(run.id), 'result.json'), json(normalizedRun(run)));
  }

  function setPhase(run, phase) {
    if (run.phase === phase) return;
    const at = nowIso();
    if (run.phaseLog?.length) run.phaseLog[run.phaseLog.length - 1].finishedAt = at;
    run.phase = phase;
    run.phaseLog = run.phaseLog || [];
    run.phaseLog.push({phase, startedAt: at, finishedAt: null});
    writeMeta(run);
  }

  function appendLog(run, chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line) run.logs.push(line.slice(0, 1200));
    }
    if (run.logs.length > 220) run.logs.splice(0, run.logs.length - 220);
  }

  function terminateTree(child, signal = 'SIGTERM') {
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch {}
    }
  }

  function spawnStep(run, label, command, args, options = {}) {
    return new Promise((resolve, reject) => {
      if (run.timedOut || run.status !== 'running') {
        reject(Object.assign(new Error('Repair job was interrupted before the next step.'), {status: 'interrupted', phase: 'interrupted'}));
        return;
      }
      let child;
      try {
        child = spawnImpl(command, args, {
          cwd: options.cwd || ROOT,
          env: {...process.env, ...(options.env || {})},
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (error) { reject(error); return; }
      let settled = false;
      let timedOut = false;
      let hardTimer;
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        terminateTree(child, 'SIGTERM');
        hardTimer = setTimeout(() => terminateTree(child, 'SIGKILL'), 1500);
        hardTimer.unref?.();
      }, options.timeoutMs);
      run.currentChild = child;
      child.stdout?.on('data', (chunk) => appendLog(run, chunk));
      child.stderr?.on('data', (chunk) => appendLog(run, chunk));
      child.on('error', (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(hardTimer);
        terminateTree(child, 'SIGKILL');
        reject(Object.assign(error, {status: 'inconclusive', phase: run.phase}));
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(hardTimer);
        run.currentChild = null;
        if (timedOut || run.timedOut) reject(Object.assign(new Error(`${label} exceeded its ${Math.round(options.timeoutMs / 1000)}s limit.`), {status: 'interrupted', phase: run.phase}));
        else if (code === 0) resolve({code, signal});
        else reject(Object.assign(new Error(`${label} exited ${code ?? signal}.`), {status: 'inconclusive', phase: run.phase, exitCode: code}));
      });
    });
  }

  function phaseWatcher(run) {
    const pipelineDir = path.join(runDir(run.id), 'pipeline');
    const buildLog = path.join(pipelineDir, 'build.log');
    const replayLog = path.join(pipelineDir, 'replay.log');
    return setInterval(() => {
      if (run.status !== 'running') return;
      if (run.phase === 'compiling' && fs.existsSync(buildLog) && !fs.existsSync(replayLog)) setPhase(run, 'replaying');
    }, 500);
  }

  async function execute(run) {
    const runtimeProbe = probePrivateRuntime(config.privateRuntime);
    const overall = setTimeout(() => {
      if (run.status !== 'running') return;
      run.timedOut = true;
      run.status = 'interrupted';
      run.phase = 'interrupted';
      run.error = `Repair job exceeded the ${Math.round(config.timeouts.jobMs / 60000)}-minute limit; it is not accepted.`;
      run.finishedAt = nowIso();
      terminateTree(run.currentChild, 'SIGTERM');
      setTimeout(() => terminateTree(run.currentChild, 'SIGKILL'), 1500).unref?.();
      writeMeta(run);
    }, config.timeouts.jobMs);
    let watcher;
    try {
      const baselineDir = path.join(runDir(run.id), 'baseline');
      fs.mkdirSync(baselineDir, {recursive: true});
      setPhase(run, 'reproducing');
      await spawnStep(run, 'Fresh baseline reproduction', process.execPath, [ISSUE238], {
        timeoutMs: config.timeouts.baselineMs,
        env: {
          ...(config.sandboxDir ? {NEAR_SANDBOX_BIN_PATH: config.sandboxDir, NEAR_SANDBOX_BINARY_PATH: config.sandboxDir} : {}),
          SPUTNIK_WASM: config.baseWasm,
          SPUTNIK_SOURCE_SHA: CASE.source.commit,
          SPUTNIK_OUT_DIR: baselineDir,
        },
      });
      const baselinePath = path.join(baselineDir, 'issue238-local.json');
      const baseline = readJson(baselinePath);
      if (!baseline) throw Object.assign(new Error('Fresh baseline produced no report.'), {status: 'inconclusive'});
      if (baseline?.source?.commit !== CASE.source.commit) throw Object.assign(new Error('Fresh baseline source commit does not match the pinned case.'), {status: 'rejected'});
      if (baseline?.runtime?.sandbox !== '2.14.0') throw Object.assign(new Error('Fresh baseline did not run on Sandbox 2.14.0.'), {status: 'inconclusive'});
      run.baseline = {
        sha256: sha256File(baselinePath),
        reportPath: 'baseline/issue238-local.json',
        source: sanitizeValue(baseline.source),
        runtime: sanitizeValue(baseline.runtime),
        consequence: {
          failedContractDelta: baseline?.failed?.deltas?.contract ?? null,
          failedRecipientDelta: baseline?.failed?.deltas?.recipient ?? null,
          healthyRecipientDelta: baseline?.healthy?.deltas?.recipient ?? null,
        },
      };
      if (!config.providerConfigured) {
        throw Object.assign(new Error(`Model provider is not configured on this server (${config.missing.join(', ') || 'missing provider configuration'}). The fresh baseline completed, but no model generation was attempted.`), {status: 'inconclusive', phase: 'generating'});
      }
      setPhase(run, 'generating');
      const producerDir = path.join(runDir(run.id), 'producer');
      const producerArgs = [
        PRODUCER, '--source', config.sourceDir, '--out', producerDir,
        '--profile', config.profile, '--private-runtime', config.privateRuntime,
        '--auth-source', config.authSource, '--codex-bin', config.codexBin,
        '--no-pipeline', '--timeout-ms', String(config.timeouts.generationMs),
      ];
      if (config.model) producerArgs.push('--model', config.model);
      await spawnStep(run, 'Model generation', process.execPath, producerArgs, {timeoutMs: config.timeouts.generationMs});
      const producer = readJson(path.join(producerDir, 'producer.json'));
      const patchPath = path.join(producerDir, 'canonical.patch');
      if (!producer || !fs.existsSync(patchPath)) throw Object.assign(new Error('Model generation produced no canonical patch.'), {status: 'rejected'});
      const patchText = fs.readFileSync(patchPath, 'utf8');
      run.patch = {text: patchText, sha256: sha256File(patchPath), bytes: Buffer.byteLength(patchText)};
      run.candidate = {
        producer: sanitizeValue(producer),
        sourceSha256: producer.changedSourceSha256 || null,
        patchSha256: run.patch.sha256,
      };
      setPhase(run, 'compiling');
      const pipelineDir = path.join(runDir(run.id), 'pipeline');
      const pipelineArgs = [
        PIPELINE, '--patch', patchPath, '--source', config.sourceDir, '--out', pipelineDir,
        '--base-report', baselinePath,
      ];
      if (config.sandboxDir) pipelineArgs.push('--sandbox-dir', config.sandboxDir);
      const provenancePath = path.join(producerDir, 'attempt/provenance.json');
      if (fs.existsSync(provenancePath)) pipelineArgs.push('--provenance', provenancePath);
      watcher = phaseWatcher(run);
      let pipelineExitError = null;
      try {
        await spawnStep(run, 'Repair pipeline', process.execPath, pipelineArgs, {timeoutMs: config.timeouts.pipelineMs});
      } catch (error) {
        pipelineExitError = error;
      }
      clearInterval(watcher);
      const pipeline = readJson(path.join(pipelineDir, 'pipeline.json'));
      if (!pipeline) throw pipelineExitError || Object.assign(new Error('Repair pipeline produced no result.'), {status: 'inconclusive'});
      run.candidate.pipeline = sanitizeValue(pipeline);
      run.candidate.wasm = {sha256: pipeline?.hashes?.wasm || null, bytes: fs.existsSync(path.join(pipelineDir, 'applied/target/wasm32-unknown-unknown/release/sputnikdao2.wasm')) ? fs.statSync(path.join(pipelineDir, 'applied/target/wasm32-unknown-unknown/release/sputnikdao2.wasm')).size : null};
      const candidateReportPath = path.join(pipelineDir, 'replay/issue238-local.json');
      const candidate = readJson(candidateReportPath);
      if (!candidate) throw Object.assign(new Error('Repair pipeline produced no candidate report.'), {status: 'inconclusive'});
      run.consequence = deriveConsequence(baseline, candidate);
      run.checks = run.consequence?.checks || null;
      run.evidence = {
        baseline: sanitizeValue(baseline),
        candidate: sanitizeValue(candidate),
        acceptance: {errors: pipeline.acceptanceErrors || [], changedArtifactRejected: pipeline.changedArtifactRejected === true, pipelineOk: pipeline.ok === true},
        identity: sanitizeValue(readJson(path.join(pipelineDir, 'candidate-identity.json'), {})),
      };
      const accepted = pipeline.ok === true && (pipeline.acceptanceErrors || []).length === 0 && run.checks?.baselineBondRetained && run.checks?.candidateBondReturned && run.checks?.authorizedRetryNoSecondRefund && run.checks?.healthyPayoutUnchanged;
      if (accepted) {
        run.status = 'accepted'; setPhase(run, 'accepted');
      } else {
        run.status = 'rejected'; setPhase(run, 'rejected');
        run.error = `The repair ran but did not pass the declared checks${pipeline.acceptanceErrors?.length ? `: ${pipeline.acceptanceErrors.join('; ')}` : '.'}${pipelineExitError ? ` Pipeline exited: ${pipelineExitError.message}` : ''}`;
      }
    } catch (error) {
      if (watcher) clearInterval(watcher);
      if (run.timedOut) {
        run.status = 'interrupted'; run.phase = 'interrupted';
        run.error = `Repair job exceeded the ${Math.round(config.timeouts.jobMs / 60000)}-minute limit; it is not accepted.`;
      } else {
        run.status = error.status || 'inconclusive';
        if (error.phase) run.phase = error.phase;
        if (run.status === 'interrupted') run.phase = 'interrupted';
        run.error = error.message || String(error);
      }
    } finally {
      clearTimeout(overall);
      run.finishedAt = nowIso();
      run.currentChild = null;
      if (run.timedOut) { run.status = 'interrupted'; run.phase = 'interrupted'; }
      if (run.status === 'running') { run.status = 'inconclusive'; run.phase = 'inconclusive'; run.error = 'Repair job ended without a terminal result.'; }
      cleanupPrivateRuntime(config.privateRuntime, runtimeProbe);
      activeId = activeId === run.id ? null : activeId;
      writeMeta(run);
    }
  }

  function start(caseId) {
    if (caseId !== CASE_ID) throw Object.assign(new Error('Unsupported repair case.'), {statusCode: 400});
    if (activeId) throw Object.assign(new Error('A repair job is already active.'), {statusCode: 409});
    ensureRoot();
    const id = crypto.randomUUID();
    const run = {
      id, caseId: CASE_ID, status: 'running', phase: 'queued', startedAt: nowIso(), finishedAt: null,
      error: null, logs: [], phaseLog: [], baseline: null, candidate: null, consequence: null, checks: null, patch: null, evidence: null,
    };
    runs.set(id, run); activeId = id; writeMeta(run);
    execute(run);
    return normalizedRun(run);
  }

  function recover() {
    ensureRoot();
    for (const id of fs.readdirSync(runsRoot)) {
      const dir = runDir(id);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      const meta = readJson(path.join(dir, 'run.json'));
      if (!meta) continue;
      const result = readJson(path.join(dir, 'result.json'));
      if (meta.status === 'running') {
        meta.status = 'interrupted'; meta.phase = 'interrupted';
        meta.error = 'Server restarted before this repair job completed; it is not accepted.';
        meta.finishedAt = nowIso();
        meta.phaseLog = [...(meta.phaseLog || []), {phase: 'interrupted', startedAt: meta.finishedAt, finishedAt: meta.finishedAt}];
        fs.writeFileSync(path.join(dir, 'run.json'), json(meta));
      }
      const run = {
        id, caseId: meta.caseId || CASE_ID, status: meta.status, phase: meta.phase || meta.status,
        startedAt: meta.startedAt, finishedAt: meta.finishedAt || null, error: meta.error || null,
        logs: [], phaseLog: meta.phaseLog || [], baseline: meta.baseline || null,
        candidate: meta.candidate || null, consequence: meta.consequence || null, checks: meta.checks || null,
        patch: result?.patch || null, evidence: result?.evidence || null,
      };
      runs.set(id, run);
    }
  }

  function get(id) { return runs.get(id) || null; }
  function list() { return [...runs.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).map(summary); }
  function active() { return activeId; }

  function patchFile(id) {
    const run = runs.get(id);
    if (!run?.patch) return null;
    return path.join(runDir(id), 'producer', 'canonical.patch');
  }

  function bundle(id) {
    const run = runs.get(id);
    if (!run || run.status !== 'accepted') throw Object.assign(new Error('Only an accepted repair can be exported.'), {statusCode: 409});
    const dir = runDir(id);
    const pipelineDir = path.join(dir, 'pipeline');
    const producerDir = path.join(dir, 'producer');
    const pipeline = readJson(path.join(pipelineDir, 'pipeline.json'));
    const baseline = readJson(path.join(dir, 'baseline/issue238-local.json'));
    const candidate = readJson(path.join(pipelineDir, 'replay/issue238-local.json'));
    const identity = readJson(path.join(pipelineDir, 'candidate-identity.json'), {});
    const patchPath = path.join(producerDir, 'canonical.patch');
    const wasmPath = path.join(pipelineDir, 'applied/target/wasm32-unknown-unknown/release/sputnikdao2.wasm');
    if (!fs.existsSync(patchPath) || !fs.existsSync(wasmPath)) throw new Error('Accepted repair bundle files are missing.');
    const patch = fs.readFileSync(patchPath);
    const wasm = fs.readFileSync(wasmPath);
    return {
      schema: 'near-rehearsal/repair-review-bundle/v1',
      createdAt: nowIso(), runId: id, caseId: CASE_ID,
      source: CASE.source, case: CASE,
      build: {
        rust: pinned.build?.toolchain?.rust || '1.86.0',
        target: pinned.build?.toolchain?.target || 'wasm32-unknown-unknown',
        command: pinned.build?.build?.command || null,
        artifact: pinned.build?.build?.artifact || null,
      },
      baseline: (() => {
        const report = sanitizeValue(baseline);
        const reportText = JSON.stringify(report);
        return {report, reportText, reportSha256: sha256(reportText)};
      })(),
      candidate: (() => {
        const report = sanitizeValue(candidate);
        const reportText = JSON.stringify(report);
        const identityValue = sanitizeValue(identity);
        const identityText = JSON.stringify(identityValue);
        return {
          report, reportText, reportSha256: sha256(reportText),
          identity: identityValue, identityText, identitySha256: sha256(identityText),
          pipeline: sanitizeValue(pipeline),
          patch: {filename: 'repair.patch', sha256: sha256(patch), bytes: patch.length, text: patch.toString('utf8')},
          wasm: {filename: 'candidate.wasm', sha256: sha256(wasm), bytes: wasm.length, base64: wasm.toString('base64')},
        };
      })(),
      consequence: run.consequence, checks: run.checks,
      commands: {
        verify: 'node case-triage/rehearsal-repair/acceptance.cjs --base <baseline-report.json> --repaired <candidate-report.json> --identity <candidate-identity.json> --patch <repair.patch> --source <applied-proposals.rs> --wasm <candidate.wasm>',
        recipe: 'From the pinned source commit, apply repair.patch, unpack baseline.report and candidate.report and candidate.wasm, then run the acceptance command above. Check every recorded SHA-256 before running it. No absolute paths or account runtime files are included.',
      },
      boundary: CASE.boundary,
    };
  }

  function publicRun(id) {
    const run = runs.get(id);
    return run ? normalizedRun(run) : null;
  }

  return {config, case: CASE, start, get, list, active, recover, publicRun, patchFile, bundle, runsRoot};
}

module.exports = {CASE, CASE_ID, createManager, cleanupPrivateRuntime, deriveConsequence, metrics, probePrivateRuntime, resolveConfig, sanitizeValue, normalizedRun, summary, computeSha256: sha256};
