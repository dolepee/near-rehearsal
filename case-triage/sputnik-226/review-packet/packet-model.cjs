'use strict';
/*
 * Canonical packet model and evidence validation.
 *
 * The builder and verifier share this module so a displayed packet cannot drift
 * from the raw verified evidence. It is still an offline consistency check, not
 * a cryptographic execution proof.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function formatNear(yocto) {
  let s = BigInt(yocto).toString();
  if (s.length <= 24) s = '0.' + s.padStart(24, '0');
  else s = s.slice(0, -24) + '.' + s.slice(-24);
  return s.replace(/\.?0+$/, '') || '0';
}

function fail(message) { throw new Error(message); }
function requireValue(condition, message) { if (!condition) fail(message); }
function readFile(dir, name) { return fs.readFileSync(path.join(dir, name)); }
function readJson(dir, name) { return JSON.parse(readFile(dir, name).toString('utf8')); }
function successReceipt(receipt) {
  return receipt?.outcome?.status?.SuccessValue !== undefined
    || receipt?.outcome?.status?.SuccessReceiptId !== undefined;
}
function failureReceipt(receipt) { return receipt?.outcome?.status?.Failure !== undefined; }
function successTx(tx) { return tx?.status?.SuccessValue !== undefined; }
function failureTx(tx) { return tx?.status?.Failure !== undefined; }
function errorText(tx) { return JSON.stringify(tx?.status?.Failure || {}); }

function verifyChecksums(dir) {
  const manifest = readFile(dir, 'SHA256SUMS').toString('utf8').trim().split('\n').filter(Boolean);
  const seen = new Set();
  for (const line of manifest) {
    const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/);
    requireValue(match, `malformed SHA256SUMS line: ${line}`);
    const [, expected, name] = match;
    const file = path.join(dir, name);
    requireValue(fs.existsSync(file), `missing evidence artifact: ${name}`);
    requireValue(sha256(fs.readFileSync(file)) === expected, `checksum mismatch: ${name}`);
    seen.add(name);
  }
  for (const name of ['base.wasm', 'candidate.wasm', 'node-evidence.json', 'provenance.json', 'rust-result.txt', 'rust-evidence.jsonl', 'authority-probe.json', 'wrong-hash-probe.json', 'artifacts.json']) {
    requireValue(seen.has(name), `SHA256SUMS is missing ${name}`);
    requireValue(fs.existsSync(path.join(dir, name)), `missing evidence file: ${name}`);
  }
}

function validateRaw(dir) {
  verifyChecksums(dir);
  const artifacts = readJson(dir, 'artifacts.json');
  const node = readJson(dir, 'node-evidence.json');
  const provenance = readJson(dir, 'provenance.json');
  const authority = readJson(dir, 'authority-probe.json');
  const wrongHash = readJson(dir, 'wrong-hash-probe.json');
  const rustResult = readFile(dir, 'rust-result.txt').toString('utf8');
  const rust = readFile(dir, 'rust-evidence.jsonl').toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

  requireValue(sha256(readFile(dir, 'base.wasm')) === artifacts.base.sha256, 'base WASM hash does not match artifacts.json');
  requireValue(sha256(readFile(dir, 'candidate.wasm')) === artifacts.candidate.sha256, 'candidate WASM hash does not match artifacts.json');
  requireValue(artifacts.base.bytes === readFile(dir, 'base.wasm').length, 'base WASM byte count mismatch');
  requireValue(artifacts.candidate.bytes === readFile(dir, 'candidate.wasm').length, 'candidate WASM byte count mismatch');
  requireValue(node.inputs?.baseSha256 === artifacts.base.sha256, 'Node base input hash mismatch');
  requireValue(node.inputs?.candidateSha256 === artifacts.candidate.sha256, 'Node candidate input hash mismatch');
  requireValue(node.codeSha256 === artifacts.candidate.sha256, 'deployed code hash does not equal candidate hash');

  requireValue(node.status === 'passed' && node.stage === 'complete', 'Node evidence is not a complete pass');
  requireValue(node.mode === 'local-configured-factory-update', 'unexpected execution mode');
  requireValue(node.governanceUpgradeSelf === false && node.callbackFlow === false, 'governance/callback boundary is not false');
  requireValue(provenance.mode === 'local-configured-factory-update', 'provenance mode mismatch');
  requireValue(provenance.harnessCommit === '3898440e5caa2d0351720ed990eee9f6678664b2', 'unexpected harness commit');
  requireValue(provenance.state?.includes('locally constructed'), 'state is not labelled locally constructed');
  requireValue(/1 passed; 0 failed/.test(rustResult), 'native result does not report 1 passed, 0 failed');

  const contract = node.contract;
  const root = node.factory?.initializedBy;
  const recipientId = node.recipient?.accountId;
  requireValue(typeof contract === 'string' && contract, 'missing contract account');
  requireValue(typeof root === 'string' && root, 'missing configured factory/root account');
  requireValue(typeof recipientId === 'string' && recipientId, 'missing recipient account');

  const successStages = ['deploy', 'init', 'addProposal', 'update', 'approve'];
  const failureStages = ['replay', 'finalizeRetry'];
  for (const name of successStages) {
    const tx = node.transactions?.[name];
    requireValue(tx, `missing required-success transaction: ${name}`);
    requireValue(successTx(tx), `unexpected top-level failure on required-success stage: ${name}`);
    const receipts = tx.receipts_outcome || [];
    requireValue(receipts.length > 0, `required-success stage has no receipts: ${name}`);
    requireValue(receipts.every(successReceipt), `required-success child receipt failed: ${name}`);
    requireValue(tx.transaction?.receiver_id === contract, `required-success transaction has wrong contract receiver: ${name}`);
    requireValue(tx.transaction?.signer_id === (name === 'deploy' ? contract : root), `required-success transaction has wrong signer: ${name}`);
    requireValue(receipts.every((receipt) => [contract, root, recipientId].includes(receipt.outcome?.executor_id)), `receipt executor is outside contract/actor context: ${name}`);
    if (name === 'approve') {
      requireValue(receipts.some((receipt) => receipt.outcome?.executor_id === recipientId && successReceipt(receipt)), 'approve has no successful beneficiary receipt');
    }
    if (name === 'update') {
      requireValue(receipts.some((receipt) => (receipt.outcome?.logs || []).some((log) => /Contract state version: V2/.test(log))), 'update receipt graph lacks migration V2 log');
    }
  }
  for (const name of failureStages) {
    const tx = node.transactions?.[name];
    requireValue(tx, `missing expected-failure transaction: ${name}`);
    requireValue(failureTx(tx), `falsely successful replay stage: ${name}`);
    requireValue(/ERR_[A-Z_]+/.test(errorText(tx)), `retry failure for ${name} lacks a contract error`);
    const receipts = tx.receipts_outcome || [];
    requireValue(receipts.length > 0 && receipts.every(failureReceipt), `retry receipt graph is not an execution failure: ${name}`);
    requireValue(receipts.every((receipt) => receipt.outcome?.executor_id === contract), `retry receipt graph leaves contract context: ${name}`);
    requireValue(!receipts.some((receipt) => receipt.outcome?.executor_id === recipientId), `retry produced a beneficiary receipt: ${name}`);
  }
  requireValue(/ERR_PROPOSAL_NOT_READY_FOR_VOTE/.test(errorText(node.transactions.replay)), 'duplicate approval did not fail at the expected policy check');
  requireValue(/ERR_PROPOSAL_NOT_IN_PROGRESS/.test(errorText(node.transactions.finalizeRetry)), 'Finalize retry did not fail at the expected policy check');

  const expectedFinality = ['deploy', 'init', 'add-proposal', 'update', 'approve', 'replay', 'finalize-retry'];
  const finality = node.finality || {};
  requireValue(Object.keys(finality).sort().join('|') === [...expectedFinality].sort().join('|'), 'finality stages do not match the recorded stages');
  let previousTarget = 0;
  for (const name of expectedFinality) {
    const entry = finality[name];
    requireValue(entry, `missing finality barrier: ${name}`);
    requireValue(Number.isInteger(entry.target) && entry.target > 0, `invalid finality target: ${name}`);
    requireValue(Number.isInteger(entry.finalized) && entry.finalized > 0, `invalid finalized height: ${name}`);
    requireValue(Number.isInteger(entry.waitedMs) && entry.waitedMs >= 0, `invalid finality wait: ${name}`);
    requireValue(entry.target >= previousTarget, `finality targets are out of order at ${name}`);
    requireValue(entry.finalized >= entry.target, `inconsistent finality: ${name} finalized ${entry.finalized} < target ${entry.target}`);
    previousTarget = entry.target;
  }

  requireValue(JSON.stringify(node.configBefore) === JSON.stringify(node.configAfter), 'DAO config changed across upgrade');
  requireValue(node.proposalBefore?.id === node.proposalId && node.proposalAfter?.id === node.proposalId && node.proposalAfterUpgrade?.id === node.proposalId && node.proposalAfterReplay?.id === node.proposalId && node.proposalAfterFinalizeRetry?.id === node.proposalId, 'proposal ID is not consistent across states');
  requireValue(node.proposalBefore?.proposer === root, 'proposal proposer does not match configured root');
  requireValue(node.proposalBefore?.status === 'InProgress', 'pre-upgrade proposal is not InProgress');
  requireValue(node.proposalAfterUpgrade?.status === 'InProgress', 'proposal did not survive migration as InProgress');
  requireValue(node.proposalAfter?.status === 'Approved', 'proposal is not Approved after first approval');
  requireValue(node.proposalAfterReplay?.status === 'Approved', 'duplicate approval changed proposal status');
  requireValue(node.proposalAfterFinalizeRetry?.status === 'Approved', 'Finalize retry changed proposal status');
  requireValue(node.proposalAfter?.votes?.[root] === 'Approve', 'root vote did not persist');
  requireValue(node.proposalAfterReplay?.votes?.[root] === 'Approve', 'duplicate approval changed root vote');
  requireValue(node.proposalAfterFinalizeRetry?.votes?.[root] === 'Approve', 'Finalize retry changed root vote');

  const proposalReceiver = node.proposalBefore?.kind?.Transfer?.receiver_id;
  const proposalAmount = node.proposalBefore?.kind?.Transfer?.amount;
  requireValue(proposalReceiver === recipientId, 'recipient account is not bound to the proposal receiver');
  requireValue(proposalAmount === '1000000000000000000000000', 'proposal amount is not exactly 1 NEAR');
  for (const [state, proposal] of [
    ['after upgrade', node.proposalAfterUpgrade],
    ['after approval', node.proposalAfter],
    ['after duplicate vote', node.proposalAfterReplay],
    ['after Finalize retry', node.proposalAfterFinalizeRetry],
  ]) {
    requireValue(proposal?.kind?.Transfer?.receiver_id === recipientId, `proposal receiver changed ${state}`);
    requireValue(proposal?.kind?.Transfer?.amount === proposalAmount, `proposal amount changed ${state}`);
  }

  const oneNear = 1000000000000000000000000n;
  const recipient = node.recipient || {};
  requireValue(recipient.accountId === proposalReceiver, 'claimed balance account is not the proposal beneficiary');
  requireValue(BigInt(recipient.delta) === oneNear, 'first payment delta is not exactly 1 NEAR');
  requireValue(BigInt(recipient.after) - BigInt(recipient.before) === oneNear, 'recipient after-first balance does not prove exactly 1 NEAR');
  requireValue(BigInt(recipient.afterReplay) === BigInt(recipient.after), 'duplicate approval caused a second transfer');
  requireValue(BigInt(recipient.afterFinalizeRetry) === BigInt(recipient.after), 'Finalize retry caused a second transfer');
  requireValue(BigInt(recipient.deltaTotal) === oneNear, 'total recipient delta is not exactly 1 NEAR');
  requireValue(node.replay?.duplicateApproval?.transactionFailed === true && node.replay?.duplicateApproval?.transactionSucceeded === false, 'duplicate approval evidence is not a rejected transaction');
  requireValue(node.replay?.duplicateApproval?.secondTransfer === false, 'duplicate approval evidence claims a second transfer');
  requireValue(node.replay?.finalizeRetry?.transactionFailed === true && node.replay?.finalizeRetry?.transactionSucceeded === false, 'Finalize retry evidence is not a rejected transaction');
  requireValue(node.replay?.finalizeRetry?.secondTransfer === false, 'Finalize retry evidence claims a second transfer');

  const rustStages = new Map(rust.map((row) => [row.stage, row.execution || '']));
  for (const name of ['deploy', 'init', 'add_proposal', 'update', 'approve']) {
    requireValue(rustStages.has(name), `native evidence missing ${name}`);
    requireValue(!/status: Failure/.test(rustStages.get(name)), `unexpected native failure at ${name}`);
  }
  requireValue(rustStages.has('replay') && /status: Failure/.test(rustStages.get('replay')), 'native duplicate approval was not rejected');
  requireValue(rustStages.has('finalize_retry') && /status: Failure/.test(rustStages.get('finalize_retry')), 'native Finalize retry was not rejected');
  requireValue(rustStages.has('complete'), 'native evidence has no complete stage');

  requireValue(authority.status === 'passed', 'authority negative control did not pass');
  requireValue(/ERR_MUST_BE_SELF_OR_FACTORY/.test(errorText(authority.denial)), 'authority negative control lacks denial error');
  requireValue(wrongHash.status === 'failed' && wrongHash.stage === 'inputs', 'wrong-hash control did not fail before inputs');
  requireValue(Object.keys(wrongHash.transactions || {}).length === 0, 'wrong-hash control unexpectedly executed transactions');

  return {artifacts, node, provenance, authority, wrongHash, rustResult, rust, root, contract, recipientId, oneNear};
}

function derivePacket(evidenceDir, generatedAt) {
  const v = validateRaw(evidenceDir);
  const {artifacts, node, provenance, authority, wrongHash, rustResult, rust} = v;
  const recipient = node.recipient;
  const transfer = BigInt(recipient.delta);
  const afterReplay = BigInt(recipient.afterReplay);
  const afterFinalize = BigInt(recipient.afterFinalizeRetry);
  const rootVote = node.proposalAfter?.votes?.[v.root] || 'Approve';
  const stage = (id, label, tx, finalityKey, detail) => ({
    id,
    label,
    transaction: tx?.transaction?.hash || null,
    result: successTx(tx) ? 'success' : failureTx(tx) ? 'failure' : 'unknown',
    error: failureTx(tx) ? errorText(tx) : null,
    finality: node.finality?.[finalityKey] || null,
    detail,
  });
  const stages = [
    stage('deploy', 'Deploy base WASM', node.transactions.deploy, 'deploy', 'Source-built base deployed to the local Sandbox.'),
    stage('init', 'Initialize through root', node.transactions.init, 'init', 'Root is persisted as FactoryInfo.factory_id; this is a configured test factory.'),
    stage('addProposal', 'Create inherited proposal', node.transactions.addProposal, 'add-proposal', 'Proposal 0 exists before the upgrade, status InProgress.'),
    stage('update', 'Configured-factory update', node.transactions.update, 'update', 'Root calls update(candidate bytes); candidate deployed and migrate() runs.'),
    stage('approve', 'First approval', node.transactions.approve, 'approve', 'Root VoteApprove; proposal becomes Approved; exactly 1 local NEAR is paid.'),
    stage('replay', 'Retry VoteApprove', node.transactions.replay, 'replay', 'Rejected after Approved; no second transfer.'),
    stage('finalizeRetry', 'Retry Finalize', node.transactions.finalizeRetry, 'finalize-retry', 'Rejected because policy::proposal_status only accepts InProgress/Failed; no second transfer.'),
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
  return {
    schema: 'near-rehearsal/review-packet/sputnik-226/v1',
    generatedFrom: '92c338a40b24d60e428e6ca94c0110c64c4b690c',
    generatedAt,
    label: 'Recorded case review',
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
      rootVote,
      configUnchanged: JSON.stringify(node.configBefore) === JSON.stringify(node.configAfter),
      recipientBefore: formatNear(recipient.before),
      recipientAfterFirst: formatNear(recipient.after),
      recipientAfterReplay: formatNear(recipient.afterReplay),
      recipientAfterFinalizeRetry: formatNear(recipient.afterFinalizeRetry),
      firstPaymentNear: formatNear(transfer),
      totalDeltaNear: formatNear(BigInt(recipient.deltaTotal)),
      retries: [
        {id: 'replay', label: 'Duplicate VoteApprove', status: 'rejected', error: errorText(node.transactions.replay)},
        {id: 'finalizeRetry', label: 'Finalize retry', status: 'rejected', error: errorText(node.transactions.finalizeRetry)},
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
      comparisonBoundaries: (provenance.comparisonBoundaries || []).filter((item) => !/refund/i.test(item)),
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
      nativeEvidenceStages: rust.map((row) => row.stage),
      configUnchanged: JSON.stringify(node.configBefore) === JSON.stringify(node.configAfter),
      proposalSurvived: node.proposalBefore.status === 'InProgress' && node.proposalAfterUpgrade.status === 'InProgress',
      firstPaymentExact: transfer === v.oneNear,
      bothRetriesRejected: node.replay?.duplicateApproval?.transactionFailed === true && node.replay?.finalizeRetry?.transactionFailed === true,
      noSecondTransfer: afterReplay === afterFinalize && afterFinalize - BigInt(recipient.before) === transfer,
      finalityTargetsReached: Object.values(node.finality || {}).every((entry) => Number.isInteger(entry.target) && Number.isInteger(entry.finalized) && entry.target > 0 && entry.finalized >= entry.target),
      receiptGraphsSucceeded: ['deploy', 'init', 'addProposal', 'update', 'approve'].every((name) => (node.transactions[name].receipts_outcome || []).every(successReceipt)),
     
    },
    negativeControls: [
      {label: 'Hash rejected', status: 'rejected', detail: 'Wrong candidate hash rejected at the inputs stage before any Sandbox transaction.', link: 'evidence/wrong-hash-probe.json'},
      {label: 'Unconfigured caller denied', status: 'denied', detail: 'Separate probe: upgrade denied with ERR_MUST_BE_SELF_OR_FACTORY; code and config unchanged.', link: 'evidence/authority-probe.json'},
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
      'Local historical-source pilot, not current product integration.',
      'No maintainer acceptance, measured preference, time saving, or production safety claim.',
      'Native near-workspaces can express the same invariant; the hypothesis is reviewer effort and packaging, not a unique execution primitive.',
    ],
  };
}

function verifyPacket(root) {
  const evidenceDir = path.join(root, 'evidence');
  const packetPath = path.join(root, 'data', 'packet.json');
  requireValue(fs.existsSync(packetPath), 'missing data/packet.json');
  const actual = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
  requireValue(typeof actual.generatedAt === 'string', 'packet generatedAt is missing');
  const expected = derivePacket(evidenceDir, actual.generatedAt);
  try {
    assert.deepStrictEqual(actual, expected);
  } catch (error) {
    throw new Error(`displayed packet facts do not match canonical evidence: ${error.message.slice(0, 500)}`);
  }
  return expected;
}

module.exports = {derivePacket, validateRaw, verifyPacket, formatNear, sha256};
