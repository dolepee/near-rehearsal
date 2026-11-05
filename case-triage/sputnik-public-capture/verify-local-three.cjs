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
const required = (o, keys, label) => { for (const k of keys) if (!(k in (o || {}))) fail(`${label} missing ${k}`); };
const asString = (v, label) => { if (typeof v !== 'string' || !v.length) fail(`${label} must be a non-empty string`); return v; };
const asYocto = (v, label) => { try { return BigInt(asString(v, label)); } catch { fail(`${label} is not an integer yocto string`); } };
const recognized = (s) => s && ['SuccessValue', 'SuccessReceiptId', 'Failure'].some((k) => Object.prototype.hasOwnProperty.call(s, k));

required(result, ['schema', 'frozenBundle', 'artifacts', 'branches', 'sameStartingState', 'comparison', 'primaryComparison'], 'result');
if (result.schema !== 'near-rehearsal/local-sputnik-three-branch/v3') fail('result schema mismatch');
if (result.frozenBundle.stateHash !== bundle.stateHash) fail('frozen bundle state hash mismatch');
if (result.frozenBundle.codeHash !== bundle.codeHash) fail('frozen bundle code hash mismatch');
if (result.frozenBundle.contractBalance !== bundle.contractAccount.amount) fail('frozen contract balance mismatch');
if (result.frozenBundle.actorBalance !== bundle.actorAccount.amount) fail('frozen actor balance mismatch');
if (result.frozenBundle.recipientBalance !== bundle.recipientAmount) fail('frozen recipient balance mismatch');
for (const k of ['base', 'candidate', 'seededBad']) {
  required(result.artifacts, [k], 'artifacts');
  if (result.artifacts[k].sha256 !== bundle.artifacts[`${k}Sha256`]) fail(`artifact ${k} sha256 mismatch`);
  if (result.artifacts[k].hash !== bundle.artifacts[`${k}Hash`]) fail(`artifact ${k} code hash mismatch`);
}
if (!result.artifacts.seededBad.label.includes('SEEDED')) fail('seeded bad artifact is not labelled');

const branchNames = ['baseline', 'candidate', 'corrected', 'recoveryExperiment'];
for (const n of branchNames) required(result.branches, [n], 'branches');
const unit = 10n ** 24n;
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

function checkPayout(b, first, after, before, label) {
  if (!first || !after || !before) fail(`${label} missing before/after`);
  if (first.succeeded !== true || first.failed !== false) fail(`${label} obligation failed`);
  if (BigInt(after.recipientBalance) - BigInt(before.recipientBalance) !== unit) fail(`${label} payout not exactly 1 NEAR`);
}
const baseline = result.branches.baseline;
tx(baseline.first, 'success', 'baseline.first', bundle.identities.proposer);
tx(baseline.retry, 'failure', 'baseline.retry', bundle.identities.proposer);
if (baseline.checks.operationSucceeded !== true || baseline.checks.retryFailed !== true || baseline.checks.retryDidNotPay !== true) fail('baseline stored checks fail');
checkPayout(baseline, baseline.first, baseline.afterFirst, baseline.before, 'baseline');

const candidate = result.branches.candidate;
tx(candidate.upgrade, 'success', 'candidate.upgrade', bundle.identities.factory);
tx(candidate.first, 'success', 'candidate.first', bundle.identities.proposer);
tx(candidate.retry, 'failure', 'candidate.retry', bundle.identities.proposer);
if (candidate.afterUpgrade.codeHash !== bundle.artifacts.candidateHash) fail('candidate code not deployed');
if (candidate.checks.upgradeSucceeded !== true || candidate.checks.candidateCode !== true || candidate.checks.operationSucceeded !== true || candidate.checks.retryFailed !== true || candidate.checks.retryDidNotPay !== true) fail('candidate stored checks fail');
checkPayout(candidate, candidate.first, candidate.afterFirst, candidate.before, 'candidate');

