'use strict';
// Operator-facing handoff for the #238 persisted-bond repair.
//
// This is the stable entry point used by a fresh copy of the repository:
//   npm run repair:review -- --bundle <export.json> --out <fresh-dir> \
//     --source <sputnik-dao-contract checkout> --sandbox-dir <bin-dir>
//
// Default mode rebuilds the supplied patch from the exact upstream commit and
// runs it through the persisted-recovery acceptance. `--mode recorded-wasm`
// replays the supplied candidate bytes instead, which is useful when no Rust
// toolchain is available. The two modes are deliberately labelled differently.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PIPELINE = path.join(ROOT, 'case-triage', 'rehearsal-repair', 'repair-pipeline.cjs');
const RECOVERY = path.join(ROOT, 'case-triage', 'rehearsal-repair', 'persisted-recovery.cjs');
const ACCEPTANCE = path.join(ROOT, 'case-triage', 'rehearsal-repair', 'persisted-recovery-acceptance.cjs');
const BASE_WASM = path.join(ROOT, 'case-triage', 'rehearsal-repair', 'bundle', 'artifacts', 'base.wasm');
const BASE_WASM_SHA = '5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578';
const SANDBOX_COMMIT = 'bc4e9e8cfb03d9e82f027883055624e18576993e';
const SANDBOX_VERSION = '2.14.0';
const SCHEMA = 'near-rehearsal/repair-review-bundle/v1';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hex = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const fail = (message) => { throw new Error(message); };
const readJson = (file, label) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} is not readable JSON: ${error.message}`);
  }
};
const requireFile = (file, label) => {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`${label} not found: ${file || '(missing)'}`);
  return path.resolve(file);
};
const requireDir = (dir, label) => {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`${label} not found: ${dir || '(missing)'}`);
  return path.resolve(dir);
};
const same = (a, b) => String(a ?? '') === String(b ?? '');
const parseArgs = (argv) => {
  const opts = {
    mode: 'source-build',
    bundle: null,
    out: null,
    source: null,
    sandboxDir: null,
    baseWasm: BASE_WASM,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--bundle') opts.bundle = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--source') opts.source = argv[++i];
    else if (arg === '--sandbox-dir') opts.sandboxDir = argv[++i];
    else if (arg === '--base-wasm') opts.baseWasm = argv[++i];
    else if (arg === '--mode') opts.mode = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else fail(`unknown argument: ${arg}`);
  }
  return opts;
};
const help = `Usage:
  npm run repair:review -- --bundle <export.json> --out <fresh-dir> --source <checkout> [--sandbox-dir <bin-dir>]
  npm run repair:review -- --bundle <export.json> --out <fresh-dir> --mode recorded-wasm [--sandbox-dir <bin-dir>]

Modes:
  source-build   (default) Apply the exported patch to an exact upstream checkout,
                 build it with Rust 1.86 + wasm32, then run persisted recovery.
  recorded-wasm  Replay the exported candidate WASM without rebuilding.

