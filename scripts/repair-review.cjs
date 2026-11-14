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
const MIXED = path.join(ROOT, 'case-triage', 'rehearsal-repair', 'mixed-obligation.cjs');
const SETTLEMENT = path.join(ROOT, 'case-triage', 'rehearsal-repair', 'settlement-refund-tests.cjs');
const {verifyMixedReport} = require(path.join(ROOT, 'case-triage', 'rehearsal-repair', 'mixed-policy.cjs'));
const {verifySettlementReport} = require(path.join(ROOT, 'case-triage', 'rehearsal-repair', 'settlement-policy.cjs'));
const {mixedPolicyIdentity} = require(path.join(ROOT, 'case-triage', 'rehearsal-repair', 'mixed-policy-identity.cjs'));
const {POLICY_VERSION, evaluateCandidate, stageFromChecks} = require(path.join(ROOT, 'case-triage', 'rehearsal-repair', 'acceptance-orchestrator.cjs'));
const BASE_WASM_SHA = '5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578';
const SANDBOX_COMMIT = 'bc4e9e8cfb03d9e82f027883055624e18576993e';
const SANDBOX_VERSION = '2.14.0';
const SCHEMA = 'near-rehearsal/repair-review-bundle/v1';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const SETTLEMENT_POLICY_SHA = sha256(fs.readFileSync(path.join(ROOT, 'case-triage', 'rehearsal-repair', 'settlement-policy.cjs')));
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
const SANDBOX_ENV_KEYS = ['REPAIR_SANDBOX_DIR', 'NEAR_SANDBOX_BIN_PATH', 'NEAR_SANDBOX_BINARY_PATH'];
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

The Sandbox directory may also come from REPAIR_SANDBOX_DIR (or the existing
NEAR_SANDBOX_BIN_PATH / NEAR_SANDBOX_BINARY_PATH variables). The output
directory must be new. Preconditions are checked before the output directory is
reserved, so a missing source, runtime or base artifact does not leave a
partial run behind.

Modes:
  source-build   (default) Apply the exported patch to an exact upstream checkout,
                 build it with Rust 1.86 + wasm32, then run persisted recovery.
  recorded-wasm  Replay the exported candidate WASM without rebuilding.

