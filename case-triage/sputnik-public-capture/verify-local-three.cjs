'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashContract } = require('near-workspaces');
const HERE = process.env.CASE_DIR ? path.resolve(process.env.CASE_DIR) : __dirname;
const OUT = path.join(HERE, 'out');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const fail = (m) => { throw new Error(m); };
const read = (n) => JSON.parse(fs.readFileSync(path.join(OUT, n), 'utf8'));
const result = read('local-three-branch.json');
const bundle = read('local-frozen-bundle.json');
const family = JSON.parse(fs.readFileSync(path.join(HERE, 'supported-family.json'), 'utf8'));
const required = (o, keys, label) => { for (const k of keys) if (!(k in (o || {}))) fail(`${label} missing ${k}`); };
const asString = (v, label) => { if (typeof v !== 'string' || !v.length) fail(`${label} must be a non-empty string`); return v; };
const asYocto = (v, label) => { try { return BigInt(asString(v, label)); } catch { fail(`${label} is not an integer yocto string`); } };
const recognized = (s) => s && ['SuccessValue', 'SuccessReceiptId', 'Failure'].some((k) => Object.prototype.hasOwnProperty.call(s, k));
const unit = 10n ** 24n;

required(result, ['schema', 'status', 'completed', 'frozenBundle', 'artifacts', 'branches', 'sameStartingState', 'comparison', 'primaryComparison'], 'result');
if (result.schema !== 'near-rehearsal/local-sputnik-three-branch/v4') fail('result schema mismatch');
if (result.status !== 'complete' || result.completed !== true) fail('result is not a completed report');
if (result.frozenBundle.stateHash !== bundle.stateHash) fail('frozen bundle state hash mismatch');
if (result.frozenBundle.codeHash !== bundle.codeHash) fail('frozen bundle code hash mismatch');
if (result.frozenBundle.contractBalance !== bundle.contractAccount.amount) fail('frozen contract balance mismatch');
if (result.frozenBundle.actorBalance !== bundle.actorAccount.amount) fail('frozen actor balance mismatch');
if (result.frozenBundle.recipientBalance !== bundle.recipientAmount) fail('frozen recipient balance mismatch');
for (const [role, key] of [['base', 'base'], ['candidate', 'candidate'], ['corrected', 'corrected']]) {
  required(result.artifacts, [role], 'artifacts');
  const expected = family.artifacts[role];
  if (!expected) fail(`family manifest missing ${role}`);
  if (result.artifacts[role].sha256 !== expected.sha256) fail(`${role} artifact sha256 mismatch`);
  if (result.artifacts[role].hash !== bundle.artifacts[`${key}Hash`]) fail(`${role} artifact code hash mismatch`);
}
if (result.artifacts.candidate.role !== 'seeded-bad') fail('candidate artifact is not labelled seeded-bad');
if (result.artifacts.corrected.role !== 'verified-good') fail('correction artifact is not labelled verified-good');
if (!result.artifacts.candidate.label.includes('SEEDED')) fail('candidate label does not identify the seeded fixture');

const expectedNames = ['baseline', 'candidate', 'corrected'];
for (const n of expectedNames) required(result.branches, [n], 'branches');
const branchNames = Object.keys(result.branches);
for (const n of branchNames) if (![...expectedNames, 'recoveryExperiment'].includes(n)) fail(`unexpected branch ${n}`);

