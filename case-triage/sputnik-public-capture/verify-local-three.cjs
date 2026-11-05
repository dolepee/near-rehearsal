'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const HERE = process.env.CASE_DIR ? path.resolve(process.env.CASE_DIR) : __dirname;
const OUT = path.join(HERE, 'out');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const fail = (m) => { throw new Error(m); };
const read = (n) => JSON.parse(fs.readFileSync(path.join(OUT, n), 'utf8'));
const result = read('local-three-branch.json');
const bundle = read('local-frozen-bundle.json');
const input = read('input-manifest.json');
const required = (o, keys, label) => { for (const k of keys) if (!(k in (o || {}))) fail(`${label} missing ${k}`); };
const asString = (v, label) => { if (typeof v !== 'string' || !v.length) fail(`${label} must be a non-empty string`); return v; };
const asYocto = (v, label) => { try { return BigInt(asString(v, label)); } catch { fail(`${label} is not an integer yocto string`); } };
const recognized = (s) => s && ['SuccessValue', 'SuccessReceiptId', 'Failure'].some((k) => Object.prototype.hasOwnProperty.call(s, k));
const unit = 10n ** 24n;

required(result, ['schema', 'status', 'completed', 'frozenBundle', 'inputManifest', 'artifacts', 'branches', 'sameStartingState', 'comparison', 'primaryComparison'], 'result');
if (result.schema !== 'near-rehearsal/local-sputnik-three-branch/v4') fail('result schema mismatch');
if (result.status !== 'complete' || result.completed !== true) fail('result is not a completed report');
if (result.frozenBundle.stateHash !== bundle.stateHash) fail('frozen state hash mismatch');
if (result.frozenBundle.codeHash !== bundle.codeHash) fail('frozen code hash mismatch');
if (result.frozenBundle.contractBalance !== bundle.contractAccount.amount) fail('frozen contract balance mismatch');
if (result.frozenBundle.actorBalance !== bundle.actorAccount.amount) fail('frozen actor balance mismatch');
if (result.frozenBundle.recipientBalance !== bundle.recipientAmount) fail('frozen recipient balance mismatch');
required(input, ['schema', 'candidate', 'correction'], 'input-manifest');
if (input.schema !== 'near-rehearsal/sputnik-input-manifest/v1') fail('input manifest schema mismatch');
for (const [role, artifactKey] of [['candidate', 'candidate'], ['correction', 'corrected']]) {
  required(input[role], ['sha256', 'bytes', 'label', 'provenance'], `input.${role}`);
  asString(input[role].sha256, `input.${role}.sha256`);
  asString(input[role].label, `input.${role}.label`);
  asString(input[role].provenance, `input.${role}.provenance`);
  if (input[role].bytes < 1 || input[role].bytes > 2 * 1024 * 1024) fail(`input.${role}.bytes outside supported size`);
  if (result.artifacts?.[artifactKey]?.sha256 !== input[role].sha256) fail(`${role} artifact does not bind input bytes`);
  if (result.artifacts?.[artifactKey]?.label !== input[role].label) fail(`${role} artifact label does not match input manifest`);
  if (result.artifacts?.[artifactKey]?.provenance !== input[role].provenance) fail(`${role} artifact provenance does not match input manifest`);
  if (!result.artifacts?.[artifactKey]?.hash) fail(`${role} artifact code hash missing`);
}
if (result.artifacts.candidate.role !== 'candidate') fail('candidate role is not candidate');
if (result.artifacts.corrected.role !== 'correction') fail('correction role is not correction');

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
  const receiptIds = new Set();
  for (const r of t.receipts) {
    if (!r.id) fail(`${label} receipt missing id`);
    receiptIds.add(r.id);
    if (!r.blockHash) fail(`${label} receipt missing block hash`);
    if (!Array.isArray(r.receiptIds)) fail(`${label} receipt missing child ids`);
    if (!recognized(r.status)) fail(`${label} receipt status not recognized`);
    if (!allowed.has(r.executorId)) fail(`${label} receipt executor unbound: ${r.executorId}`);
  }
  if (!t.receiptIds.some((id) => receiptIds.has(id))) fail(`${label} transaction outcome is not in receipt graph`);
  if (t.transactionOutcomeStatus?.SuccessReceiptId && !receiptIds.has(t.transactionOutcomeStatus.SuccessReceiptId)) fail(`${label} success receipt id is missing from graph`);
  for (const r of t.receipts) for (const child of r.receiptIds) if (!receiptIds.has(child)) fail(`${label} child receipt ${child} is missing from graph`);
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
  const facts = {codeHash: b.initial.codeHash, stateHash: b.initial.stateHash, contractBalance: b.initial.contractBalance, actorBalance: b.initial.actorBalance, recipientBalance: b.initial.recipientBalance, policy: b.initial.policy, proposal: b.initial.proposal, identities: {contract: bundle.identities.contract, proposer: bundle.identities.proposer, recipient: bundle.identities.recipient, factory: bundle.identities.factory}};
  const hash = sha256(JSON.stringify(facts));
  if (b.checks.initialFacts !== hash) fail(`${label} initial facts hash mismatch`);
  return hash;
}
const initialHashes = branchNames.map((n) => initialFacts(result.branches[n], n));
if (new Set(initialHashes).size !== 1) fail('branches do not share initial facts');

