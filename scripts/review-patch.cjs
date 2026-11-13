'use strict';
/*
 * Model-free review of a maintainer-supplied source patch.
 *
 * This command accepts a diff, not a pre-approved Rehearsal bundle. It applies
 * the diff to a clean checkout of the supported Sputnik revision, builds it,
 * runs the existing fresh-state replay and persisted-recovery acceptance, and
 * writes a review report with a deliberately narrow status vocabulary.
 *
 * The acceptance policy is loaded from the repository, not from the patch or
 * any caller-supplied report. The caller's repository/base/head strings are
 * recorded as supplied metadata; the checked source commit, patch bytes,
 * applied source and built WASM are hashed independently.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {formatYocto, summarize} = require('./repair-review.cjs');

const ROOT = path.resolve(__dirname, '..');
const REPAIR = path.join(ROOT, 'case-triage', 'rehearsal-repair');
const PIPELINE = path.join(REPAIR, 'repair-pipeline.cjs');
const PERSISTED = path.join(REPAIR, 'persisted-recovery.cjs');
const PERSISTED_ACCEPTANCE = path.join(REPAIR, 'persisted-recovery-acceptance.cjs');
const CONTROLLER_MANIFEST = path.join(REPAIR, 'controller-manifest.json');
const BUILD_MANIFEST = path.join(REPAIR, 'build-manifest.json');
const ACCEPTANCE = path.join(REPAIR, 'acceptance.cjs');
const MIXED = path.join(REPAIR, 'mixed-obligation.cjs');
const SETTLEMENT = path.join(REPAIR, 'settlement-refund-tests.cjs');
const MIXED_POLICY = path.join(REPAIR, 'mixed-policy.cjs');
const {verifyMixedReport} = require(MIXED_POLICY);
const {verifySettlementReport} = require(path.join(REPAIR, 'settlement-policy.cjs'));
const {POLICY_VERSION, evaluateCandidate, stageFromChecks} = require(path.join(REPAIR, 'acceptance-orchestrator.cjs'));
const BASE_REPORT = path.join(REPAIR, 'out', 'issue238-local.json');
const BASE_WASM = path.join(REPAIR, 'bundle', 'artifacts', 'base.wasm');
const SCHEMA = 'near-rehearsal/review-patch/v1';
const CASE_ID = 'sputnik-238-async-bond';
const SOURCE_PATH = 'sputnikdao2/src/proposals.rs';
const SANDBOX_ENV_KEYS = ['REPAIR_SANDBOX_DIR', 'NEAR_SANDBOX_BIN_PATH', 'NEAR_SANDBOX_BINARY_PATH'];
const MAX_PATCH_BYTES = 1024 * 1024;
const PIPELINE_TIMEOUT_MS = 30 * 60 * 1000;
const PERSISTED_TIMEOUT_MS = 15 * 60 * 1000;
const ACCEPTANCE_TIMEOUT_MS = 60 * 1000;
const MIXED_TIMEOUT_MS = 30 * 60 * 1000;
const SETTLEMENT_TIMEOUT_MS = 15 * 60 * 1000;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sha256File = (file) => sha256(fs.readFileSync(file));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const exists = (file) => Boolean(file) && fs.existsSync(file);
const isFile = (file) => exists(file) && fs.statSync(file).isFile();
const isDir = (file) => exists(file) && fs.statSync(file).isDirectory();

function usage() {
  return [
    'Usage:',
    '  npm run review:patch -- --patch <maintainer.diff> --source <clean-pinned-checkout> --out <new-dir> [options]',
    '',
    'Required:',
    '  --patch <file>       Unified diff against the pinned Sputnik revision',
    '  --source <dir>       Clean checkout at 5434a59dec23ee0c49df8c8c4350c208a7e75b0b',
    '  --out <dir>          New or empty output directory for evidence',
    '',
    'Optional:',
    '  --repo <label>       Caller-supplied repository label; recorded, not verified',
    '  --base <label>       Caller-supplied base label; recorded, not verified',
    '  --head <label>       Caller-supplied head label; recorded, not verified',
    '  --base-report <file> Pinned authored base report (default: issue238-local.json)',
    '  --sandbox-dir <dir>  Directory containing the pinned near-sandbox binary',
    '  --help               Show this help',
    '',
    'Statuses:',
    '  ACCEPTED       The defined source, build, replay, recovery and preservation checks passed.',
    '  REJECTED       A valid executable candidate failed a defined recovery or preservation check.',
    '  INPUT_ERROR    The patch, source checkout or caller input could not form a valid candidate.',
    '  BUILD_ERROR    The candidate was accepted as input but did not compile.',
    '  INCONCLUSIVE   A missing runtime or interrupted execution prevented a judgment.',
    '',
    'ACCEPTED does not mean universally safe or live-DAO recovered. It means these',
    'defined checks passed for this pinned case. The output is local evidence, not',
    'a signed report or a GitHub merge restriction.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    patch: null,
    source: null,
    out: null,
    repo: null,
    base: null,
    head: null,
    baseReport: BASE_REPORT,
    sandboxDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--patch') opts.patch = argv[++i];
    else if (arg === '--source') opts.source = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--repo') opts.repo = argv[++i];
    else if (arg === '--base') opts.base = argv[++i];
    else if (arg === '--head') opts.head = argv[++i];
    else if (arg === '--base-report') opts.baseReport = argv[++i];
    else if (arg === '--sandbox-dir') opts.sandboxDir = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.help) return opts;
  if (!opts.patch) throw new Error('--patch is required');
  if (!opts.source) throw new Error('--source is required');
  if (!opts.out) throw new Error('--out is required');
  return opts;
}

function sandboxFromEnvironment(env = process.env) {
  for (const key of SANDBOX_ENV_KEYS) {
    if (env[key]) return path.resolve(env[key]);
  }
  return null;
}

function checkOutput(outDir) {
  if (!exists(outDir)) return;
  if (!isDir(outDir)) throw new Error(`--out is not a directory: ${outDir}`);
  if (fs.readdirSync(outDir).length) throw new Error(`--out must be new or empty: ${outDir}`);
}

function checkSource(sourceDir, pinnedCommit) {
  if (!isDir(sourceDir)) throw new Error(`source checkout not found: ${sourceDir}`);
  if (!exists(path.join(sourceDir, '.git'))) throw new Error('source checkout is not a Git worktree');
  const headRun = spawnSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], {encoding: 'utf8', timeout: 30_000});
  const head = headRun.status === 0 ? headRun.stdout.trim() : null;
  if (!head) throw new Error('could not read source checkout HEAD');
  if (head !== pinnedCommit) throw new Error(`source checkout HEAD ${head} does not match pinned ${pinnedCommit}`);
  const statusRun = spawnSync('git', ['-C', sourceDir, 'status', '--porcelain', '--untracked-files=all'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (statusRun.status !== 0) throw new Error('could not inspect source checkout status');
  if (statusRun.stdout.trim()) throw new Error('source checkout is dirty; use a clean checkout');
  return head;
}

function policyIdentity(baseReport) {
  const controller = JSON.parse(fs.readFileSync(CONTROLLER_MANIFEST, 'utf8'));
  const build = JSON.parse(fs.readFileSync(BUILD_MANIFEST, 'utf8'));
  const files = {
    controllerManifest: sha256File(CONTROLLER_MANIFEST),
    buildManifest: sha256File(BUILD_MANIFEST),
    pipeline: sha256File(PIPELINE),
    persistedRecovery: sha256File(PERSISTED),
    acceptance: sha256File(ACCEPTANCE),
    persistedAcceptance: sha256File(PERSISTED_ACCEPTANCE),
    mixedObligation: sha256File(MIXED),
    mixedPolicy: sha256File(MIXED_POLICY),
    baseReport: sha256File(baseReport),
    baseWasm: sha256File(BASE_WASM),
  };
  const identity = {
    caseId: CASE_ID,
    sourceRepository: controller.source.repository,
    sourceCommit: controller.source.commit,
    allowedPaths: controller.allowedPaths,
    build: build.build,
    runtime: build.localRuntime,
    files,
  };
  identity.policySha256 = sha256(Buffer.from(JSON.stringify(identity), 'utf8'));
  return identity;
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeout || PIPELINE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: {...process.env, ...(options.env || {})},
  });
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function writeLog(file, result) {
  fs.writeFileSync(file, [
    `exit=${result.status}`,
    `signal=${result.signal || ''}`,
    '--- stdout',
    result.stdout || '',
    '--- stderr',
    result.stderr || '',
  ].join('\n'));
}

function classify(stage, details = {}) {
  if (details.inputError) return {status: 'INPUT_ERROR', reason: details.inputError};
  if (details.buildError) return {status: 'BUILD_ERROR', reason: details.buildError};
  if (details.inconclusive) return {status: 'INCONCLUSIVE', reason: details.inconclusive};
  if (details.rejected) return {status: 'REJECTED', reason: details.rejected};
  if (details.accepted) return {status: 'ACCEPTED', reason: 'All defined checks passed.'};
  return {status: 'INCONCLUSIVE', reason: `No terminal result was produced at ${stage}.`};
}

/*
 * A log file existing is not a verdict. Only a completed pipeline.json can
 * classify a candidate as rejected; a compiler failure is a build error. A
 * missing pipeline verdict, including a Sandbox/RPC/dependency interruption,
 * stays inconclusive even when replay.log exists.
 */