The output directory must be new. The command verifies every supplied hash before
writing or running anything. It does not merge, publish or update external state.`;

const verifiedIdentity = (entry, label) => {
  if (typeof entry.identityText !== "string" || !entry.identityText.trim()) {
    fail(`${label} serialized identity is missing`);
  }
  if (!hex(entry.identitySha256)) fail(`${label} identity digest is missing or invalid`);
  if (sha256(Buffer.from(entry.identityText, "utf8")) !== entry.identitySha256) {
    fail(`${label} serialized identity digest does not match`);
  }
  let identity;
  try {
    identity = JSON.parse(entry.identityText);
  } catch (error) {
    fail(`${label} serialized identity is not valid JSON: ${error.message}`);
  }
  if (!identity || identity.schema !== "near-rehearsal/repair-candidate-identity/v1") {
    fail(`${label} serialized identity schema is invalid`);
  }
  if (!identity.source?.path || !hex(identity.source.sha256) || !identity.source.commit) {
    fail(`${label} serialized identity has no complete source`);
  }
  if (!hex(identity.patch?.sha256) || !hex(identity.wasm?.sha256)) {
    fail(`${label} serialized identity has no complete patch/WASM identity`);
  }
  return identity;
};

const checkBundle = (bundle) => {
  if (!bundle || bundle.schema !== SCHEMA) fail(`bundle schema must be ${SCHEMA}`);
  if (!bundle.runId) fail('bundle runId is missing');
  if (bundle.caseId !== 'sputnik-238-async-bond') fail('bundle caseId is not sputnik-238-async-bond');
  const obligation = bundle.case?.obligation;
  if (obligation) {
    const supported = {
      bond: '1000000000000000000000000',
      bondNear: '1',
      transfer: '100000000000000000000000',
      transferNear: '0.1',
    };
    for (const [key, value] of Object.entries(supported)) {
      if (String(obligation[key] ?? '') !== value) fail(`bundle case obligation ${key} does not match the supported Sputnik case`);
    }
  }
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
  for (const [label, value] of [['baseline report', bundle.baseline?.reportText], ['candidate report', bundle.candidate?.reportText], ['recovery report', bundle.recovery?.reportText]]) {
    if (typeof value !== 'string' || !value.trim()) fail(`bundle ${label} is missing`);
  }
  if (sha256(Buffer.from(bundle.baseline.reportText, 'utf8')) !== bundle.baseline.reportSha256) fail('bundle baseline report hash does not match its text');
  if (sha256(Buffer.from(bundle.candidate.reportText, 'utf8')) !== bundle.candidate.reportSha256) fail('bundle candidate report hash does not match its text');
  if (sha256(Buffer.from(bundle.recovery.reportText, 'utf8')) !== bundle.recovery.reportSha256) fail('bundle recovery report hash does not match its text');
  if (bundle.recovery?.acceptance?.ok !== true) fail('bundle recovery acceptance is not recorded as passing');
  if (bundle.recovery.acceptance.candidateWasmSha256 !== bundle.candidate.wasm.sha256) fail('bundle acceptance is for a different candidate WASM');
  if (bundle.recovery?.candidateWasmSha256 && bundle.recovery.candidateWasmSha256 !== bundle.candidate.wasm.sha256) fail('bundle recovery candidate hash does not match');
  if (bundle.candidate.patch.sha256 !== bundle.recovery?.artifacts?.patch?.sha256) fail('bundle recovery patch artifact does not match the candidate patch');
  if (bundle.candidate.wasm.sha256 !== bundle.recovery?.artifacts?.wasm?.sha256) fail('bundle recovery WASM artifact does not match the candidate WASM');
  const candidateIdentity = verifiedIdentity(bundle.candidate, 'candidate');
  const recoveryIdentity = verifiedIdentity(bundle.recovery, 'recovery');
  if (bundle.candidate.identity && JSON.stringify(bundle.candidate.identity) !== JSON.stringify(candidateIdentity)) {
    fail('bundle candidate identity object disagrees with its verified serialized identity');
  }
  if (bundle.recovery.identity && JSON.stringify(bundle.recovery.identity) !== JSON.stringify(recoveryIdentity)) {
    fail('bundle recovery identity object disagrees with its verified serialized identity');
  }
  if (candidateIdentity.patch.sha256 !== bundle.candidate.patch.sha256) fail('verified candidate identity patch does not match');
  if (candidateIdentity.wasm.sha256 !== bundle.candidate.wasm.sha256) fail('verified candidate identity WASM does not match');
  if (candidateIdentity.source.commit !== bundle.source.commit) fail('verified candidate identity source commit does not match');
  if (recoveryIdentity.patch.sha256 !== bundle.candidate.patch.sha256) fail('verified recovery identity patch does not match');
  if (recoveryIdentity.wasm.sha256 !== bundle.candidate.wasm.sha256) fail('verified recovery identity WASM does not match');
  if (recoveryIdentity.source.commit !== bundle.source.commit) fail('verified recovery identity source commit does not match');
  if (JSON.stringify(candidateIdentity.source) !== JSON.stringify(recoveryIdentity.source)) {
    fail('candidate and recovery source identities disagree');
  }
  const artifactSource = bundle.recovery?.artifacts?.source;
  if (artifactSource && (artifactSource.path !== candidateIdentity.source.path || artifactSource.sha256 !== candidateIdentity.source.sha256)) {
    fail('bundle recovery source artifact disagrees with the verified identity');
  }
  const sourceIdentity = candidateIdentity.source;
  let producerMixed = null;
  let legacy = true;
  if (bundle.mixed != null) {
    legacy = false;
    if (typeof bundle.mixed.reportText !== 'string' || !bundle.mixed.reportText.trim()) fail('bundle mixed report text is missing');
    if (!hex(bundle.mixed.reportSha256) || sha256(Buffer.from(bundle.mixed.reportText, 'utf8')) !== bundle.mixed.reportSha256) fail('bundle mixed report hash does not match its text');
    if (bundle.mixed.candidateWasmSha256 !== bundle.candidate.wasm.sha256) fail('bundle mixed evidence is for a different candidate WASM');
    if (!hex(bundle.mixed.policySha256)) fail('bundle mixed policy hash is missing or invalid');
    const currentPolicy = mixedPolicyIdentity(ROOT);
    if (bundle.mixed.policySha256 !== currentPolicy.sha256) fail('bundle mixed policy hash does not match this reviewer policy');
    try { producerMixed = JSON.parse(bundle.mixed.reportText); } catch (error) { fail(`bundle mixed report is not valid JSON: ${error.message}`); }
    const checkedMixed = verifyMixedReport(producerMixed, {requireBlockPinned: true});
    if (!checkedMixed.ok) fail(`bundle mixed producer evidence does not pass the current policy: ${checkedMixed.errors.join('; ')}`);
    if (bundle.settlement == null) fail('bundle failed-refund settlement report is missing');
    if (typeof bundle.settlement.reportText !== 'string' || !bundle.settlement.reportText.trim()) fail('bundle settlement report text is missing');
    if (!hex(bundle.settlement.reportSha256) || sha256(Buffer.from(bundle.settlement.reportText, 'utf8')) !== bundle.settlement.reportSha256) fail('bundle settlement report hash does not match its text');
    if (bundle.settlement.candidateWasmSha256 !== bundle.candidate.wasm.sha256) fail('bundle settlement evidence is for a different candidate WASM');
    if (bundle.settlement.policySha256 !== SETTLEMENT_POLICY_SHA) fail('bundle settlement policy hash does not match this reviewer policy');
    let producerSettlement;
    try { producerSettlement = JSON.parse(bundle.settlement.reportText); } catch (error) { fail(`bundle settlement report is not valid JSON: ${error.message}`); }
    const checkedSettlement = verifySettlementReport(producerSettlement, {candidateWasmSha256: bundle.candidate.wasm.sha256});
    if (!checkedSettlement.ok) fail(`bundle settlement producer evidence does not pass the current policy: ${checkedSettlement.errors.join('; ')}`);
  }
  return { patchText, wasm, sourceIdentity, producerMixed, legacy, mixedPolicy: mixedPolicyIdentity(ROOT) };
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
  const dirty = spawnSync('git', ['-C', sourceDir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (dirty.status !== 0) fail(`could not inspect source checkout status: ${sourceDir}`);
  if (dirty.stdout.trim()) fail(`source checkout has local changes or untracked inputs; use a clean pinned checkout: ${sourceDir}`);
  return result.stdout.trim();
};

const sandboxFromEnvironment = () => {
  for (const key of SANDBOX_ENV_KEYS) {
    if (process.env[key]) return process.env[key];
  }
  return '';
};

const checkOutput = (outDir) => {
  if (!fs.existsSync(outDir)) return;
  if (!fs.statSync(outDir).isDirectory()) fail(`output path is not a directory: ${outDir}`);
  if (fs.readdirSync(outDir).length) {
    fail(`output directory is not empty: ${outDir}; use a new --out. Existing failed-run evidence is left untouched.`);
  }
};

const preflight = (bundle, opts, outDir) => {
  if (opts.mode !== 'source-build' && opts.mode !== 'recorded-wasm') fail(`unknown mode: ${opts.mode}`);
  const basePath = baseWasm(opts);
  checkOutput(outDir);
  const sandboxDir = requireDir(opts.sandboxDir || sandboxFromEnvironment(), 'Sandbox binary directory');
  if (!fs.existsSync(path.join(sandboxDir, 'near-sandbox'))) {
    fail(`Sandbox binary not found in ${sandboxDir}; point REPAIR_SANDBOX_DIR or --sandbox-dir at the extracted directory`);
  }
  let sourceDir = null;
  let head = null;
  if (opts.mode === 'source-build') {
    if (!opts.source) fail('--source is required for source-build mode');
    sourceDir = requireDir(opts.source, 'source checkout');
    head = sourceHead(sourceDir);
    if (head !== bundle.source.commit) {
      fail(`source checkout HEAD ${head} does not match bundle commit ${bundle.source.commit}`);
    }
  }
  return { basePath, sandboxDir, sourceDir, sourceHead: head };
};

const runSourceBuild = (bundle, prepared, outDir, opts) => {
  const sourceIdentity = prepared.sourceIdentity;
  if (!opts.source) fail('--source is required for source-build mode');
  const sourceDir = requireDir(opts.source, 'source checkout');
  const head = sourceHead(sourceDir);
  if (head !== bundle.source.commit) {
    fail(`source checkout HEAD ${head} does not match bundle commit ${bundle.source.commit}`);
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
    modeLabel: 'source build (new execution from the supplied patch; digest may match the recorded artifact)',
    sourceDir,
    sourceHead: head,
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

const runMixedGate = (candidateWasm, outDir, sandboxDir) => {
  const mixedDir = path.join(outDir, 'mixed');
  const result = requireCommand([
    MIXED,
    '--candidate-wasm', candidateWasm,
    '--out', mixedDir,
    '--sandbox-dir', sandboxDir,
  ], 'same-DAO mixed-obligation gate');
  const reportPath = path.join(mixedDir, 'mixed-obligation.json');
  const report = readJson(reportPath, 'same-DAO mixed-obligation report');
  const checked = verifyMixedReport(report, {requireBlockPinned: true});
  if (!checked.ok) fail(`same-DAO mixed-obligation gate failed: ${checked.errors.join('; ')}`);
  return {mixedDir, reportPath, report, checked, policy: mixedPolicyIdentity(ROOT), stdout: result.stdout};
};

const runSettlementGate = (candidateWasm, outDir, sandboxDir) => {
  const settlementDir = path.join(outDir, 'settlement');
  const result = requireCommand([
    SETTLEMENT,
    '--candidate-wasm', candidateWasm,
    '--base-wasm', BASE_WASM,
    '--out', settlementDir,
    '--sandbox-dir', sandboxDir,
  ], 'failed-refund settlement gate');
  const reportPath = path.join(settlementDir, 'settlement-refund.json');
  const report = readJson(reportPath, 'failed-refund settlement report');
  const checked = verifySettlementReport(report, {candidateWasmSha256: sha256(fs.readFileSync(candidateWasm)), baseWasmSha256: sha256(fs.readFileSync(BASE_WASM))});
  return {settlementDir, reportPath, report, checked, stdout: result.stdout};
};

const settlementAcceptanceStage = (checked) => stageFromChecks(
  checked?.ok === true,
  checked?.errors || [],
  {evidenceValid: Boolean(checked) && checked?.unproven !== true},
);

const compareMixed = (producer, reviewer, reviewerWasmSha256, artifactWasmSha256) => {
  const producerOutcomes = producer?.outcomes || (producer ? verifyMixedReport(producer, {requireBlockPinned: true}).outcomes : null);
  const keys = ['alicePaid', 'bobLiabilityAfterAlice', 'bobTransferPaid', 'bobPaidExactlyOnce', 'aliceLockedDelta', 'bobLockedDelta', 'bobRecipientDelta', 'bobProposerDelta'];
  if (!producerOutcomes) return {
    legacy: true,
    candidateMatches: null,
    reviewerWasmSha256,
    artifactWasmSha256,
    note: 'Legacy bundle had no producer mixed evidence; the reviewer ran the current same-DAO policy fresh.',
    reviewer: reviewer.outcomes,
  };
  const differences = keys.filter((key) => String(producerOutcomes?.[key]) !== String(reviewer.outcomes?.[key]));
  const producerWasmSha256 = producer.candidate?.wasmSha256 || null;
  const candidateMatches = producerWasmSha256 === reviewerWasmSha256;
  if (differences.length) fail(`producer/reviewer mixed outcomes differ: ${differences.join(', ')}`);
  return {
    legacy: false,
    candidateMatches,
    reviewerWasmSha256,
    artifactWasmSha256,
    producerWasmSha256,
    artifactMismatch: reviewerWasmSha256 !== artifactWasmSha256,
    policyMatches: true,
    differences,
    producer: producerOutcomes,
    reviewer: reviewer.outcomes,
  };
};

const formatYocto = (value) => {
  let n;
  try {
    n = BigInt(value);
  } catch {
    return String(value ?? 'n/a');
  }
  const negative = n < 0n;
  const absolute = negative ? -n : n;
  const whole = absolute / 1000000000000000000000000n;
  const fraction = (absolute % 1000000000000000000000000n)
    .toString().padStart(24, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''} NEAR`;
};
const yoctoNear = formatYocto; // kept for callers of the earlier module surface