The output directory must be new. The command verifies every supplied hash before
writing or running anything. It does not merge, publish or update external state.`;

const checkBundle = (bundle) => {
  if (!bundle || bundle.schema !== SCHEMA) fail(`bundle schema must be ${SCHEMA}`);
  if (!bundle.runId) fail('bundle runId is missing');
  if (bundle.caseId !== 'sputnik-238-async-bond') fail('bundle caseId is not sputnik-238-async-bond');
  if (!bundle.source?.repository || !bundle.source?.commit) fail('bundle source identity is incomplete');
  if (bundle.build?.rust !== '1.86.0' || bundle.build?.target !== 'wasm32-unknown-unknown') {
    fail('bundle build must declare Rust 1.86.0 and wasm32-unknown-unknown');
  }
  const patchText = bundle.candidate?.patch?.text;
  if (typeof patchText !== 'string' || !patchText.trim()) fail('bundle candidate patch text is missing');
  if (sha256(Buffer.from(patchText, 'utf8')) !== bundle.candidate.patch.sha256) fail('bundle candidate patch hash does not match its text');
  if (!hex(bundle.candidate.patch.sha256)) fail('bundle candidate patch hash is invalid');
  if (typeof bundle.candidate.wasm?.base64 !== 'string') fail('bundle candidate WASM is missing');
  const wasm = Buffer.from(bundle.candidate.wasm.base64, 'base64');
  if (!wasm.length) fail('bundle candidate WASM is empty');
  if (sha256(wasm) !== bundle.candidate.wasm.sha256) fail('bundle candidate WASM hash does not match its bytes');
  if (!Number.isFinite(bundle.candidate.wasm.bytes) || bundle.candidate.wasm.bytes !== wasm.length) fail('bundle candidate WASM length does not match');
  for (const [label, value] of [['baseline report', bundle.baseline?.reportText], ['recovery report', bundle.recovery?.reportText]]) {
    if (typeof value !== 'string' || !value.trim()) fail(`bundle ${label} is missing`);
  }
  if (sha256(Buffer.from(bundle.baseline.reportText, 'utf8')) !== bundle.baseline.reportSha256) fail('bundle baseline report hash does not match its text');
  if (sha256(Buffer.from(bundle.recovery.reportText, 'utf8')) !== bundle.recovery.reportSha256) fail('bundle recovery report hash does not match its text');
  if (bundle.recovery?.acceptance?.ok !== true) fail('bundle recovery acceptance is not recorded as passing');
  if (bundle.recovery.acceptance.candidateWasmSha256 !== bundle.candidate.wasm.sha256) fail('bundle acceptance is for a different candidate WASM');
  if (bundle.recovery?.candidateWasmSha256 && bundle.recovery.candidateWasmSha256 !== bundle.candidate.wasm.sha256) fail('bundle recovery candidate hash does not match');
  if (bundle.candidate.patch.sha256 !== bundle.recovery?.artifacts?.patch?.sha256) fail('bundle recovery patch artifact does not match the candidate patch');
  if (bundle.candidate.wasm.sha256 !== bundle.recovery?.artifacts?.wasm?.sha256) fail('bundle recovery WASM artifact does not match the candidate WASM');
  if (!bundledIdentityMatches(bundle)) fail('bundle candidate identity is internally inconsistent');
  if (bundle.candidate.identityText && bundle.candidate.identitySha256
      && sha256(Buffer.from(bundle.candidate.identityText, 'utf8')) !== bundle.candidate.identitySha256) {
    fail('bundle candidate identity text hash does not match');
  }
  if (bundle.recovery.identityText && bundle.recovery.identitySha256
      && sha256(Buffer.from(bundle.recovery.identityText, 'utf8')) !== bundle.recovery.identitySha256) {
    fail('bundle recovery identity text hash does not match');
  }
  const sourceIdentity = bundle.candidate.source || bundle.recovery?.artifacts?.source || bundle.candidate.identity?.source;
  if (!sourceIdentity?.path || !hex(sourceIdentity.sha256)) fail('bundle candidate source identity is incomplete');
  return { patchText, wasm, sourceIdentity };
};

const bundledIdentityMatches = (bundle) => {
  const identity = bundle.candidate?.identity;
  if (!identity) return true;
  if (identity.patch?.sha256 && identity.patch.sha256 !== bundle.candidate.patch.sha256) return false;
  if (identity.wasm?.sha256 && identity.wasm.sha256 !== bundle.candidate.wasm.sha256) return false;
  const source = bundle.candidate.source || bundle.recovery?.artifacts?.source || bundle.candidate.identity?.source;
  if (identity.source?.sha256 && identity.source.sha256 !== source?.sha256) return false;
  if (identity.source?.commit && identity.source.commit !== bundle.source.commit) return false;
  return true;
};

const prepare = (bundle, outDir) => {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  if (fs.readdirSync(outDir).length) fail(`output directory is not empty: ${outDir}`);
  const inputDir = path.join(outDir, 'input');
  fs.mkdirSync(inputDir);
  const patchPath = path.join(inputDir, 'repair.patch');
  const wasmPath = path.join(inputDir, 'candidate.wasm');
  const baselinePath = path.join(inputDir, 'baseline-report.json');
  const recordedRecoveryPath = path.join(inputDir, 'recorded-recovery.json');
  fs.writeFileSync(patchPath, bundle.candidate.patch.text);
  fs.writeFileSync(wasmPath, Buffer.from(bundle.candidate.wasm.base64, 'base64'));
  fs.writeFileSync(baselinePath, bundle.baseline.reportText);
  fs.writeFileSync(recordedRecoveryPath, bundle.recovery.reportText);
  return { inputDir, patchPath, wasmPath, baselinePath, recordedRecoveryPath, sourceIdentity: bundle._sourceIdentity };
};

const requireCommand = (args, label) => {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${label} failed (exit ${result.status}):\n${detail.slice(-4000)}`);
  }
  return result;
};