function retryBalances(b, label, keys = {retry: 'retry', first: 'afterFirst', after: 'afterRetry'}) {
  required(b, [keys.retry, keys.first, keys.after], label);
  for (const s of [b[keys.first], b[keys.after]]) for (const k of ['contractBalance', 'actorBalance', 'recipientBalance']) asYocto(s?.[k], `${label}.${k}`);
  tx(b[keys.retry], 'failure', `${label}.${keys.retry}`, bundle.identities.proposer);
  if (b[keys.after].recipientBalance !== b[keys.first].recipientBalance) fail(`${label} retry paid recipient`);
  const contractDelta = BigInt(b[keys.after].contractBalance) - BigInt(b[keys.first].contractBalance);
  const actorDelta = BigInt(b[keys.after].actorBalance) - BigInt(b[keys.first].actorBalance);
  if (contractDelta <= -unit / 2n) fail(`${label} retry lost bond-scale contract funds`);
  if (actorDelta > 0n) fail(`${label} retry increased proposer balance`);
  return {contractDeltaYocto: contractDelta.toString(), actorDeltaYocto: actorDelta.toString()};
}
function derivedStatus(b, role) {
  if (role !== 'baseline' && b.checks.upgradeSucceeded !== true) return 'inconclusive';
  if (role !== 'baseline' && b.afterUpgrade.codeHash !== result.artifacts[role === 'candidate' ? 'candidate' : 'corrected'].hash) return 'inconclusive';
  const first = b.first;
  if (!first) return 'inconclusive';
  const payout = b.before && b.afterFirst ? BigInt(b.afterFirst.recipientBalance) - BigInt(b.before.recipientBalance) : null;
  if (first.succeeded === true && first.failed === false && payout === unit) return 'preserved';
  if (first.failed === true && first.succeeded === false && payout === 0n && (first.receipts || []).some((r) => r.status?.Failure)) return 'regressed';
  return 'inconclusive';
}
const observed = {};
for (const n of expectedNames) observed[n] = derivedStatus(result.branches[n], n);
for (const n of expectedNames) {
  const b = result.branches[n];
  if (b.status !== observed[n]) fail(`${n} status ${b.status} contradicts derived ${observed[n]}`);
}
if (result.branches.baseline.status === 'inconclusive') fail('baseline is inconclusive');
const baseline = result.branches.baseline;
tx(baseline.first, 'success', 'baseline.first', bundle.identities.proposer);
retryBalances(baseline, 'baseline');
if (baseline.checks.retryDidNotPay !== true) fail('baseline retry check not true');

const candidate = result.branches.candidate;
if (candidate.afterUpgrade.codeHash !== result.artifacts.candidate.hash) fail('candidate code not deployed');
tx(candidate.upgrade, 'success', 'candidate.upgrade', bundle.identities.factory);
tx(candidate.first, candidate.status === 'regressed' ? 'failure' : 'success', 'candidate.first', bundle.identities.proposer);
retryBalances(candidate, 'candidate');
if (candidate.status === 'regressed' && BigInt(candidate.afterFirst.recipientBalance) !== BigInt(candidate.before.recipientBalance)) fail('regressed candidate paid recipient');