function classifyPipelineResult({pipeline, buildLogText, replayReportExists}) {
  if (pipeline) {
    if (pipeline.ok === true) return {kind: 'accepted'};
    return {
      kind: 'rejected',
      reason: `fresh-state acceptance failed: ${(pipeline.acceptanceErrors || []).join('; ') || 'pipeline did not pass'}`,
    };
  }
  if (typeof buildLogText === 'string' && /(?:^|\n)exit=[1-9]/.test(buildLogText)) {
    return {kind: 'buildError', reason: 'Candidate source did not compile.'};
  }
  if (replayReportExists) {
    return {kind: 'inconclusive', reason: 'replay produced a report but no completed pipeline verdict' };
  }
  return {kind: 'inconclusive', reason: 'pipeline produced no completed verdict; runtime or dependency interruption' };
}

function reportSummary(report, acceptance, run) {
  if (!report) return null;
  const summary = summarize(report, {
    mode: 'source-build',
    modeLabel: 'source build (fresh compile and replay)',
    acceptance: {ok: acceptance?.ok === true},
  });
  return {
    ...summary,
    accepted: acceptance?.ok === true,
    sourceCommit: report.source?.commit || null,
    candidateWasmSha256: report.candidate?.wasmSha256 || null,
  };
}

function asBigInt(value) {
  try { return BigInt(value); } catch { return null; }
}