const corrected = result.branches.corrected;
tx(corrected.upgrade, 'success', 'corrected.upgrade', bundle.identities.factory);
tx(corrected.first, 'success', 'corrected.first', bundle.identities.proposer);
tx(corrected.retry, 'failure', 'corrected.retry', bundle.identities.proposer);
if (corrected.afterUpgrade.codeHash !== bundle.artifacts.candidateHash) fail('corrected code not deployed');
if (corrected.checks.upgradeSucceeded !== true || corrected.checks.correctedCode !== true || corrected.checks.operationSucceeded !== true || corrected.checks.retryFailed !== true || corrected.checks.retryDidNotPay !== true) fail('corrected stored checks fail');
checkPayout(corrected, corrected.first, corrected.afterFirst, corrected.before, 'corrected');

const recovery = result.branches.recoveryExperiment;
tx(recovery.badUpgrade, 'success', 'recovery.badUpgrade', bundle.identities.factory);
tx(recovery.badOperation, 'failure', 'recovery.badOperation', bundle.identities.proposer);
tx(recovery.correctedUpgrade, 'success', 'recovery.correctedUpgrade', bundle.identities.factory);
tx(recovery.correctedOperation, 'success', 'recovery.correctedOperation', bundle.identities.proposer);
tx(recovery.correctedRetry, 'failure', 'recovery.correctedRetry', bundle.identities.proposer);
if (recovery.afterBadUpgrade.codeHash !== bundle.artifacts.seededBadHash) fail('seeded bad code not deployed');
if (recovery.afterCorrectedUpgrade.codeHash !== bundle.artifacts.candidateHash) fail('recovery corrected code not deployed');
if (recovery.badOperation.failed !== true || recovery.badOperation.succeeded !== false) fail('seeded bad operation did not fail');
if (BigInt(recovery.afterBadOperation.recipientBalance) !== BigInt(recovery.before.recipientBalance)) fail('seeded bad operation paid');
if (recovery.checks.seededBadUpgradeSucceeded !== true || recovery.checks.seededBadCode !== true || recovery.checks.seededBadOperationFailed !== true || recovery.checks.seededBadDidNotPay !== true || recovery.checks.correctionSucceeded !== true || recovery.checks.correctedOperationSucceeded !== true || recovery.checks.correctedRetryFailed !== true || recovery.checks.correctedRetryDidNotPay !== true) fail('recovery stored checks fail');
checkPayout(recovery, recovery.correctedOperation, recovery.afterCorrectedOperation, recovery.before, 'recovery');

const expected = {
  baseline: 'preserved',
  candidate: 'preserved',
  corrected: 'preserved',
  recoveryExperiment: 'improved',
};
for (const n of branchNames) if (result.branches[n].status !== expected[n]) fail(`${n} verdict is not ${expected[n]}`);
if (!result.sameStartingState) fail('sameStartingState is false');
if (result.primaryComparison.from !== 'frozen old state' || result.primaryComparison.baseline !== 'preserved' || result.primaryComparison.corrected !== 'preserved' || result.primaryComparison.sameStartingState !== true) fail('primary comparison is not frozen-old → corrected');
if (result.comparison.baseline !== 'preserved' || result.comparison.corrected !== 'preserved' || result.comparison.recoveryExperiment !== 'improved') fail('comparison summary mismatch');

const verdict = {
  schema: 'near-rehearsal/local-sputnik-three-branch-verdict/v1',
  verdict: 'local-three-branch-verified',
  frozenBundle: result.frozenBundle,
  artifacts: result.artifacts,
  primaryComparison: result.primaryComparison,
  comparison: result.comparison,
  branches: Object.fromEntries(branchNames.map((n) => [n, { status: result.branches[n].status, checks: result.branches[n].checks, localBlock: result.branches[n].localBlock }])),
  limitations: [
    'Local Sandbox only; no public write, production key, deploy, merge or recovery.',
    'The fixture is a local source-built Sputnik old proposal on a configured factory route, not the public captured DAO and not a production upgrade.',
    'All branches import the same frozen raw code/state/account bundle; local block timestamps differ and are recorded.',
    'The seeded bad candidate is a labelled execution fixture, not a historical release: its act_proposal body is unreachable.',
    'Payout is exactly 1 NEAR to the frozen recipient; retry and unauthorized/negative paths are recorded separately.',
  ],
};
fs.writeFileSync(path.join(OUT, 'local-three-verdict.json'), json(verdict));
console.log(json({ verdict: verdict.verdict, primary: verdict.primaryComparison, comparison: verdict.comparison }));