const summarize = (report, run) => {
  const first = report.firstRecovery || {};
  const second = report.secondRetry || {};
  const healthy = report.healthyPreservation?.checks || {};
  const healthySettled = healthy.settledPayout;
  const healthyPending = report.healthyPreservation?.pending?.deltas?.recipient;
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
      gross: formatYocto(gross),
      grossYocto: String(gross ?? ''),
      gas: formatYocto(gas),
      gasYocto: String(gas ?? ''),
      proposerNet: formatYocto(first.deltas?.proposer),
      proposerNetYocto: String(first.deltas?.proposer ?? ''),
      contractDelta: formatYocto(first.deltas?.contract),
      contractDeltaYocto: String(first.deltas?.contract ?? ''),
      recipientDelta: formatYocto(first.deltas?.recipient),
      recipientDeltaYocto: String(first.deltas?.recipient ?? ''),
      lockedDelta: formatYocto(first.deltas?.locked),
      lockedDeltaYocto: String(first.deltas?.locked ?? ''),
      endedFailed: first.endedFailed === true,
    },
    retry: {
      gross: formatYocto(secondGross),
      grossYocto: String(secondGross ?? ''),
      gas: formatYocto(secondGas),
      gasYocto: String(secondGas ?? ''),
      proposerNet: formatYocto(second.deltas?.proposer),
      proposerNetYocto: String(second.deltas?.proposer ?? ''),
      contractDelta: formatYocto(second.deltas?.contract),
      contractDeltaYocto: String(second.deltas?.contract ?? ''),
      recipientDelta: formatYocto(second.deltas?.recipient),
      recipientDeltaYocto: String(second.deltas?.recipient ?? ''),
      lockedDelta: formatYocto(second.deltas?.locked),
      lockedDeltaYocto: String(second.deltas?.locked ?? ''),
      endedFailed: second.endedFailed === true,
    },
    healthy: {
      settledTransfer: healthySettled ? formatYocto(healthySettled) : null,
      settledTransferYocto: healthySettled ? String(healthySettled) : null,
      pendingTransfer: healthyPending ? formatYocto(healthyPending) : null,
      pendingTransferYocto: healthyPending ? String(healthyPending) : null,
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
    `First deliberate operation: recovered ${s.firstRecovery.gross} gross, ${s.firstRecovery.gas} gas, proposer net ${s.firstRecovery.proposerNet}, ended ${s.firstRecovery.endedFailed}`,
    `Retry: ${s.retry.gross} gross, ${s.retry.gas} gas, proposer net ${s.retry.proposerNet} — no extra principal`,
    `Preserved inherited state/policy/proposal: ${s.checks.preservedState}/${s.checks.preservedPolicy}/${s.checks.preservedProposal}`,
    `Unauthorized update/finalize rejected: ${s.checks.authorityRejected ? 'yes' : 'NO'}`,
    `Healthy controls (already-paid + pending Transfer): ${s.checks.healthyControl}/${s.checks.pendingHealthy}`,
    '',
    `Same-DAO policy: ${result.mixed.reviewer.ok ? 'pass' : 'FAIL'} (${result.mixed.comparison.legacy ? 'legacy producer evidence absent; fresh reviewer gate' : 'producer evidence compared'})`,
    `Producer/reviewer principal outcomes: ${result.mixed.comparison.legacy ? 'not comparable (legacy bundle)' : 'match'}`,
    `Reviewer mixed policy: ${result.mixed.policy.sha256}`,
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
  const plan = preflight(bundle, opts, outDir);
  opts.sandboxDir = plan.sandboxDir;
  opts.baseWasm = plan.basePath;
  if (plan.sourceDir) opts.source = plan.sourceDir;
  bundle._sourceIdentity = sourceIdentity;
  const prepared = prepare(bundle, outDir);
  const run = opts.mode === 'source-build'
    ? runSourceBuild(bundle, prepared, outDir, opts)
    : runRecorded(bundle, prepared, outDir, opts);
  const report = readJson(run.reportPath, 'persisted recovery report');
  const summary = summarize(report, run);
  if (!summary.checks.accepted) fail('persisted recovery report did not pass acceptance');
  const mixedRun = runMixedGate(run.builtWasm || run.wasmPath, outDir, plan.sandboxDir);
  const reviewerArtifactWasmSha256 = run.mode === 'source-build' ? run.builtWasmSha256 : run.wasmSha256;
  const mixedReportWasmSha256 = mixedRun.report?.candidate?.wasmSha256;
  if (!mixedReportWasmSha256 || mixedReportWasmSha256 !== reviewerArtifactWasmSha256) fail('reviewer mixed gate did not execute the built/recorded candidate artifact');
  const mixedComparison = compareMixed(checkBundle(bundle).producerMixed, mixedRun.checked, mixedReportWasmSha256, reviewerArtifactWasmSha256);
  const settlementRun = runSettlementGate(run.builtWasm || run.wasmPath, outDir, plan.sandboxDir);
  if (settlementRun.report.candidate.wasmSha256 !== reviewerArtifactWasmSha256) fail('settlement gate did not execute the built/recorded candidate artifact');
  const acceptancePolicy = evaluateCandidate({
    fresh: stageFromChecks(summary.checks.accepted, summary.checks.accepted ? [] : ['persisted/fresh acceptance did not pass'], {evidenceValid: Boolean(summary)}),
    recovery: stageFromChecks(summary.checks.accepted, summary.checks.accepted ? [] : ['persisted recovery report did not pass acceptance'], {evidenceValid: Boolean(report)}),
    mixed: stageFromChecks(mixedRun.checked.ok === true, mixedRun.checked.errors || [], {policyVersion: POLICY_VERSION, evidenceValid: Boolean(mixedRun.checked)}),
    settlement: settlementAcceptanceStage(settlementRun.checked),
  });
  if (acceptancePolicy.status === 'REJECTED') fail(`${acceptancePolicy.status}: versioned acceptance policy ${acceptancePolicy.policyVersion} failed: ${acceptancePolicy.errors.join('; ')}`);
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
    acceptancePolicy,
    mixed: {
      mode: 'fresh-replay',
      policy: mixedRun.policy,
      reviewer: mixedRun.checked,
      reportPath: mixedRun.reportPath,
      comparison: mixedComparison,
    },
    settlement: {
      mode: 'fresh-replay',
      reportPath: settlementRun.reportPath,
      reportSha256: sha256(fs.readFileSync(settlementRun.reportPath)),
      checked: settlementRun.checked,
    },
    resultPath,
    boundary: 'Local NEAR Sandbox 2.14 only. No public write, deployment, production upgrade, or claim about other cases.',
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(render(result));
  if (acceptancePolicy.status === 'INCONCLUSIVE') process.exitCode = 5;
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`repair-review: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { checkBundle, compareMixed, formatYocto, yoctoNear, summarize, preflight, sandboxFromEnvironment, settlementAcceptanceStage };