const corrected = result.branches.corrected;
if (corrected.afterUpgrade.codeHash !== result.artifacts.corrected.hash) fail('corrected code not deployed');
tx(corrected.upgrade, 'success', 'corrected.upgrade', bundle.identities.factory);
tx(corrected.first, corrected.status === 'regressed' ? 'failure' : 'success', 'corrected.first', bundle.identities.proposer);
retryBalances(corrected, 'corrected');

if (result.branches.recoveryExperiment) {
  const recovery = result.branches.recoveryExperiment;
  tx(recovery.badUpgrade, 'success', 'recovery.badUpgrade', bundle.identities.factory);
  tx(recovery.badOperation, 'failure', 'recovery.badOperation', bundle.identities.proposer);
  tx(recovery.correctedUpgrade, 'success', 'recovery.correctedUpgrade', bundle.identities.factory);
  tx(recovery.correctedOperation, 'success', 'recovery.correctedOperation', bundle.identities.proposer);
  retryBalances(recovery, 'recovery', {retry: 'correctedRetry', first: 'afterCorrectedOperation', after: 'afterCorrectedRetry'});
  if (recovery.afterBadUpgrade.codeHash !== result.artifacts.candidate.hash) fail('recovery bad code mismatch');
  if (recovery.afterCorrectedUpgrade.codeHash !== result.artifacts.corrected.hash) fail('recovery corrected code mismatch');
  if (recovery.badOperation.failed !== true || recovery.badOperation.succeeded !== false) fail('recovery bad operation did not fail');
  if (BigInt(recovery.afterBadOperation.recipientBalance) !== BigInt(recovery.before.recipientBalance)) fail('recovery bad operation paid');
}
if (!result.sameStartingState) fail('sameStartingState is false');
const derivedPrimary = {from: 'frozen old state', baseline: observed.baseline, candidate: observed.candidate, corrected: observed.corrected, sameStartingState: true};
const derivedComparison = {baseline: observed.baseline, candidate: observed.candidate, corrected: observed.corrected, ...(result.branches.recoveryExperiment ? {recoveryExperiment: result.branches.recoveryExperiment.status} : {}), sameStartingState: true};
if (JSON.stringify(result.primaryComparison) !== JSON.stringify(derivedPrimary)) fail('primary comparison does not match derived outcomes');
if (JSON.stringify(result.comparison) !== JSON.stringify(derivedComparison)) fail('comparison does not match derived outcomes');

const verdict = {
  schema: 'near-rehearsal/local-sputnik-three-branch-verdict/v3',
  verdict: 'local-three-branch-verified',
  status: 'complete',
  frozenBundle: result.frozenBundle,
  inputManifest: input,
  artifacts: result.artifacts,
  observed,
  primaryComparison: derivedPrimary,
  comparison: derivedComparison,
  branches: Object.fromEntries(branchNames.map((n) => [n, {status: result.branches[n].status, checks: result.branches[n].checks, localBlock: result.branches[n].localBlock, failure: result.branches[n].first?.failure ?? result.branches[n].badOperation?.failure ?? null, retryBalances: n === 'recoveryExperiment' ? undefined : {contractDeltaYocto: result.branches[n].checks.retryContractDeltaYocto, actorDeltaYocto: result.branches[n].checks.retryActorDeltaYocto}}])),
  limitations: [
    'Local Sandbox only; no public upgrade, deployment, production key or funds.',
    'Locally constructed configured-factory fixture; not the public captured DAO and not governance UpgradeSelf.',
    'Submitted candidate/correction metadata binds actual bytes; labels are provenance claims supplied with the inputs.',
    'A failed contract call and zero payout is a valid regressed report, not an infrastructure failure.',
  ],
};
fs.writeFileSync(path.join(OUT, 'local-three-verdict.json'), json(verdict));
console.log(json({verdict: verdict.verdict, observed: verdict.observed, primary: verdict.primaryComparison}));