function checksFrom(pipeline, report, acceptance, mixedCheck = null, settlementCheck = null) {
  const checks = [];
  const add = (id, ok, detail, status = null) => checks.push({
    id,
    status: status || (ok === true ? 'pass' : ok === false ? 'fail' : 'not-run'),
    detail,
  });
  add('patch.allowlist', pipeline?.changedPaths?.length === 1 && pipeline.changedPaths[0] === SOURCE_PATH,
    pipeline ? `changed paths: ${(pipeline.changedPaths || []).join(', ') || 'none'}` : 'pipeline did not run');
  add('build', Boolean(pipeline?.hashes?.wasm), pipeline?.hashes?.wasm ? `built ${pipeline.hashes.wasm}` : 'no built WASM');
  add('fresh-replay', pipeline?.ok === true && (pipeline?.acceptanceErrors || []).length === 0,
    pipeline ? (pipeline.acceptanceErrors || []).join('; ') || 'fresh replay accepted' : 'pipeline did not run');
  add('persisted-recovery', Boolean(report), report ? `report ${report.schema || 'present'}` : 'no persisted report');
  add('persisted-acceptance', acceptance?.ok === true, acceptance?.errors?.join('; ') || (acceptance ? 'accepted' : 'acceptance did not run'));
  add('same-dao-mixed', mixedCheck ? mixedCheck.ok : null,
    mixedCheck ? (mixedCheck.ok ? 'Alice bond returned once; Bob liability, transfer and retries preserved' : mixedCheck.errors.join('; ')) : 'same-DAO gate did not run');
  add('failed-refund-settlement', settlementCheck ? settlementCheck.ok : null,
    settlementCheck ? (settlementCheck.ok ? 'failed refund retained debt; recreation retry paid once' : settlementCheck.errors.join('; ')) : 'settlement gate did not run');
  if (report) {
    add('failed-status', report.failed?.proposal?.status === 'Failed', `failed proposal status: ${report.failed?.proposal?.status || 'missing'}`);
    add('bond-recovered-once', asBigInt(report.firstRecovery?.grossRecoveryYocto) === 10n ** 24n,
      `gross recovery: ${formatYocto(report.firstRecovery?.grossRecoveryYocto)}`);
    add('retry-no-principal', asBigInt(report.secondRetry?.grossRecoveryYocto) === 0n,
      `retry gross: ${formatYocto(report.secondRetry?.grossRecoveryYocto)}`);
    add('healthy-obligations', report.healthyPreservation?.checks?.settledApproved === true
      && report.healthyPreservation?.checks?.pendingPayout === true
      && report.healthyPreservation?.checks?.pendingNoSecondPayout === true,
    'settled Transfer paid once; inherited pending Transfer preserved');
    add('state-policy-proposal', report.preservation?.state === true
      && report.preservation?.policy === true
      && report.preservation?.proposal === true,
    'state, policy and proposal preserved');
    add('authority', report.authority?.unauthorizedUpdateRejected === true
      && report.authority?.unauthorizedFinalizeRejected === true,
    'unauthorized update and finalize rejected');
  }
  return checks;
}