function tx(t, expected, label, signer) {
  required(t, ['transactionHash', 'finalExecutionStatus', 'transaction', 'receiptIds', 'receipts', 'transactionOutcomeStatus', 'succeeded', 'failed', 'gasBurntUnits', 'transactionOutcomeTokensBurntYocto', 'receiptTokensBurntYocto', 'totalTokensBurntYocto'], label);
  asString(t.transactionHash, `${label}.transactionHash`);
  if (t.finalExecutionStatus !== 'FINAL') fail(`${label} is not FINAL`);
  required(t.transaction, ['signerId', 'receiverId', 'actions'], `${label}.transaction`);
  asString(t.transaction.signerId, `${label}.transaction.signerId`);
  asString(t.transaction.receiverId, `${label}.transaction.receiverId`);
  if (t.transaction.receiverId !== bundle.identities.contract) fail(`${label} receiver is not frozen contract`);
  if (signer && t.transaction.signerId !== signer) fail(`${label} signer mismatch`);
  if (!Array.isArray(t.transaction.actions) || t.transaction.actions.length === 0) fail(`${label} has no actions`);
  if (!Array.isArray(t.receiptIds) || t.receiptIds.length === 0) fail(`${label} has no outcome receipt ids`);
  if (!Array.isArray(t.receipts) || t.receipts.length === 0) fail(`${label} has no receipts`);
  if (!recognized(t.transactionOutcomeStatus)) fail(`${label} has no recognized transaction outcome`);
  const allowed = new Set([bundle.identities.contract, bundle.identities.proposer, bundle.identities.recipient, bundle.identities.factory, t.transaction.signerId, t.transaction.receiverId]);
  for (const r of t.receipts) {
    if (!r.id) fail(`${label} receipt missing id`);
    if (!r.blockHash) fail(`${label} receipt missing block hash`);
    if (!Array.isArray(r.receiptIds)) fail(`${label} receipt missing child ids`);
    if (!recognized(r.status)) fail(`${label} receipt status not recognized`);
    if (!allowed.has(r.executorId)) fail(`${label} receipt executor unbound: ${r.executorId}`);
  }
  if (!t.receiptIds.some((id) => t.receipts.some((r) => r.id === id))) fail(`${label} receipt graph not closed`);
  if (!t.receipts.some((r) => r.executorId === bundle.identities.contract)) fail(`${label} no contract receipt`);
  if (expected === 'success') {
    if (t.succeeded !== true || t.failed !== false || t.failure) fail(`${label} did not succeed`);
    if (t.receipts.some((r) => r.status?.Failure)) fail(`${label} has failed child receipt`);
  } else {
    if (t.succeeded !== false || t.failed !== true || !t.failure) fail(`${label} did not fail`);
    if (!t.receipts.some((r) => r.status?.Failure)) fail(`${label} has no failed child receipt`);
  }
  asYocto(t.transactionOutcomeTokensBurntYocto, `${label}.transactionOutcomeTokensBurntYocto`);
  asYocto(t.receiptTokensBurntYocto, `${label}.receiptTokensBurntYocto`);
  asYocto(t.totalTokensBurntYocto, `${label}.totalTokensBurntYocto`);
  if (BigInt(t.transactionOutcomeTokensBurntYocto) + BigInt(t.receiptTokensBurntYocto) !== BigInt(t.totalTokensBurntYocto)) fail(`${label} token totals disagree`);
  asString(t.gasBurntUnits, `${label}.gasBurntUnits`);
}
function initialFacts(b, label) {
  required(b, ['initial', 'localBlock', 'checks'], label);
  required(b.initial, ['codeHash', 'stateHash', 'contractBalance', 'actorBalance', 'recipientBalance', 'policy', 'proposal'], `${label}.initial`);
  if (b.initial.codeHash !== bundle.codeHash) fail(`${label} initial code mismatch`);
  if (b.initial.stateHash !== bundle.stateHash) fail(`${label} initial state mismatch`);
  if (b.initial.contractBalance !== bundle.contractAccount.amount) fail(`${label} initial contract balance mismatch`);
  if (b.initial.actorBalance !== bundle.actorAccount.amount) fail(`${label} initial actor balance mismatch`);
  if (b.initial.recipientBalance !== bundle.recipientAmount) fail(`${label} initial recipient balance mismatch`);
  if (JSON.stringify(b.initial.policy) !== JSON.stringify(bundle.policy)) fail(`${label} initial policy mismatch`);
  if (JSON.stringify(b.initial.proposal) !== JSON.stringify(bundle.proposal)) fail(`${label} initial proposal mismatch`);
  if (!b.localBlock?.hash || b.localBlock?.height === undefined || !b.localBlock?.timestamp) fail(`${label} local block context missing`);
  const facts = { codeHash: b.initial.codeHash, stateHash: b.initial.stateHash, contractBalance: b.initial.contractBalance, actorBalance: b.initial.actorBalance, recipientBalance: b.initial.recipientBalance, policy: b.initial.policy, proposal: b.initial.proposal, identities: { contract: bundle.identities.contract, proposer: bundle.identities.proposer, recipient: bundle.identities.recipient, factory: bundle.identities.factory } };
  const hash = sha256(JSON.stringify(facts));
  if (b.checks.initialFacts !== hash) fail(`${label} initial facts hash mismatch`);
  return hash;
}
const initialHashes = branchNames.map((n) => initialFacts(result.branches[n], n));
if (new Set(initialHashes).size !== 1) fail('branches do not share initial facts');

function payout(b, first, after, before, label) {
  if (!first || !after || !before) fail(`${label} missing before/after`);
  if (first.succeeded !== true || first.failed !== false) fail(`${label} obligation failed`);
  if (BigInt(after.recipientBalance) - BigInt(before.recipientBalance) !== unit) fail(`${label} payout not exactly 1 NEAR`);
}
const baseline = result.branches.baseline;
tx(baseline.first, 'success', 'baseline.first', bundle.identities.proposer);
tx(baseline.retry, 'failure', 'baseline.retry', bundle.identities.proposer);
if (baseline.status !== 'preserved' || baseline.checks.operationSucceeded !== true || baseline.checks.retryFailed !== true || baseline.checks.retryDidNotPay !== true) fail('baseline did not preserve the obligation');
payout(baseline, baseline.first, baseline.afterFirst, baseline.before, 'baseline');

