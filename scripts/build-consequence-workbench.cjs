'use strict';
/*
 * Build the static consequence workbench from recorded evidence.
 *
 * This is intentionally a build-time data-integrity step, not a runtime
 * executor. It refuses to publish a candidate whose recorded report or
 * artifact hashes do not match the reviewed files, and it copies the exact
 * download material into the portable static directory.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {verifyMixedReport} = require('../case-triage/rehearsal-repair/mixed-policy.cjs');
const {mixedPolicyIdentity} = require('../case-triage/rehearsal-repair/mixed-policy-identity.cjs');
const {verifyPacket} = require('../case-triage/sputnik-226/review-packet/packet-model.cjs');

const ROOT = path.resolve(__dirname, '..');
const REPAIR = path.join(ROOT, 'case-triage', 'rehearsal-repair');
const PACKET = path.join(ROOT, 'case-triage', 'sputnik-226', 'review-packet');
const OUT = path.join(ROOT, 'ui', 'sputnik', 'public', 'consequences');
const DOWNLOADS = path.join(OUT, 'downloads');
const SHA = (value) => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = (file) => SHA(fs.readFileSync(file));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = (file) => fs.existsSync(file) && fs.statSync(file).isFile();
const requireFile = (file, label) => {
  if (!exists(file)) throw new Error(`${label} is missing: ${file}`);
  return file;
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

function copyFile(from, to) {
  requireFile(from, `source artifact ${path.basename(from)}`);
  fs.mkdirSync(path.dirname(to), {recursive: true});
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o644);
  return {path: path.relative(OUT, to).split(path.sep).join('/'), sha256: shaFile(to), bytes: fs.statSync(to).size};
}

function copyTree(from, to) {
  if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) throw new Error(`source directory is missing: ${from}`);
  fs.mkdirSync(to, {recursive: true});
  for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) copyFile(source, target);
  }
}

function zipDirectory(relativeDir, zipName) {
  const target = path.join(DOWNLOADS, zipName);
  try { fs.rmSync(target, {force: true}); } catch {}
  const result = spawnSync('zip', ['-q', '-X', '-r', zipName, relativeDir], {
    cwd: DOWNLOADS,
    encoding: 'utf8',
    env: {...process.env, TZ: 'UTC', SOURCE_DATE_EPOCH: '0'},
  });
  if (result.error || result.status !== 0) throw new Error(`could not create ${zipName}: ${result.error?.message || result.stderr}`);
  requireFile(target, zipName);
  return {path: `downloads/${zipName}`, sha256: shaFile(target), bytes: fs.statSync(target).size};
}

function sanitizeRuntime(report) {
  const runtime = report?.runtime || {};
  return {
    version: String(runtime.version || 'unknown'),
    commit: String(runtime.commit || 'unknown'),
    protocol: runtime.protocol ?? null,
    binarySha256: String(runtime.binarySha256 || 'unknown'),
  };
}

function snap(report, key, label) {
  const value = report?.[key];
  if (!value) throw new Error(`recorded snapshot ${key} is missing`);
  const state = key === 'beforeUpgrade' || key === 'afterUpgrade' ? value : value.after;
  if (!state) throw new Error(`recorded snapshot ${key}.after is missing`);
  return {
    id: key,
    label,
    locked: String(state.lockedAmount ?? ''),
    blockHeight: state.blockHeight ?? null,
    blockHash: state.blockHash ?? null,
    proposals: state.proposals || {},
    balances: state.balances || {},
  };
}

function sequence(report) {
  return [
    snap(report, 'beforeUpgrade', 'Before upgrade'),
    snap(report, 'afterUpgrade', 'After upgrade'),
    snap(report, 'aliceRecovery', 'Alice recovery'),
    snap(report, 'aliceRetry', 'Alice retry'),
    snap(report, 'bobPayout', 'Bob payout'),
    snap(report, 'bobRetry', 'Bob retry'),
    snap(report, 'carolRetry', 'Carol retry'),
  ];
}

function candidateData(id, label, manifest, reportPath, copiedPatch, copiedWasm, verified) {
  const candidate = manifest.candidates?.[id];
  if (!candidate) throw new Error(`candidate ${id} is missing from the manifest`);
  if (!verified?.outcomes) throw new Error(`candidate ${id} has no policy outcomes`);
  const report = readJson(reportPath);
  const stages = sequence(report);
  const aliceRecovery = report.aliceRecovery?.deltas || {};
  const bobPayout = report.bobPayout?.deltas || {};
  return {
    id,
    label,
    status: verified.ok ? 'ACCEPTED' : 'REJECTED',
    summary: verified.ok
      ? 'Alice recovers exactly her bond; Bob’s 1 NEAR remains locked until his funded operation, then both liabilities reach zero.'
      : 'Alice is refunded, but the aggregate locked ledger drops from 2 NEAR to 0. Bob’s inherited liability disappears before his funded operation, so the repair is rejected.',
    errors: verified.errors,
    outcomes: verified.outcomes,
    stages,
    cash: {
      aliceBondGross: String(-BigInt(aliceRecovery.contract ?? '0')),
      aliceBondNet: String(aliceRecovery.proposer ?? ''),
      aliceGas: String(verified.outcomes?.gas?.aliceRecovery ?? ''),
      aliceContractDelta: String(aliceRecovery.contract ?? ''),
      bobTransfer: String(bobPayout.recipient ?? ''),
      bobBondReturned: String(bobPayout.proposer ?? ''),
      bobContractDelta: String(bobPayout.contract ?? ''),
    },
    candidate: {
      wasm: {sha256: candidate.wasmSha256, bytes: candidate.wasmBytes, path: copiedWasm.path},
      patch: candidate.patch
        ? {sha256: candidate.patchSha256, path: copiedPatch.path}
        : null,
      report: {path: `downloads/238/${path.basename(reportPath)}`, sha256: shaFile(reportPath), bytes: fs.statSync(reportPath).size},
    },
    evidence: [
      {label: 'Recorded report', href: `downloads/238/${path.basename(reportPath)}`},
      ...(candidate.patch ? [{label: 'Source patch', href: copiedPatch.path}] : []),
      {label: 'Candidate WASM', href: copiedWasm.path},
    ],
  };
}

function build238() {
  const manifestPath = path.join(REPAIR, 'mixed-candidates', 'manifest.json');
  const manifest = readJson(requireFile(manifestPath, 'mixed candidate manifest'));
  const destination = path.join(DOWNLOADS, '238');
  fs.mkdirSync(destination, {recursive: true});
  const copies = {};
  for (const id of ['old', 'clear-all', 'intended']) {
    const entry = manifest.candidates?.[id];
    if (!entry) throw new Error(`candidate ${id} is missing from the manifest`);
    const wasmSource = path.join(REPAIR, entry.wasm);
    const wasmTarget = path.join(destination, `${id}.wasm`);
    copies[`${id}Wasm`] = copyFile(wasmSource, wasmTarget);
    if (entry.patch) {
      const patchSource = path.join(REPAIR, entry.patch);
      const patchTarget = path.join(destination, `${id}.patch`);
      copies[`${id}Patch`] = copyFile(patchSource, patchTarget);
      if (shaFile(patchSource) !== entry.patchSha256) throw new Error(`patch hash mismatch for ${id}`);
    }
    if (shaFile(wasmSource) !== entry.wasmSha256) throw new Error(`WASM hash mismatch for ${id}`);
  }

  const reportFiles = {
    old: path.join(REPAIR, 'out', 'mixed-obligation-old.json'),
    clearAll: path.join(REPAIR, 'out', 'mixed-obligation-clear-all.json'),
    intended: path.join(REPAIR, 'out', 'mixed-obligation-intended.json'),
  };
  const copiedReports = {};
  for (const [name, file] of Object.entries(reportFiles)) {
    copiedReports[name] = copyFile(file, path.join(destination, path.basename(file)));
  }
  const baseReport = path.join(REPAIR, 'out', 'issue238-local.json');
  copiedReports.base = copyFile(baseReport, path.join(destination, 'issue238-local.json'));
  copyFile(manifestPath, path.join(destination, 'manifest.json'));

  const clearReport = readJson(reportFiles.clearAll);
  const intendedReport = readJson(reportFiles.intended);
  const clearVerified = verifyMixedReport(clearReport, {requireBlockPinned: true});
  const intendedVerified = verifyMixedReport(intendedReport, {requireBlockPinned: true});
  if (clearVerified.ok) throw new Error('clear-all candidate unexpectedly passes the mixed policy');
  if (!intendedVerified.ok) throw new Error(`intended candidate does not pass the mixed policy: ${intendedVerified.errors.join('; ')}`);
  if (clearVerified.outcomes?.aliceLockedDelta !== '-2000000000000000000000000') throw new Error('clear-all did not erase the second liability as recorded');

  const baseline = readJson(reportFiles.old);
  const policy = mixedPolicyIdentity(ROOT);
  const clear = candidateData('clear-all', 'Clear-all repair', manifest, reportFiles.clearAll, copies['clear-allPatch'], copies['clear-allWasm'], clearVerified);
  const intended = candidateData('intended', 'Intended repair', manifest, reportFiles.intended, copies.intendedPatch, copies.intendedWasm, intendedVerified);
  const baselineStage = snap(baseline, 'beforeUpgrade', 'Before upgrade');
  const baselineAfter = snap(baseline, 'afterUpgrade', 'After upgrade');

  fs.writeFileSync(path.join(destination, 'README.md'), `# Sputnik #238 consequence evidence

Recorded local review material. These files are not a live run and not a mainnet claim.

- Source: https://github.com/near-daos/sputnik-dao-contract
- Pinned commit: 5434a59dec23ee0c49df8c8c4350c208a7e75b0b
- Runtime: Sandbox 2.14.0, protocol 88
- Policy SHA-256: ${policy.sha256}
- Baseline WASM: ${manifest.candidates.old.wasmSha256}
- Clear-all candidate: ${manifest.candidates['clear-all'].wasmSha256}
- Intended candidate: ${manifest.candidates.intended.wasmSha256}

## Reproduce with the supported source-review command

\`\`\`sh
git clone https://github.com/dolepee/near-rehearsal.git
cd near-rehearsal
npm run setup
# Check out a clean pinned source tree at 5434a59dec23ee0c49df8c8c4350c208a7e75b0b,
# install Sandbox 2.14.0, then:
npm run review:patch -- --patch <downloaded>/clear-all.patch --source <clean-pinned-checkout> --out <new-directory> --sandbox-dir <sandbox-2.14-directory>
\`\`\`

The recorded report and the candidate/patch hashes are included here. The command
builds the patch from source and exercises the persisted recovery and same-DAO
policy; it does not execute a public chain transaction.

## Files

- \`clear-all.patch\` / \`clear-all.wasm\`: rejected candidate.
- \`intended.patch\` / \`intended.wasm\`: accepted candidate.
- \`old.wasm\`: pinned baseline code.
- \`mixed-obligation-clear-all.json\`: recorded bad result.
- \`mixed-obligation-intended.json\`: recorded good result.
- \`mixed-obligation-old.json\`: baseline recording.
- \`issue238-local.json\`: controller-owned fixture used for expected bond/transfer amounts.
- \`manifest.json\`: candidate source/build identity.
`);

  return {
    title: 'Sputnik #238 — repair decision',
    kind: 'repair-decision',
    label: 'Recorded execution',
    source: {
      repository: manifest.source.repository,
      commit: manifest.source.commit,
      issue: 'https://github.com/near-daos/sputnik-dao-contract/issues/238',
      baseWasmSha256: manifest.candidates.old.wasmSha256,
    },
    runtime: sanitizeRuntime(clearReport),
    policy,
    baseline: {
      label: 'Pinned baseline — no repair',
      stages: [baselineStage, baselineAfter],
      note: 'Two obligations are already locked. This is the state the repair must preserve while releasing only Alice’s bond.',
    },
    candidates: [clear, intended],
    defaultCandidate: 'clear-all',
    commands: {
      review: 'npm run review:patch -- --patch <downloaded>/clear-all.patch --source <clean-pinned-checkout> --out <new-directory> --sandbox-dir <sandbox-2.14-directory>',
      intended: 'npm run review:patch -- --patch <downloaded>/intended.patch --source <clean-pinned-checkout> --out <new-directory> --sandbox-dir <sandbox-2.14-directory>',
    },
    downloads: {
      evidence: zipDirectory('238', '238-evidence.zip'),
      directory: 'downloads/238/',
    },
  };
}

function build226() {
  verifyPacket(PACKET);
  const packet = readJson(path.join(PACKET, 'data', 'packet.json'));
  const destination = path.join(DOWNLOADS, '226');
  fs.mkdirSync(destination, {recursive: true});
  copyTree(PACKET, destination);
  const zip = zipDirectory('226', '226-evidence.zip');
  const packetFile = path.join(destination, 'data', 'packet.json');
  if (!exists(packetFile)) throw new Error('copied #226 packet is missing');
  return {
    title: 'Sputnik #226 — upgrade compatibility',
    kind: 'recorded-upgrade',
    label: 'Recorded local run',
    status: 'PASS',
    headline: packet.headline,
    summary: packet.summary,
    source: {
      repository: packet.provenance.sourceRepo,
      pr: 226,
      baseCommit: packet.provenance.baseCommit,
      candidateCommit: packet.provenance.candidateCommit,
      mergeCommit: packet.provenance.mergeCommit || null,
      harnessCommit: packet.provenance.harnessCommit || null,
      mode: packet.provenance.mode,
      state: packet.provenance.state,
    },
    runtime: {
      version: packet.provenance.runtime.version,
      platform: packet.provenance.runtime.platform,
      binarySha256: packet.provenance.runtime.sha256,
    },
    result: packet.result,
    stages: packet.stages,
    checks: packet.checks,
    scope: packet.scope,
    limits: packet.limits,
    negativeControls: packet.negativeControls,
    commands: {
      rerun: packet.rerun?.command || '',
      verify: packet.rerun?.verifier || '',
      note: packet.rerun?.note || '',
      prerequisite: 'Fresh local replay needs a shell that permits local TCP listeners on 127.0.0.1 and 0.0.0.0. run-case.cjs now fails fast with a setup error if the shell denies the bind; increasing Node heap will not fix it.',
    },
    packet: {
      href: 'downloads/226/index.html',
      verify: 'downloads/226/index.html',
      sha256: shaFile(packetFile),
    },
    downloads: {
      evidence: zip,
      directory: 'downloads/226/',
      packet: 'downloads/226/index.html',
    },
  };
}

function assertCaseFiles(data, out = OUT) {
  const check = (href, sha, label) => {
    if (!href || path.isAbsolute(href)) throw new Error(`${label} path is not relative`);
    const target = path.resolve(out, href);
    const base = path.resolve(out);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error(`${label} escapes the workbench`);
    requireFile(target, label);
    if (sha && shaFile(target) !== sha) throw new Error(`${label} hash mismatch`);
  };
  for (const candidate of data.cases['238'].candidates) {
    check(candidate.candidate.wasm.path, candidate.candidate.wasm.sha256, `${candidate.id} WASM`);
    if (candidate.candidate.patch) check(candidate.candidate.patch.path, candidate.candidate.patch.sha256, `${candidate.id} patch`);
    check(candidate.candidate.report.path, candidate.candidate.report.sha256, `${candidate.id} report`);
  }
  check(data.cases['238'].downloads.evidence.path, data.cases['238'].downloads.evidence.sha256, '#238 evidence zip');
  check(data.cases['226'].packet.href, null, '#226 packet');
  check(data.cases['226'].downloads.evidence.path, data.cases['226'].downloads.evidence.sha256, '#226 evidence zip');
  const json = JSON.stringify(data);
  for (const marker of ['/workspace/', '/Users/', 'C:\\']) {
    if (json.includes(marker)) throw new Error(`absolute path marker leaked into cases.json: ${marker}`);
  }
}

function buildWorkbench(root = ROOT, out = OUT) {
  if (path.resolve(root) !== path.resolve(ROOT) || path.resolve(out) !== path.resolve(OUT)) {
    throw new Error('buildWorkbench supports the repository root and default output only');
  }
  const data = {
    schema: 'near-rehearsal/consequence-workbench/v1',
    generatedAt: readJson(path.join(REPAIR, 'out', 'mixed-obligation-clear-all.json')).generatedAt || null,
    label: 'Recorded execution',
    disclaimer: 'These are recorded local results. The page does not run a fresh Sandbox, compile code or query a public chain.',
    cases: {
      '238': build238(),
      '226': build226(),
    },
  };
  assertCaseFiles(data, OUT);
  writeJson(path.join(OUT, 'cases.json'), data);
  return {out: OUT, cases: data.cases};
}

if (require.main === module) {
  try {
    const result = buildWorkbench();
    console.log(`Wrote ${path.relative(ROOT, result.out)}/cases.json`);
    console.log(`#238: ${result.cases['238'].candidates.map((candidate) => `${candidate.id}=${candidate.status}`).join(', ')}`);
    console.log(`#226: ${result.cases['226'].status} (recorded, ${result.cases['226'].runtime.version})`);
  } catch (error) {
    console.error(`consequence workbench build failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {buildWorkbench, build238, build226, assertCaseFiles, OUT, DOWNLOADS, shaFile};