// A gate that ran and returned a verified failure is a rejection, not missing
// evidence. Only an unreported gate, with no verified failure elsewhere, leaves
// the outcome open.
function missingGateIsInconclusive({acceptanceOk, mixedCheck, settlementCheck}) {
  if (acceptanceOk !== true) return false;
  if (mixedCheck?.ok === false || settlementCheck?.ok === false) return false;
  return !mixedCheck || !settlementCheck;
}

function renderReport(review) {
  const lines = [
    `# Rehearsal patch review — ${review.status}`,
    '',
    review.status === 'ACCEPTED'
      ? '**ACCEPTED means the defined checks below passed for this pinned case. It does not mean the patch is universally safe, deployed, or live-DAO recovered.**'
      : review.status === 'REJECTED'
        ? '**REJECTED means a valid executable candidate failed a defined recovery or preservation check. It is not a judgment that the patch is malicious or that every possible case fails.**'
        : review.status === 'BUILD_ERROR'
          ? '**BUILD_ERROR means the candidate was accepted as input but did not compile. No economic recovery result was produced.**'
          : review.status === 'INPUT_ERROR'
            ? '**INPUT_ERROR means the patch, source checkout or caller input could not form a valid candidate. No economic recovery result was produced.**'
            : '**INCONCLUSIVE means a missing runtime or interrupted execution prevented a judgment. No success is implied.**',
    '',
    '## What was supplied',
    '',
    `- Repository label: ${review.supplied.repo || '(not supplied)'}`,
    `- Base label: ${review.supplied.base || '(not supplied)'}`,
    `- Head label: ${review.supplied.head || '(not supplied)'}`,
    `- Patch filename: ${review.supplied.patchFilename}`,
    '',
    'These labels are caller metadata. They are not verified provenance.',
    '',
    '## What was actually checked',
    '',
    `- Source commit read from the checkout: ${review.verified.sourceCommit || 'not checked'}`,
    `- Patch SHA-256: ${review.verified.patchSha256 || 'not checked'}`,
    `- Applied source SHA-256: ${review.verified.appliedSourceSha256 || 'not built'}`,
    `- Built WASM SHA-256: ${review.verified.builtWasmSha256 || 'not built'}`,
    `- Checker policy SHA-256: ${review.policy.policySha256}`,
    '',
    '## Money outcome',
    '',
    ...(review.summary ? [
      `- First recovery: ${review.summary.firstRecovery.gross} gross; ${review.summary.firstRecovery.gas} gas; proposer net ${review.summary.firstRecovery.proposerNet}; failed status preserved: ${review.summary.firstRecovery.endedFailed}`,
      `- Retry: ${review.summary.retry.gross} gross; ${review.summary.retry.gas} gas; proposer net ${review.summary.retry.proposerNet}; no extra principal: ${review.summary.retry.grossYocto === '0'}`,
      `- Healthy controls: settled Transfer ${review.summary.healthy.settledTransfer || 'not measured'}; inherited pending Transfer ${review.summary.healthy.pendingTransfer || 'not measured'}`,
    ] : ['- No accepted money result was produced. See the checks and evidence below.']),
    '',
    '## Same-DAO mixed obligation',
    '',
    ...(review.mixed ? [
      `- Policy result: **${review.mixed.ok ? 'pass' : 'fail'}**`,
      `- Alice paid exactly once: ${review.mixed.outcomes.alicePaid === true}`,
      `- Bob liability after Alice recovery: ${review.mixed.outcomes.bobLiabilityAfterAlice === true}`,
      `- Bob transfer paid: ${review.mixed.outcomes.bobTransferPaid === true}`,
      `- Bob settlement preserves payout and liability accounting: ${review.mixed.outcomes.bobPaidExactlyOnce === true}`,
      ...(review.mixed.errors || []).map((error) => `- Failure: ${error}`),
    ] : ['- Same-DAO mixed-obligation policy did not produce a verified report.']),
    '',
    '## Checks',
    '',
    ...review.checks.map((check) => `- **${check.status}** ${check.id}: ${check.detail}`),
    '',
    '## Reproduce',
    '',
    '```sh',
    'npm run review:patch -- --patch <same.diff> --source <clean-checkout-at-pinned-commit> --out <new-directory>',
    '```',
    '',
    `The pinned source commit is ${review.verified.sourceCommitPinned}. The submitted patch is bound by SHA-256 ${review.verified.patchSha256}.`,
    '',
    '## Evidence',
    '',
    `- Status: ${review.evidence.status}`,
    `- Report: ${review.evidence.report}`,
    `- Log and artifact directory: ${review.evidence.dir}`,
    '',
    '## Limitations',
    '',
    ...review.limitations.map((line) => `- ${line}`),
    '',
  ];
  return lines.join('\n');
}