const baseWasm = (opts) => {
  const candidate = requireFile(opts.baseWasm, 'base WASM');
  const bytes = fs.readFileSync(candidate);
  if (sha256(bytes) !== BASE_WASM_SHA) fail(`base WASM hash mismatch: expected ${BASE_WASM_SHA}, got ${sha256(bytes)}`);
  return candidate;
};

const runPersisted = (candidateWasm, outDir, patchPath, sourcePath, identityPath, sandboxDir) => {
  const args = [
    RECOVERY,
    '--candidate-wasm', candidateWasm,
    '--out', outDir,
    '--candidate-patch', patchPath,
    '--candidate-identity', identityPath,
    '--sandbox-dir', sandboxDir,
  ];
  if (sourcePath) args.push('--candidate-source', sourcePath);
  requireCommand(args, 'persisted recovery');
  return path.join(outDir, 'persisted-recovery.json');
};

const runAcceptance = (reportPath, wasmPath, basePath, patchPath, sourcePath, expected, sandboxDir) => {
  const args = [
    ACCEPTANCE,
    '--report', reportPath,
    '--wasm', wasmPath,
    '--base-wasm', basePath,
    '--patch', patchPath,
  ];
  if (sourcePath) args.push('--source', sourcePath);
  if (expected?.wasm) args.push('--expected-wasm-sha256', expected.wasm);
  if (expected?.patch) args.push('--expected-patch-sha256', expected.patch);
  if (expected?.source) args.push('--expected-source-sha256', expected.source);
  const result = requireCommand(args, 'persisted recovery acceptance');
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { fail('acceptance did not return JSON'); }
  if (parsed.ok !== true) fail(`persisted recovery acceptance failed: ${(parsed.errors || []).join('; ')}`);
  const acceptancePath = path.join(path.dirname(reportPath), 'persisted-recovery-acceptance.json');
  fs.writeFileSync(acceptancePath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { acceptance: parsed, acceptancePath };
};

const sourceHead = (sourceDir) => {
  const result = spawnSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) fail(`source checkout is not a readable Git worktree: ${sourceDir}`);
  const dirty = spawnSync('git', ['-C', sourceDir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', timeout: 30000 });
  if (dirty.status !== 0) fail(`could not inspect source checkout status: ${sourceDir}`);
  if (dirty.stdout.trim()) fail(`source checkout has tracked modifications; use a clean checkout: ${sourceDir}`);
  return result.stdout.trim();
};

const runSourceBuild = (bundle, prepared, outDir, opts) => {
  const sourceIdentity = prepared.sourceIdentity;
  if (!opts.source) fail('--source is required for source-build mode');
  const sourceDir = requireDir(opts.source, 'source checkout');
  if (sourceHead(sourceDir) !== bundle.source.commit) {
    fail(`source checkout HEAD ${sourceHead(sourceDir)} does not match bundle commit ${bundle.source.commit}`);
  }
  const sandboxDir = requireDir(opts.sandboxDir || '', 'Sandbox binary directory');
  const buildDir = path.join(outDir, 'source-build');
  const pipeline = [
    PIPELINE,
    '--patch', prepared.patchPath,
    '--source', sourceDir,
    '--out', buildDir,
    '--base-report', prepared.baselinePath,
    '--sandbox-dir', sandboxDir,
  ];
  requireCommand(pipeline, 'source build and fresh-state replay');
  const pipelinePath = path.join(buildDir, 'pipeline.json');
  const pipelineReport = readJson(pipelinePath, 'source-build pipeline report');
  if (pipelineReport.ok !== true) fail('source-build pipeline did not pass');
  if (pipelineReport.hashes?.patch !== bundle.candidate.patch.sha256) fail('source-build pipeline patch hash does not match the bundle');
  if (pipelineReport.hashes?.appliedSource !== sourceIdentity.sha256) fail('source-build applied source does not match the candidate identity');
  const builtWasm = path.join(buildDir, 'applied', 'target', 'wasm32-unknown-unknown', 'release', 'sputnikdao2.wasm');
  requireFile(builtWasm, 'newly built candidate WASM');
  if (sha256(fs.readFileSync(builtWasm)) !== pipelineReport.hashes?.wasm) fail('newly built WASM does not match the pipeline report');
  const identityPath = path.join(buildDir, 'candidate-identity.json');
  const identity = readJson(identityPath, 'new build identity');
  if (identity.wasm.sha256 !== pipelineReport.hashes.wasm) fail('new build identity WASM hash mismatch');
  const persistedDir = path.join(buildDir, 'persisted');
  const reportPath = runPersisted(
    builtWasm,
    persistedDir,
    prepared.patchPath,
    path.join(buildDir, 'applied', 'sputnikdao2', 'src', 'proposals.rs'),
    identityPath,
    sandboxDir,
  );
  const checked = runAcceptance(
    reportPath,
    builtWasm,
    baseWasm(opts),
    prepared.patchPath,
    path.join(buildDir, 'applied', 'sputnikdao2', 'src', 'proposals.rs'),
    { patch: bundle.candidate.patch.sha256, source: sourceIdentity.sha256 },
    sandboxDir,
  );
  return {
    mode: 'source-build',
    modeLabel: 'source build (new Rust 1.86 WASM; distinct from the recorded artifact)',
    sourceDir,
    sourceHead: sourceHead(sourceDir),
    buildDir,
    pipelinePath,
    pipelineReport,
    identityPath,
    identity,
    builtWasm,
    builtWasmSha256: pipelineReport.hashes.wasm,
    reportPath,
    ...checked,
  };
};

const runRecorded = (bundle, prepared, outDir, opts) => {
  const sourceIdentity = prepared.sourceIdentity;
  const sandboxDir = requireDir(opts.sandboxDir || '', 'Sandbox binary directory');
  const replayDir = path.join(outDir, 'recorded-replay');
  const identityPath = path.join(prepared.inputDir, 'candidate-identity.json');
  const identity = {
    schema: 'near-rehearsal/repair-candidate-identity/v1',
    source: { ...bundle.source, path: sourceIdentity.path, sha256: sourceIdentity.sha256 },
    patch: { filename: 'repair.patch', sha256: bundle.candidate.patch.sha256, bytes: bundle.candidate.patch.bytes },
    wasm: { filename: 'candidate.wasm', sha256: bundle.candidate.wasm.sha256, bytes: bundle.candidate.wasm.bytes },
  };
  fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
  // The recorded recovery has no applied-source file; acceptance checks the
  // recorded source identity and the supplied patch instead of inventing one.
  const reportPath = runPersisted(
    prepared.wasmPath,
    replayDir,
    prepared.patchPath,
    null,
    identityPath,
    sandboxDir,
  );
  const checked = runAcceptance(
    reportPath,
    prepared.wasmPath,
    baseWasm(opts),
    prepared.patchPath,
    null,
    {
      wasm: bundle.candidate.wasm.sha256,
      patch: bundle.candidate.patch.sha256,
      source: sourceIdentity.sha256,
    },
    sandboxDir,
  );
  return {
    mode: 'recorded-wasm',
    modeLabel: 'recorded WASM replay (supplied artifact; no source build)',
    replayDir,
    identityPath,
    identity,
    wasmPath: prepared.wasmPath,
    wasmSha256: bundle.candidate.wasm.sha256,
    reportPath,
    ...checked,
  };
};

const yoctoNear = (value) => {
  try {
    const n = BigInt(value);
    const whole = n / 1000000000000000000000000n;
    const fraction = (n % 1000000000000000000000000n).toString().padStart(24, '0').replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''} NEAR`;
  } catch {
    return String(value ?? 'n/a');
  }
};

const summarize = (report, run) => {
  const first = report.firstRecovery || {};
  const second = report.secondRetry || {};
  const healthy = report.healthyPreservation?.checks || {};
  const gas = first.gasBurntYocto ?? first.gasYocto;
  const secondGas = second.gasBurntYocto ?? second.gasYocto;
  const gross = first.grossRecoveryYocto;
  const secondGross = second.grossRecoveryYocto;
  return {
    mode: run.mode,
    modeLabel: run.modeLabel,
    candidateWasmSha256: report.candidate?.wasmSha256,
    sourceCommit: report.source?.commit,
    frozenOldCodeFailure: report.failed?.proposal?.status === 'Failed' && report.failed?.frozen?.proposal?.status === 'Failed',
    firstRecovery: {
      gross: yoctoNear(gross),
      grossYocto: String(gross ?? ''),
      gas: yoctoNear(gas),
      gasYocto: String(gas ?? ''),
      endedFailed: first.endedFailed === true,
    },
    retry: {
      gross: yoctoNear(secondGross),
      grossYocto: String(secondGross ?? ''),
      gas: yoctoNear(secondGas),
      gasYocto: String(secondGas ?? ''),
      endedFailed: second.endedFailed === true,
    },
    checks: {
      preservedState: report.preservation?.state === true,
      preservedPolicy: report.preservation?.policy === true,
      preservedProposal: report.preservation?.proposal === true,
      authorityRejected: report.authority?.unauthorizedUpdateRejected === true
        && report.authority?.unauthorizedFinalizeRejected === true,
      healthyControl: healthy.settledApproved === true && healthy.settledPayout === '100000000000000000000000',
      pendingHealthy: healthy.pendingNoSecondPayout === true && healthy.pendingPayout === true,
      accepted: run.acceptance?.ok === true,
    },
  };
};

const render = (result) => {
  const s = result.summary;
  return [
    `REHEARSAL HANDOFF PASS — ${s.modeLabel}`,
    '',
    `Source: ${result.bundle.source.repository} @ ${result.bundle.source.commit}`,
    `Candidate WASM: ${s.candidateWasmSha256}`,
    result.run.mode === 'source-build' ? `Built from patch: ${result.run.builtWasmSha256}` : `Recorded artifact: ${result.run.wasmSha256}`,
    '',
    `Frozen old-code failure: ${s.frozenOldCodeFailure ? 'yes' : 'NO'}`,
    `First deliberate operation: recovered ${s.firstRecovery.gross} gross, ${s.firstRecovery.gas} gas, ended ${s.firstRecovery.endedFailed}`,
    `Retry: ${s.retry.gross} gross, ${s.retry.gas} gas — no extra principal`,
    `Preserved inherited state/policy/proposal: ${s.checks.preservedState}/${s.checks.preservedPolicy}/${s.checks.preservedProposal}`,
    `Unauthorized update/finalize rejected: ${s.checks.authorityRejected ? 'yes' : 'NO'}`,
    `Healthy controls (already-paid + pending Transfer): ${s.checks.healthyControl}/${s.checks.pendingHealthy}`,
    '',
    `Acceptance: ${s.checks.accepted ? 'pass' : 'FAIL'}`,
    `Result: ${result.resultPath}`,
    `Report: ${result.run.reportPath}`,
    `Acceptance receipt: ${result.run.acceptancePath}`,
  ].join('\n');
};

const main = () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(help); return; }
  if (!opts.bundle) fail('--bundle is required');
  if (!opts.out) fail('--out is required');
  const bundlePath = requireFile(opts.bundle, 'bundle');
  const bundle = readJson(bundlePath, 'bundle');
  const { sourceIdentity } = checkBundle(bundle);
  const outDir = path.resolve(opts.out);
  bundle._sourceIdentity = sourceIdentity;
  const prepared = prepare(bundle, outDir);
  if (opts.mode !== 'source-build' && opts.mode !== 'recorded-wasm') fail(`unknown mode: ${opts.mode}`);
  const run = opts.mode === 'source-build'
    ? runSourceBuild(bundle, prepared, outDir, opts)
    : runRecorded(bundle, prepared, outDir, opts);
  const report = readJson(run.reportPath, 'persisted recovery report');
  const summary = summarize(report, run);
  if (!summary.checks.accepted) fail('persisted recovery report did not pass acceptance');
  const resultPath = path.join(outDir, 'review-result.json');
  const result = {
    schema: 'near-rehearsal/repair-review-handoff/v1',
    createdAt: new Date().toISOString(),
    bundle: {
      path: bundlePath,
      sha256: sha256(fs.readFileSync(bundlePath)),
      runId: bundle.runId,
      caseId: bundle.caseId,
      source: bundle.source,
      candidate: {
        patchSha256: bundle.candidate.patch.sha256,
        wasmSha256: bundle.candidate.wasm.sha256,
        sourceSha256: prepared.sourceIdentity.sha256,
      },
    },
    run,
    summary,
    resultPath,
    boundary: 'Local NEAR Sandbox 2.14 only. No public write, deployment, production upgrade, or claim about other cases.',
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(render(result));
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`repair-review: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { checkBundle, yoctoNear, summarize };