const candidate = result.branches.candidate;
tx(candidate.upgrade, 'success', 'candidate.upgrade', bundle.identities.factory);
tx(candidate.first, 'failure', 'candidate.first', bundle.identities.proposer);
tx(candidate.retry, 'failure', 'candidate.retry', bundle.identities.proposer);
if (candidate.afterUpgrade.codeHash !== result.artifacts.candidate.hash) fail('candidate code not deployed');
if (candidate.checks.upgradeSucceeded !== true || candidate.checks.candidateCode !== true || candidate.checks.operationRegressed !== true || candidate.checks.retryFailed !== true) fail('candidate did not show the declared regression');
if (BigInt(candidate.afterFirst.recipientBalance) !== BigInt(candidate.before.recipientBalance)) fail('seeded candidate paid the recipient');
if (candidate.status !== 'regressed') fail('seeded candidate verdict is not regressed');
if (!candidate.first.failure) fail('candidate failure reason was not preserved');

const corrected = result.branches.corrected;
tx(corrected.upgrade, 'success', 'corrected.upgrade', bundle.identities.factory);
tx(corrected.first, 'success', 'corrected.first', bundle.identities.proposer);
tx(corrected.retry, 'failure', 'corrected.retry', bundle.identities.proposer);
if (corrected.afterUpgrade.codeHash !== result.artifacts.corrected.hash) fail('corrected code not deployed');
if (corrected.checks.upgradeSucceeded !== true || corrected.checks.correctedCode !== true || corrected.checks.operationSucceeded !== true || corrected.checks.retryFailed !== true || corrected.checks.retryDidNotPay !== true) fail('corrected did not preserve the obligation');
payout(corrected, corrected.first, corrected.afterFirst, corrected.before, 'corrected');
if (corrected.status !== 'preserved') fail('corrected verdict is not preserved');

if (result.branches.recoveryExperiment) {
  const recovery = result.branches.recoveryExperiment;
  tx(recovery.badUpgrade, 'success', 'recovery.badUpgrade', bundle.identities.factory);
  tx(recovery.badOperation, 'failure', 'recovery.badOperation', bundle.identities.proposer);
  tx(recovery.correctedUpgrade, 'success', 'recovery.correctedUpgrade', bundle.identities.factory);
  tx(recovery.correctedOperation, 'success', 'recovery.correctedOperation', bundle.identities.proposer);
  tx(recovery.correctedRetry, 'failure', 'recovery.correctedRetry', bundle.identities.proposer);
  if (recovery.afterBadUpgrade.codeHash !== result.artifacts.candidate.hash) fail('recovery bad code mismatch');
  if (recovery.afterCorrectedUpgrade.codeHash !== result.artifacts.corrected.hash) fail('recovery corrected code mismatch');
  if (recovery.badOperation.failed !== true || recovery.badOperation.succeeded !== false) fail('recovery bad operation did not fail');
  if (BigInt(recovery.afterBadOperation.recipientBalance) !== BigInt(recovery.before.recipientBalance)) fail('recovery bad operation paid');
  if (recovery.status !== 'improved') fail('recovery experiment verdict is not improved');
}

if (!result.sameStartingState) fail('sameStartingState is false');
if (result.primaryComparison.from !== 'frozen old state' || result.primaryComparison.baseline !== 'preserved' || result.primaryComparison.candidate !== 'regressed' || result.primaryComparison.corrected !== 'preserved' || result.primaryComparison.sameStartingState !== true) fail('primary comparison is not frozen-old → seeded-regression → correction');
if (result.comparison.baseline !== 'preserved' || result.comparison.candidate !== 'regressed' || result.comparison.corrected !== 'preserved') fail('comparison summary mismatch');

const verdict = {
  schema: 'near-rehearsal/local-sputnik-three-branch-verdict/v2',
  verdict: 'local-three-branch-verified',
  status: 'complete',
  frozenBundle: result.frozenBundle,
  artifacts: result.artifacts,
  primaryComparison: result.primaryComparison,
  comparison: result.comparison,
  branches: Object.fromEntries(branchNames.map((n) => [n, { status: result.branches[n].status, checks: result.branches[n].checks, localBlock: result.branches[n].localBlock, failure: result.branches[n].first?.failure ?? result.branches[n].badOperation?.failure ?? null }])),
  limitations: family.limitations,
};
fs.writeFileSync(path.join(OUT, 'local-three-verdict.json'), json(verdict));
console.log(json({ verdict: verdict.verdict, primary: verdict.primaryComparison, comparison: verdict.comparison }));