function safeCopy(from, to) {
  if (!isFile(from)) return false;
  fs.mkdirSync(path.dirname(to), {recursive: true});
  fs.copyFileSync(from, to);
  return true;
}

function writeSums(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  const lines = files.sort().map((file) => `${sha256File(file)}  ${rel(dir, file)}`);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

function runReview(opts) {
  const patchPath = path.resolve(opts.patch);
  const sourceDir = path.resolve(opts.source);
  const outDir = path.resolve(opts.out);
  const baseReport = path.resolve(opts.baseReport || BASE_REPORT);
  const controller = JSON.parse(fs.readFileSync(CONTROLLER_MANIFEST, 'utf8'));
  const pinnedCommit = controller.source.commit;
  const supplied = {
    repo: opts.repo || null,
    base: opts.base || null,
    head: opts.head || null,
    patchFilename: path.basename(patchPath),
  };
  if (!isFile(patchPath)) throw new Error(`patch not found: ${patchPath}`);
  if (fs.statSync(patchPath).size > MAX_PATCH_BYTES) throw new Error(`patch exceeds ${MAX_PATCH_BYTES} bytes`);
  if (!isFile(baseReport)) throw new Error(`base report not found: ${baseReport}`);
  checkOutput(outDir);
  fs.mkdirSync(outDir, {recursive: true});
  const evidenceDir = path.join(outDir, 'evidence');
  fs.mkdirSync(evidenceDir, {recursive: true});
  fs.writeFileSync(path.join(outDir, 'supplied.json'), json(supplied));
  fs.copyFileSync(patchPath, path.join(evidenceDir, 'candidate.patch'));

  const policy = policyIdentity(baseReport);
  const verified = {
    sourceCommit: null,
    appliedSourceSha256: null,
    patchSha256: sha256File(patchPath),
    builtWasmSha256: null,
    sourceClean: null,
  };
  const evidence = {status: 'review-status.json', report: 'review-report.md', dir: 'evidence/'};
  const limitations = [
    'Local NEAR Sandbox 2.14 only; no public write, deployment, production upgrade or live-DAO recovery.',
    'The supported case is pinned to one Sputnik revision and one failed async FunctionCall obligation.',
    'Caller-supplied repository/base/head labels are recorded, not verified.',
    'The report is evidence, not a signature and not a GitHub-enforced merge restriction.',
    'A rejected or incomplete run is preserved but is not an accepted replay bundle.',
    'The same-DAO mixed-obligation gate is a local Sandbox scenario; it is not a live DAO migration or proof that other obligations are safe.',
    'Source builds run as trusted local host execution: build scripts can read host files and credentials. This is not compiler isolation or an untrusted-code sandbox.',
  ];

  let status = 'INCONCLUSIVE';
  let reason = 'No terminal result was produced.';
  let pipeline = null;
  let report = null;
  let acceptance = null;
  let mixed = null;
  let mixedCheck = null;
  let settlementCheck = null;
  let acceptanceVerdict = null;
  let summary = null;
  let checks = [];

  try {
    verified.sourceCommit = checkSource(sourceDir, pinnedCommit);
    verified.sourceClean = true;
  } catch (error) {
    const result = classify('input', {inputError: error.message});
    status = result.status;
    reason = result.reason;
    checks = [{id: 'source-checkout', status: 'fail', detail: error.message}];
  }

  if (status === 'INCONCLUSIVE') {
    const sandboxDir = path.resolve(opts.sandboxDir || sandboxFromEnvironment() || '');
    if (!sandboxDir || !isFile(path.join(sandboxDir, 'near-sandbox'))) {
      const result = classify('runtime', {inconclusive: 'pinned near-sandbox binary was not found'});
      status = result.status;
      reason = result.reason;
      checks = [{id: 'sandbox-runtime', status: 'error', detail: result.reason}];
    } else {
      const pipelineDir = path.join(outDir, 'pipeline');
      const pipelineResult = runNode([
        PIPELINE,
        '--patch', patchPath,
        '--source', sourceDir,
        '--out', pipelineDir,
        '--base-report', baseReport,
        '--sandbox-dir', sandboxDir,
      ], {timeout: PIPELINE_TIMEOUT_MS});
      writeLog(path.join(evidenceDir, 'pipeline.log'), pipelineResult);
      safeCopy(path.join(pipelineDir, 'build.log'), path.join(evidenceDir, 'build.log'));
      safeCopy(path.join(pipelineDir, 'replay.log'), path.join(evidenceDir, 'replay.log'));
      safeCopy(path.join(pipelineDir, 'pipeline.json'), path.join(evidenceDir, 'pipeline.json'));
      safeCopy(path.join(pipelineDir, 'candidate-identity.json'), path.join(evidenceDir, 'candidate-identity.json'));
      pipeline = readJson(path.join(pipelineDir, 'pipeline.json'));

      if (!pipeline) {
        const errText = `${pipelineResult.stderr || ''}\n${pipelineResult.stdout || ''}`;
        if (/patch guard rejected|unknown argument|patch .*not found|no hunks|not a valid/i.test(errText)) {
          const result = classify('input', {inputError: 'patch did not form a valid allowlisted candidate'});
          status = result.status;
          reason = result.reason;
          checks = [{id: 'patch-input', status: 'fail', detail: result.reason}];
        } else {
          const buildLogPath = path.join(pipelineDir, 'build.log');
          const replayReportPath = path.join(pipelineDir, 'replay', 'issue238-local.json');
          const verdict = classifyPipelineResult({
            pipeline: null,
            buildLogText: isFile(buildLogPath) ? fs.readFileSync(buildLogPath, 'utf8') : '',
            replayReportExists: isFile(replayReportPath),
          });
          if (verdict.kind === 'buildError') {
            const result = classify('build', {buildError: verdict.reason});
            status = result.status;
            reason = result.reason;
            checks = [{id: 'build', status: 'fail', detail: result.reason}];
          } else if (verdict.kind === 'rejected') {
            const result = classify('replay', {rejected: verdict.reason});
            status = result.status;
            reason = result.reason;
            checks = [{id: 'fresh-replay', status: 'fail', detail: result.reason}];
          } else {
            const result = classify('pipeline', {inconclusive: verdict.reason});
            status = result.status;
            reason = result.reason;
            checks = [{id: 'pipeline', status: 'error', detail: result.reason}];
          }
        }
      } else {
        verified.builtWasmSha256 = pipeline.hashes?.wasm || null;
        verified.appliedSourceSha256 = pipeline.hashes?.appliedSource || null;
        const wasmPath = path.join(pipelineDir, 'applied', 'target', 'wasm32-unknown-unknown', 'release', 'sputnikdao2.wasm');
        const appliedSource = path.join(pipelineDir, 'applied', SOURCE_PATH);
        const identityPath = path.join(pipelineDir, 'candidate-identity.json');
        if (!isFile(wasmPath) || !isFile(appliedSource) || !isFile(identityPath)) {
          const result = classify('build', {buildError: 'build produced no complete candidate artifact set'});
          status = result.status;
          reason = result.reason;
          checks = [{id: 'build-artifacts', status: 'fail', detail: result.reason}];
        } else {
          const persistedDir = path.join(outDir, 'persisted');
          const persistedResult = runNode([
            PERSISTED,
            '--candidate-wasm', wasmPath,
            '--candidate-patch', patchPath,
            '--candidate-identity', identityPath,
            '--candidate-source', appliedSource,
            '--out', persistedDir,
            '--sandbox-dir', sandboxDir,
            '--expected-wasm-sha256', verified.builtWasmSha256,
          ], {timeout: PERSISTED_TIMEOUT_MS});
          writeLog(path.join(evidenceDir, 'persisted.log'), persistedResult);
          safeCopy(path.join(persistedDir, 'persisted-recovery.json'), path.join(evidenceDir, 'persisted-recovery.json'));
          report = readJson(path.join(persistedDir, 'persisted-recovery.json'));
          if (!report) {
            const result = classify('persisted', {inconclusive: `persisted recovery produced no report: ${(persistedResult.stderr || '').trim().slice(0, 500) || 'no output'}`});
            status = pipeline.ok === false ? 'REJECTED' : result.status;
            reason = pipeline.ok === false
              ? `fresh-state acceptance failed: ${(pipeline.acceptanceErrors || []).join('; ') || 'pipeline did not pass'}`
              : result.reason;
            checks = [
              ...(pipeline.ok === false ? [{id: 'fresh-replay', status: 'fail', detail: reason}] : []),
              {id: 'persisted-recovery', status: 'error', detail: result.reason},
            ];
          } else {
            const acceptanceArgs = [
              PERSISTED_ACCEPTANCE,
              '--report', path.join(persistedDir, 'persisted-recovery.json'),
              '--wasm', wasmPath,
              '--base-wasm', BASE_WASM,
              '--patch', patchPath,
              '--source', appliedSource,
              '--expected-wasm-sha256', verified.builtWasmSha256,
              '--expected-patch-sha256', verified.patchSha256,
            ];
            const expectedSource = verified.appliedSourceSha256 || pipeline.identity?.source?.sha256;
            if (expectedSource) acceptanceArgs.push('--expected-source-sha256', expectedSource);
            const acceptanceResult = runNode(acceptanceArgs, {timeout: ACCEPTANCE_TIMEOUT_MS});
            writeLog(path.join(evidenceDir, 'acceptance.log'), acceptanceResult);
            try { acceptance = JSON.parse(acceptanceResult.stdout); } catch { acceptance = null; }
            if (acceptance) fs.writeFileSync(path.join(persistedDir, 'persisted-recovery-acceptance.json'), json(acceptance));
            if (!acceptance) {
              const result = classify('acceptance', {inconclusive: 'persisted acceptance produced no readable JSON'});
              status = result.status;
              reason = result.reason;
              checks = [{id: 'persisted-acceptance', status: 'error', detail: result.reason}];
            } else {
              safeCopy(path.join(persistedDir, 'persisted-recovery-acceptance.json'), path.join(evidenceDir, 'persisted-recovery-acceptance.json'));
              summary = reportSummary(report, acceptance, {mode: 'source-build'});
              if (acceptance.ok === true) {
                const mixedDir = path.join(outDir, 'mixed');
                const mixedResult = runNode([
                  MIXED,
                  '--candidate-wasm', wasmPath,
                  '--out', mixedDir,
                  '--sandbox-dir', sandboxDir,
                ], {timeout: MIXED_TIMEOUT_MS});
                writeLog(path.join(evidenceDir, 'mixed.log'), mixedResult);
                safeCopy(path.join(mixedDir, 'mixed-obligation.json'), path.join(evidenceDir, 'mixed-obligation.json'));
                mixed = readJson(path.join(mixedDir, 'mixed-obligation.json'));
                if (mixed) mixedCheck = verifyMixedReport(mixed, {requireBlockPinned: true});
                if (mixedCheck?.ok) {
                  const settlementDir = path.join(outDir, 'settlement');
                  const settlementResult = runNode([
                    SETTLEMENT,
                    '--candidate-wasm', wasmPath,
                    '--base-wasm', BASE_WASM,
                    '--out', settlementDir,
                  ], {timeout: SETTLEMENT_TIMEOUT_MS, env: sandboxDir ? {NEAR_SANDBOX_BIN_PATH: sandboxDir, NEAR_SANDBOX_BINARY_PATH: sandboxDir} : {}});
                  writeLog(path.join(evidenceDir, 'settlement.log'), settlementResult);
                  safeCopy(path.join(settlementDir, 'settlement-refund.json'), path.join(evidenceDir, 'settlement-refund.json'));
                  const settlement = readJson(path.join(settlementDir, 'settlement-refund.json'));
                  if (settlement) settlementCheck = verifySettlementReport(settlement, {candidateWasmSha256: verified.builtWasmSha256, baseWasmSha256: sha256File(BASE_WASM)});
                }
              }
              // A gate that ran and returned a verified failure is a rejection, not a
              // missing-evidence result. Only an unreported gate leaves the outcome open.
              if (missingGateIsInconclusive({acceptanceOk: true, mixedCheck, settlementCheck})) {
                status = 'INCONCLUSIVE';
                reason = 'same-DAO mixed-obligation or failed-refund settlement gate produced no verified report';
                checks = [
                  {id: 'persisted-acceptance', status: 'pass', detail: 'persisted acceptance passed'},
                  {id: 'same-dao-mixed', status: mixedCheck ? 'pass' : 'error', detail: mixedCheck ? 'mixed gate passed' : 'mixed gate missing'},
                  {id: 'failed-refund-settlement', status: settlementCheck ? 'pass' : 'error', detail: settlementCheck ? 'settlement gate passed' : 'settlement gate missing'},
                ];
              } else {
                checks = checksFrom(pipeline, report, acceptance, mixedCheck, settlementCheck);
                const verdict = evaluateCandidate({
                  fresh: stageFromChecks(pipeline.ok === true && (pipeline.acceptanceErrors || []).length === 0, pipeline.acceptanceErrors || [], {evidenceValid: Boolean(pipeline)}),
                  recovery: stageFromChecks(acceptance.ok === true, acceptance.errors || [], {evidenceValid: Boolean(acceptance)}),
                  mixed: stageFromChecks(mixedCheck?.ok === true, mixedCheck?.errors || [], {policyVersion: POLICY_VERSION, evidenceValid: Boolean(mixedCheck)}),
                  settlement: stageFromChecks(settlementCheck?.ok === true, settlementCheck?.errors || [], {evidenceValid: Boolean(settlementCheck)}),
                });
                acceptanceVerdict = verdict;
                if (verdict.status === 'REJECTED') {
                  status = 'REJECTED';
                  reason = `versioned acceptance policy ${verdict.policyVersion} failed: ${verdict.errors.join('; ')}`;
                } else if (verdict.status === 'INCONCLUSIVE') {
                  status = 'INCONCLUSIVE';
                  reason = `versioned acceptance policy ${verdict.policyVersion} was inconclusive: ${verdict.errors.join('; ')}`;
                } else {
                  status = 'ACCEPTED';
                  reason = `All policy ${verdict.policyVersion} source, build, replay, recovery, same-DAO and preservation checks passed.`;
                }
              }
            }
          }
        }
      }
    }
  }

  const review = {
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    status,
    reason,
    supplied,
    verified: {
      ...verified,
      sourceRepository: controller.source.repository,
      sourceCommitPinned: pinnedCommit,
      sourcePath: SOURCE_PATH,
      patchSha256: verified.patchSha256,
      builtWasmSha256: verified.builtWasmSha256,
      appliedSourceSha256: verified.appliedSourceSha256,
    },
    policy,
    acceptancePolicy: acceptanceVerdict,
    checks,
    summary,
    mixed: mixedCheck ? {ok: mixedCheck.ok, errors: mixedCheck.errors, outcomes: mixedCheck.outcomes} : null,
    settlement: settlementCheck ? {ok: settlementCheck.ok, errors: settlementCheck.errors, outcomes: settlementCheck.outcomes} : null,
    evidence,
    limitations,
    boundary: 'Local Sandbox evidence for the pinned Sputnik #238 case. No live DAO recovery, deployment, audit, universal safety claim, signature or merge enforcement.',
  };
  const statusPath = path.join(outDir, 'review-status.json');
  fs.writeFileSync(statusPath, json(review));
  if (status === 'REJECTED' || status === 'INPUT_ERROR' || status === 'BUILD_ERROR') {
    fs.writeFileSync(path.join(outDir, 'rejected-evidence.json'), json({schema: `${SCHEMA}/rejected`, status, reason, evidence: review.evidence}));
  }
  if (status !== 'ACCEPTED') {
    fs.writeFileSync(path.join(outDir, 'review-evidence.json'), json({schema: `${SCHEMA}/evidence`, status, reason, evidence: review.evidence}));
  } else {
    fs.writeFileSync(path.join(outDir, 'recovery-packet.json'), json({schema: `${SCHEMA}/accepted`, status, review}));
  }
  const reportPath = path.join(outDir, 'review-report.md');
  fs.writeFileSync(reportPath, renderReport(review));
  // Recompute after all evidence files are present.
  writeSums(outDir);
  console.log(renderReport(review));
  console.log(`Status: ${status}`);
  console.log(`Report: ${reportPath}`);
  return review;
}

const REVIEW_EXIT_CODES = Object.freeze({ACCEPTED: 0, REJECTED: 2, INPUT_ERROR: 3, BUILD_ERROR: 4, INCONCLUSIVE: 5});
function exitCodeForStatus(status) { return REVIEW_EXIT_CODES[status] ?? 1; }

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) console.log(usage());
    else process.exitCode = exitCodeForStatus(runReview(opts).status);
  } catch (error) {
    console.error(`review-patch: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {exitCodeForStatus, REVIEW_EXIT_CODES, parseArgs, classify, classifyPipelineResult, policyIdentity, runReview, renderReport, checkSource, checksFrom, missingGateIsInconclusive, sandboxFromEnvironment};
