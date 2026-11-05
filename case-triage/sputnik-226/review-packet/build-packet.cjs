'use strict';
/*
 * Build the read-only reviewer packet from actual verified-case evidence.
 * No app integration, no network, no new dependencies.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const here = __dirname;
const sourceDir = path.resolve(here, '..', 'verified-case');
const evidenceDir = path.join(here, 'evidence');
const dataDir = path.join(here, 'data');

const read = (name) => fs.readFileSync(path.join(sourceDir, name));
const readJson = (name) => JSON.parse(read(name).toString('utf8'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function formatNear(yocto) {
  let s = BigInt(yocto).toString();
  if (s.length <= 24) s = '0.' + s.padStart(24, '0');
  else s = s.slice(0, -24) + '.' + s.slice(-24);
  return s.replace(/\.?0+$/, '') || '0';
}

function txResult(tx) {
  if (tx?.status?.SuccessValue !== undefined) return 'success';
  if (tx?.status?.Failure !== undefined) return 'failure';
  return 'unknown';
}

function txError(tx) {
  const raw = tx?.status?.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError
    || JSON.stringify(tx?.status || {});
  return String(raw).replace(/\\n/g, '\n');
}

function stage(id, label, tx, finality, detail, finalityKey = id) {
  return {
    id,
    label,
    transaction: tx?.transaction?.hash || tx?.transaction_outcome?.id || null,
    result: txResult(tx),
    error: txResult(tx) === 'failure' ? txError(tx) : null,
    finality: finality?.[finalityKey] || null,
    detail,
  };
}

const artifacts = readJson('artifacts.json');
const provenance = readJson('provenance.json');
const node = readJson('node-evidence.json');
const authority = readJson('authority-probe.json');
const wrongHash = readJson('wrong-hash-probe.json');
const rustResult = read('rust-result.txt').toString('utf8');
const rustRows = read('rust-evidence.jsonl').toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

if (node.status !== 'passed' || node.stage !== 'complete') throw new Error('verified Node evidence is not a complete pass');
if (node.mode !== 'local-configured-factory-update') throw new Error('unexpected mode');
if (node.governanceUpgradeSelf !== false || node.callbackFlow !== false) throw new Error('governance/callback boundary changed');
if (node.inputs.baseSha256 !== artifacts.base.sha256) throw new Error('base hash mismatch in evidence');
if (node.inputs.candidateSha256 !== artifacts.candidate.sha256) throw new Error('candidate hash mismatch in evidence');

const recipient = node.recipient;
const transfer = BigInt(recipient.delta);
const afterReplay = BigInt(recipient.afterReplay);
const afterFinalize = BigInt(recipient.afterFinalizeRetry);
if (transfer !== 1000000000000000000000000n) throw new Error('recipient first delta is not 1 NEAR');
if (afterReplay - BigInt(recipient.before) !== transfer) throw new Error('replay delta is not exactly one transfer');
if (afterFinalize - BigInt(recipient.before) !== transfer) throw new Error('Finalize retry delta is not exactly one transfer');

fs.rmSync(evidenceDir, {recursive: true, force: true});
fs.mkdirSync(evidenceDir, {recursive: true});
for (const file of fs.readdirSync(sourceDir)) {
  const from = path.join(sourceDir, file);
  if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(evidenceDir, file));
}
fs.mkdirSync(dataDir, {recursive: true});

const stages = [
  stage('deploy', 'Deploy base WASM', node.transactions.deploy, node.finality, 'Source-built base deployed to the local Sandbox.'),
  stage('init', 'Initialize through root', node.transactions.init, node.finality, 'Root is persisted as FactoryInfo.factory_id; this is a configured test factory.'),
  stage('addProposal', 'Create inherited proposal', node.transactions.addProposal, node.finality, 'Proposal 0 exists before the upgrade, status InProgress.', 'add-proposal'),
  stage('update', 'Configured-factory update', node.transactions.update, node.finality, 'Root calls update(candidate bytes); candidate deployed and migrate() runs.'),
  stage('approve', 'First approval', node.transactions.approve, node.finality, 'Root VoteApprove; proposal becomes Approved; exactly 1 local NEAR is paid.'),
  stage('replay', 'Retry VoteApprove', node.transactions.replay, node.finality, 'Rejected after Approved; no second transfer.'),
  stage('finalizeRetry', 'Retry Finalize', node.transactions.finalizeRetry, node.finality, 'Rejected because policy::proposal_status only accepts InProgress/Failed; no second transfer.', 'finalize-retry'),
];

const rawLinks = [
  {label: 'Node receipts, state and finality', href: 'evidence/node-evidence.json', note: 'Full raw Node evidence from the recorded run.'},
  {label: 'Native Rust evidence', href: 'evidence/rust-evidence.jsonl', note: 'Raw per-stage Rust execution records.'},
  {label: 'Native Rust result', href: 'evidence/rust-result.txt', note: '1 passed, 0 failed.'},
  {label: 'Source-built artifacts and hashes', href: 'evidence/artifacts.json', note: 'Base and candidate WASM bytes and SHA-256 values.'},
  {label: 'Provenance and scope', href: 'evidence/provenance.json', note: 'Commits, runtime, mode and boundaries.'},
  {label: 'Checksums', href: 'evidence/SHA256SUMS', note: 'SHA-256 manifest for every evidence file.'},
  {label: 'Sputnik license', href: 'evidence/SPUTNIK-LICENSE', note: 'Original upstream license.'},
  {label: 'Wrong-hash negative control', href: 'evidence/wrong-hash-probe.json', note: 'Rejected before any Sandbox transaction.'},
  {label: 'Unauthorized-caller negative control', href: 'evidence/authority-probe.json', note: 'Separate probe: unconfigured caller denied; code/config unchanged.'},
];

const packet = {
  schema: 'near-rehearsal/review-packet/sputnik-226/v1',
  generatedFrom: '92c338a40b24d60e428e6ca94c0110c64c4b690c',
  generatedAt: new Date().toISOString(),
  status: 'recorded local run passed',
  headline: 'An inherited Sputnik proposal survives the upgrade and pays exactly once.',
  summary: `Proposal ${node.proposalId} survived migration. It paid exactly ${formatNear(transfer)} local NEAR. Two retry routes were rejected, the recipient stayed at ${formatNear(afterFinalize)} NEAR total, and the DAO config stayed unchanged.`,
  scope: [
    'Historical source pins; no source or lockfile changes.',
    'Locally constructed old-version state, not a mainnet capture.',
    'Local configured-factory update, not governance UpgradeSelf or the self-call/callback branch.',
    'Recorded local run; ownership evidence retained outside Git.',
    'Two tested retry routes, not a universal exactly-once guarantee.',
    'No safe-release, onchain-mainnet, or current-app Sputnik-support claim.',
  ],
  result: {
    proposalId: node.proposalId,
    proposalStatusBefore: node.proposalBefore.status,
    proposalStatusAfterUpgrade: node.proposalAfterUpgrade.status,
    proposalStatusAfter: node.proposalAfter.status,
    proposalStatusAfterRetries: node.proposalAfterFinalizeRetry.status,
    rootVote: node.proposalAfter.votes?.[node.factory.initializedBy] || node.proposalAfter.votes?.['test.near'],
    configUnchanged: JSON.stringify(node.configBefore) === JSON.stringify(node.configAfter),
    recipientBefore: formatNear(recipient.before),
    recipientAfterFirst: formatNear(recipient.after),
    recipientAfterReplay: formatNear(recipient.afterReplay),
    recipientAfterFinalizeRetry: formatNear(recipient.afterFinalizeRetry),
    firstPaymentNear: formatNear(transfer),
    totalDeltaNear: formatNear(BigInt(recipient.deltaTotal)),
    retries: [
      {id: 'replay', label: 'Duplicate VoteApprove', status: 'rejected', error: txError(node.transactions.replay)},
      {id: 'finalizeRetry', label: 'Finalize retry', status: 'rejected', error: txError(node.transactions.finalizeRetry)},
    ],
  },
  factory: node.factory,
  stages,
  provenance: {
    sourceRepo: provenance.sourceRepo,
    baseCommit: provenance.baseCommit,
    candidateCommit: provenance.candidateCommit,
    harnessCommit: provenance.harnessCommit,
    runtime: provenance.runtime,
    mode: provenance.mode,
    state: provenance.state,
    checks: provenance.checks,
    comparisonBoundaries: provenance.comparisonBoundaries,
  },
  artifacts: {
    base: {...artifacts.base, link: 'evidence/base.wasm'},
    candidate: {...artifacts.candidate, link: 'evidence/candidate.wasm'},
    build: artifacts.build,
    boundary: artifacts.boundary,
    codeSha256: node.codeSha256,
  },
  checks: {
    nodePassed: node.status === 'passed',
    nativePassed: /1 passed; 0 failed/.test(rustResult),
    nativeEvidenceStages: rustRows.map((row) => row.stage),
    configUnchanged: JSON.stringify(node.configBefore) === JSON.stringify(node.configAfter),
    proposalSurvived: node.proposalBefore.status === 'InProgress' && node.proposalAfterUpgrade.status === 'InProgress',
    firstPaymentExact: transfer === 1000000000000000000000000n,
    bothRetriesRejected: node.replay?.duplicateApproval?.transactionFailed === true && node.replay?.finalizeRetry?.transactionFailed === true,
    noSecondTransfer: afterReplay === afterFinalize && afterFinalize - BigInt(recipient.before) === transfer,
    finalityTargetsReached: Object.values(node.finality || {}).every((entry) => Number.isFinite(entry.target) && Number.isFinite(entry.finalized) && entry.finalized >= entry.target),
  },
  negativeControls: [
    {label: 'Wrong candidate hash', status: wrongHash.status, detail: 'Rejected at the inputs stage before any Sandbox transaction.', link: 'evidence/wrong-hash-probe.json'},
    {label: 'Unconfigured caller', status: authority.status, detail: 'Separate probe: upgrade denied with ERR_MUST_BE_SELF_OR_FACTORY; code and config unchanged.', link: 'evidence/authority-probe.json'},
  ],
  rerun: {
    artifacts: 'The packet evidence directory contains the exact source-built base.wasm and candidate.wasm used by the recorded run.',
    command: `cd case-triage/sputnik-226
BASE_WASM="$PWD/review-packet/evidence/base.wasm" \\
BASE_WASM_SHA256=${artifacts.base.sha256} \\
CANDIDATE_WASM="$PWD/review-packet/evidence/candidate.wasm" \\
CANDIDATE_WASM_SHA256=${artifacts.candidate.sha256} \\
NODE_SANDBOX_BIN_DIR="/path/to/pinned/sandbox-directory" \\
EVIDENCE_PATH="$PWD/review-packet/rerun-evidence.json" \\
node node-harness.cjs`,
    verifier: 'node case-triage/sputnik-226/review-packet/verify.cjs',
    note: 'The verifier checks offline consistency only. It is not cryptographic proof of execution; the rerun is the execution check.',
  },
  rawLinks,
  limits: [
    'This is a local historical-source pilot, not a current product integration.',
    'The contract still holds funds in the bad-case family; this packet is the Sputnik upgrade case, not the refund app.',
    'No maintainer acceptance, measured preference, time saving, or production safety is claimed.',
    'Native near-workspaces can express the same invariant; the hypothesis is reviewer effort and packaging, not a unique execution primitive.',
  ],
};

fs.writeFileSync(path.join(dataDir, 'packet.json'), JSON.stringify(packet, null, 2) + '\n');
console.log(`wrote ${path.join(dataDir, 'packet.json')}`);
console.log(`copied ${fs.readdirSync(evidenceDir).length} evidence files`);
