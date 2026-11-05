'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function base58(buf) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + Buffer.from(buf).toString('hex'));
  let out = '';
  while (n > 0n) { const r = Number(n % 58n); n /= 58n; out = alphabet[r] + out; }
  for (const b of buf) { if (b !== 0) break; out = '1' + out; }
  return out || '1';
}
const hashContract = (bytes) => base58(crypto.createHash('sha256').update(bytes).digest());
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
const asNonNegativeYocto = (v, label) => { const n = asYocto(v, label); if (n < 0n) fail(`${label} must be non-negative`); return n; };
const recognized = (s) => s && ['SuccessValue', 'SuccessReceiptId', 'Failure'].some((k) => Object.prototype.hasOwnProperty.call(s, k));
// A code replacement can refund or charge storage. Keep this bounded so a
// mutated report cannot hide an unexplained 50 NEAR balance change.
const MAX_STORAGE_DELTA_YOCTO = 10n ** 24n;

required(result, ['schema', 'status', 'completed', 'frozenBundle', 'inputManifest', 'artifacts', 'branches', 'sameStartingState', 'comparison', 'primaryComparison'], 'result');
if (result.schema !== 'near-rehearsal/local-sputnik-three-branch/v4') fail('result schema mismatch');
if (result.status !== 'complete' || result.completed !== true) fail('result is not a completed report');
if (result.frozenBundle.stateHash !== bundle.stateHash) fail('frozen state hash mismatch');
if (result.frozenBundle.codeHash !== bundle.codeHash) fail('frozen code hash mismatch');
if (result.frozenBundle.contractBalance !== bundle.contractAccount.amount) fail('frozen contract balance mismatch');
if (result.frozenBundle.actorBalance !== bundle.actorAccount.amount) fail('frozen actor balance mismatch');
if (result.frozenBundle.recipientBalance !== bundle.recipientAmount) fail('frozen recipient balance mismatch');
const frozenCode = Buffer.from(asString(bundle.code, 'bundle.code'), 'base64');
if (sha256(frozenCode) !== bundle.artifacts?.baseSha256) fail('frozen raw code sha256 mismatch');
if (hashContract(frozenCode) !== bundle.codeHash) fail('frozen raw code hash mismatch');
if (bundle.artifacts?.baseHash !== bundle.codeHash) fail('bundle base code hash mismatch');
const sortedState = bundle.state.map(({key, value}) => ({key, value})).sort((a, b) => a.key.localeCompare(b.key));
if (sha256(JSON.stringify(sortedState)) !== bundle.stateHash) fail('frozen raw state hash mismatch');
if (!Array.isArray(bundle.state) || bundle.state.length === 0) fail('frozen raw state missing');
required(bundle, ['proposal', 'identities', 'contractAccount', 'actorAccount'], 'bundle');
const obligation = bundle.proposal?.kind?.Transfer;
if (!obligation) fail('frozen proposal has no Transfer obligation');
const obligationId = Number(bundle.proposal.id);
const declaredTransferYocto = asYocto(obligation.amount, 'frozen transfer amount');
const declaredBondYocto = asYocto(bundle.policy?.proposal_bond, 'frozen policy proposal_bond');
if (declaredTransferYocto <= 0n) fail('frozen transfer amount must be positive');
if (declaredBondYocto < 0n) fail('frozen proposal bond must be non-negative');
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
function suppliedBytes(name) {
  const candidatePath = path.join(OUT, name);
  const fallback = path.join(HERE, name);
  const file = fs.existsSync(candidatePath) ? candidatePath : fallback;
  if (!fs.existsSync(file)) fail(`supplied ${name} bytes are missing`);
  return fs.readFileSync(file);
}
const suppliedCandidate = suppliedBytes('candidate.wasm');
const suppliedCorrection = suppliedBytes('correction.wasm');
if (suppliedCandidate.length !== input.candidate.bytes || sha256(suppliedCandidate) !== input.candidate.sha256) fail('supplied candidate bytes do not match manifest');
if (suppliedCorrection.length !== input.correction.bytes || sha256(suppliedCorrection) !== input.correction.sha256) fail('supplied correction bytes do not match manifest');
if (hashContract(suppliedCandidate) !== result.artifacts.candidate.hash) fail('supplied candidate code hash does not match artifact');
if (hashContract(suppliedCorrection) !== result.artifacts.corrected.hash) fail('supplied correction code hash does not match artifact');

const expectedNames = ['baseline', 'candidate', 'corrected'];
for (const n of expectedNames) required(result.branches, [n], 'branches');
const branchNames = Object.keys(result.branches);
for (const n of branchNames) if (![...expectedNames, 'recoveryExperiment'].includes(n)) fail(`unexpected branch ${n}`);

function tx(t, expected, label, signer, expectedExecutors = []) {
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
  const references = new Map();
  const refer = (id, where) => {
    if (typeof id !== 'string' || !id) fail(`${label} ${where} has invalid receipt id`);
    if (references.has(id)) fail(`${label} receipt ${id} referenced more than once (${references.get(id)} and ${where})`);
    references.set(id, where);
  };
  if (new Set(t.receiptIds).size !== t.receiptIds.length) fail(`${label} duplicate root receipt id`);
  const receiptsById = new Map();
  for (const r of t.receipts) {
    if (!r.id) fail(`${label} receipt missing id`);
    if (receiptIds.has(r.id)) fail(`${label} duplicate receipt id ${r.id}`);
    receiptIds.add(r.id);
    receiptsById.set(r.id, r);
    if (!r.blockHash) fail(`${label} receipt missing block hash`);
    if (!Array.isArray(r.receiptIds)) fail(`${label} receipt missing child ids`);
    if (new Set(r.receiptIds).size !== r.receiptIds.length) fail(`${label} duplicate child receipt id`);
    if (!recognized(r.status)) fail(`${label} receipt status not recognized`);
    if (!allowed.has(r.executorId)) fail(`${label} receipt executor unbound: ${r.executorId}`);
  }
  for (const id of t.receiptIds) refer(id, 'root');
  for (const r of t.receipts) for (const child of r.receiptIds) {
    if (child === r.id) fail(`${label} receipt ${r.id} is a self-loop`);
    refer(child, `child of ${r.id}`);
  }
  for (const id of references.keys()) if (!receiptIds.has(id)) fail(`${label} referenced receipt ${id} is missing from graph`);
  if (t.receiptIds.length !== 1) fail(`${label} expected exactly one transaction outcome root, got ${t.receiptIds.length}`);
  // Rooted traversal. A set of one-parent references alone does not prove a
  // receipt is connected to the transaction outcome (disconnected cycles).
  const reachable = new Set();
  const queue = [...t.receiptIds];
  while (queue.length) {
    const id = queue.shift();
    if (reachable.has(id)) fail(`${label} receipt ${id} is reached more than once`);
    reachable.add(id);
    const receipt = receiptsById.get(id);
    if (!receipt) fail(`${label} reachable receipt ${id} is missing from graph`);
    for (const child of receipt.receiptIds) {
      if (reachable.has(child)) fail(`${label} receipt ${child} is reached more than once`);
      queue.push(child);
    }
  }
  for (const id of receiptIds) if (!reachable.has(id)) fail(`${label} receipt ${id} is not reachable from a root`);
  if (t.transactionOutcomeStatus?.SuccessReceiptId && !reachable.has(t.transactionOutcomeStatus.SuccessReceiptId)) fail(`${label} success receipt id is not reachable from a root`);
  if (!t.receipts.some((r) => r.executorId === bundle.identities.contract)) fail(`${label} no contract receipt`);
  for (const executor of expectedExecutors || []) if (!t.receipts.some((r) => r.executorId === executor)) fail(`${label} missing expected executor ${executor}`);
  if (expected === 'success') {
    if (t.succeeded !== true || t.failed !== false || t.failure) fail(`${label} did not succeed`);
    if (t.receipts.some((r) => r.status?.Failure)) fail(`${label} has failed child receipt`);
  } else {
    if (t.succeeded !== false || t.failed !== true || !t.failure) fail(`${label} did not fail`);
    if (!t.receipts.some((r) => r.status?.Failure)) fail(`${label} has no failed child receipt`);
  }
  const txTokens = asNonNegativeYocto(t.transactionOutcomeTokensBurntYocto, `${label}.transactionOutcomeTokensBurntYocto`);
  const reportedReceiptTokens = asNonNegativeYocto(t.receiptTokensBurntYocto, `${label}.receiptTokensBurntYocto`);
  const reportedTotalTokens = asNonNegativeYocto(t.totalTokensBurntYocto, `${label}.totalTokensBurntYocto`);
  let recomputedReceiptTokens = 0n;
  for (const r of t.receipts) recomputedReceiptTokens += asNonNegativeYocto(r.tokensBurntYocto, `${label}.receipt.${r.id}.tokensBurntYocto`);
  if (recomputedReceiptTokens !== reportedReceiptTokens) fail(`${label} receipt token cost does not equal the validated non-negative receipt costs`);
  if (txTokens + recomputedReceiptTokens !== reportedTotalTokens) fail(`${label} token totals disagree with recomputed costs`);
  asString(t.gasBurntUnits, `${label}.gasBurntUnits`);
}
function checkOperation(t, label, signer) {
  required(t, ['transaction'], label);
  const action = t.transaction.actions?.[0]?.FunctionCall;
  if (!action || action.method_name !== 'act_proposal') fail(`${label} operation is not act_proposal`);
  if (t.transaction.signerId !== signer) fail(`${label} operation signer mismatch`);
  let args;
  try { args = JSON.parse(Buffer.from(action.args, 'base64').toString('utf8')); } catch { fail(`${label} operation args are not JSON`); }
  if (args.id !== obligationId) fail(`${label} proposal id does not match frozen obligation`);
  if (args.action !== 'VoteApprove') fail(`${label} operation action is not VoteApprove`);
  const transfer = args.proposal?.Transfer;
  if (!transfer) fail(`${label} operation proposal is not Transfer`);
  if (transfer.receiver_id !== obligation.receiver_id) fail(`${label} operation recipient does not match frozen obligation`);
  if (String(transfer.amount) !== String(obligation.amount)) fail(`${label} operation amount does not match frozen obligation`);
  if ((transfer.token_id || '') !== (obligation.token_id || '')) fail(`${label} operation token does not match frozen obligation`);
  if ((transfer.msg ?? null) !== (obligation.msg ?? null)) fail(`${label} operation message does not match frozen obligation`);
}
function checkUpgrade(t, label, bytes, signer) {
  required(t, ['transaction'], label);
  const action = t.transaction.actions?.[0]?.FunctionCall;
  if (!action || action.method_name !== 'update') fail(`${label} upgrade is not update`);
  if (t.transaction.signerId !== signer) fail(`${label} upgrade signer mismatch`);
  if (sha256(Buffer.from(action.args, 'base64')) !== sha256(bytes)) fail(`${label} upgrade bytes do not match supplied artifact`);
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

function assertSnapshotRecipient(snapshot, label) {
  const transfer = snapshot?.proposal?.kind?.Transfer;
  if (!transfer) fail(`${label} snapshot has no Transfer obligation`);
  if (transfer.receiver_id !== bundle.identities.recipient) fail(`${label} snapshot recipient is not frozen recipient`);
  if (String(transfer.amount) !== String(bundle.proposal.kind.Transfer.amount)) fail(`${label} snapshot transfer amount changed`);
}
function upgradeAccounting(b, label) {
  required(b, ['before', 'afterUpgrade', 'upgrade'], label);
  for (const [snapshot, name] of [[b.before, 'before'], [b.afterUpgrade, 'afterUpgrade']]) {
    for (const k of ['contractBalance', 'actorBalance', 'recipientBalance']) asNonNegativeYocto(snapshot?.[k], `${label}.${name}.${k}`);
  }
  if (BigInt(b.before.contractBalance) !== BigInt(b.initial.contractBalance)) fail(`${label} before upgrade contract balance is not frozen initial`);
  if (BigInt(b.before.actorBalance) !== BigInt(b.initial.actorBalance)) fail(`${label} before upgrade proposer balance is not frozen initial`);
  if (BigInt(b.before.recipientBalance) !== BigInt(b.initial.recipientBalance)) fail(`${label} before upgrade recipient balance is not frozen initial`);
  if (b.afterUpgrade.actorBalance !== b.before.actorBalance) fail(`${label} upgrade changed proposer balance`);
  if (b.afterUpgrade.recipientBalance !== b.before.recipientBalance) fail(`${label} upgrade changed recipient balance`);
  const contractDelta = BigInt(b.afterUpgrade.contractBalance) - BigInt(b.before.contractBalance);
  if (contractDelta > MAX_STORAGE_DELTA_YOCTO || contractDelta < -MAX_STORAGE_DELTA_YOCTO) fail(`${label} upgrade contract balance change outside migration storage bound: ${contractDelta}`);
  return {contractDeltaYocto: contractDelta.toString()};
}

function branchAccounting(b, label, keys) {
  const before = b[keys.before];
  const first = b[keys.first];
  const after = b[keys.after];
  for (const [snapshot, name] of [[before, keys.before], [first, keys.first], [after, keys.after]]) {
    for (const k of ['contractBalance', 'actorBalance', 'recipientBalance']) asNonNegativeYocto(snapshot?.[k], `${label}.${name}.${k}`);
  }
  // The first snapshot is the frozen starting point. This binds every later
  // balance to the reviewed state rather than to a self-consistent mutation.
  if (keys.before === 'before') {
    if (BigInt(before.contractBalance) !== BigInt(b.initial.contractBalance)) fail(`${label} before contract balance is not the frozen initial balance`);
    if (BigInt(before.actorBalance) !== BigInt(b.initial.actorBalance)) fail(`${label} before proposer balance is not the frozen initial balance`);
    if (BigInt(before.recipientBalance) !== BigInt(b.initial.recipientBalance)) fail(`${label} before recipient balance is not the frozen initial balance`);
  }
  const firstTx = b.first || b.correctedOperation;
  if (!firstTx) fail(`${label} first operation transaction is missing`);
  const firstGas = asNonNegativeYocto(firstTx.totalTokensBurntYocto, `${label}.first.totalTokensBurntYocto`);
  const firstPayout = BigInt(first.recipientBalance) - BigInt(before.recipientBalance);
  const firstContractDelta = BigInt(first.contractBalance) - BigInt(before.contractBalance);
  const firstActorDelta = BigInt(first.actorBalance) - BigInt(before.actorBalance);
  const paid = b.status === 'preserved' || b.status === 'improved';
  const expectedPayout = paid ? declaredTransferYocto : 0n;
  if (firstPayout !== expectedPayout) fail(`${label} first-operation recipient payout ${firstPayout} does not match derived status ${b.status}; expected ${expectedPayout}`);
  if (paid) {
    const expectedActor = declaredBondYocto - firstGas;
    if (firstActorDelta !== expectedActor) fail(`${label} preserved proposer delta ${firstActorDelta} does not equal bond ${declaredBondYocto} minus gas ${firstGas}`);
    if (firstContractDelta > -declaredTransferYocto) fail(`${label} preserved contract did not pay the declared transfer`);
    if (firstContractDelta < -declaredTransferYocto - declaredBondYocto - MAX_STORAGE_DELTA_YOCTO) fail(`${label} preserved contract paid more than transfer plus bond plus allowed storage cost`);
  } else if (b.status === 'regressed') {
    if (firstActorDelta !== -firstGas) fail(`${label} regressed proposer delta ${firstActorDelta} is not gas-only; bond may have been returned`);
    if (firstContractDelta <= -declaredTransferYocto) fail(`${label} regressed contract lost the declared transfer`);
  }
  const beforeSum = BigInt(before.contractBalance) + BigInt(before.actorBalance) + BigInt(before.recipientBalance);
  const firstSum = BigInt(first.contractBalance) + BigInt(first.actorBalance) + BigInt(first.recipientBalance);
  const storageDelta = firstSum - beforeSum + firstGas;
  if (storageDelta > MAX_STORAGE_DELTA_YOCTO || storageDelta < -MAX_STORAGE_DELTA_YOCTO) fail(`${label} unexplained first-operation balance change outside storage bound: ${storageDelta}`);
  if (BigInt(after.recipientBalance) !== BigInt(first.recipientBalance)) fail(`${label} retry paid recipient`);
  if (BigInt(after.recipientBalance) !== BigInt(before.recipientBalance) + expectedPayout) fail(`${label} retry/snapshot recipient balance invariant failed`);
  const retryContractDelta = BigInt(after.contractBalance) - BigInt(first.contractBalance);
  const retryActorDelta = BigInt(after.actorBalance) - BigInt(first.actorBalance);
  const retryGas = asNonNegativeYocto(b.retry.totalTokensBurntYocto, `${label}.retry.totalTokensBurntYocto`);
  const retryStorageDelta = retryContractDelta + retryActorDelta + retryGas;
  if (retryStorageDelta > MAX_STORAGE_DELTA_YOCTO || retryStorageDelta < -MAX_STORAGE_DELTA_YOCTO) fail(`${label} unexplained retry balance change outside storage bound: ${retryStorageDelta}`);
  if (retryContractDelta <= -declaredBondYocto / 2n) fail(`${label} retry lost bond-scale contract funds`);
  if (retryActorDelta > 0n) fail(`${label} retry increased proposer balance`);
  if (b.checks?.retryDidNotPay !== true) fail(`${label} retryDidNotPay check not true`);
  if (b.checks?.retryContractDeltaYocto !== retryContractDelta.toString()) fail(`${label} retry contract delta does not match snapshots`);
  if (b.checks?.retryActorDeltaYocto !== retryActorDelta.toString()) fail(`${label} retry actor delta does not match snapshots`);
  return {grossPayoutYocto: firstPayout.toString(), bondRefundYocto: paid ? declaredBondYocto.toString() : '0', gasYocto: firstGas.toString(), contractDeltaYocto: firstContractDelta.toString(), actorDeltaYocto: firstActorDelta.toString(), storageDeltaYocto: storageDelta.toString(), retryContractDeltaYocto: retryContractDelta.toString(), retryActorDeltaYocto: retryActorDelta.toString()};
}

function retryBalances(b, label, keys = {before: 'before', retry: 'retry', first: 'afterFirst', after: 'afterRetry'}) {
  required(b, [keys.before, keys.retry, keys.first, keys.after], label);
  for (const k of [keys.before, keys.first, keys.after]) assertSnapshotRecipient(b[k], `${label}.${k}`);
  tx(b[keys.retry], 'failure', `${label}.${keys.retry}`, bundle.identities.proposer, [bundle.identities.contract]);
  return branchAccounting(b, label, keys);
}
function derivedStatus(b, role) {
  if (role !== 'baseline') {
    const upgrade = b.upgrade;
    const upgradeOk = upgrade?.succeeded === true && upgrade?.failed === false && !upgrade?.failure;
    if (!upgradeOk || b.afterUpgrade?.codeHash !== result.artifacts[role === 'candidate' ? 'candidate' : 'corrected'].hash) return 'inconclusive';
  }
  const first = b.first;
  if (!first) return 'inconclusive';
  const payout = b.before && b.afterFirst ? BigInt(b.afterFirst.recipientBalance) - BigInt(b.before.recipientBalance) : null;
  if (first.succeeded === true && first.failed === false && payout === declaredTransferYocto) return 'preserved';
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
tx(baseline.first, 'success', 'baseline.first', bundle.identities.proposer, [bundle.identities.contract, bundle.identities.recipient]);
checkOperation(baseline.first, 'baseline.first', bundle.identities.proposer);
checkOperation(baseline.retry, 'baseline.retry', bundle.identities.proposer);
retryBalances(baseline, 'baseline');
if (baseline.checks.retryDidNotPay !== true) fail('baseline retry check not true');

const candidate = result.branches.candidate;
if (candidate.afterUpgrade.codeHash !== result.artifacts.candidate.hash) fail('candidate code not deployed');
tx(candidate.upgrade, 'success', 'candidate.upgrade', bundle.identities.factory, [bundle.identities.factory, bundle.identities.contract]);
checkUpgrade(candidate.upgrade, 'candidate.upgrade', suppliedCandidate, bundle.identities.factory);
upgradeAccounting(candidate, 'candidate');
tx(candidate.first, candidate.status === 'regressed' ? 'failure' : 'success', 'candidate.first', bundle.identities.proposer, [bundle.identities.contract]);
checkOperation(candidate.first, 'candidate.first', bundle.identities.proposer);
checkOperation(candidate.retry, 'candidate.retry', bundle.identities.proposer);
retryBalances(candidate, 'candidate');
if (candidate.status === 'preserved' && BigInt(candidate.afterFirst.recipientBalance) - BigInt(candidate.before.recipientBalance) !== declaredTransferYocto) fail('preserved candidate did not pay the declared transfer');
if (candidate.status === 'regressed' && BigInt(candidate.afterFirst.recipientBalance) !== BigInt(candidate.before.recipientBalance)) fail('regressed candidate paid recipient');

const corrected = result.branches.corrected;
if (corrected.afterUpgrade.codeHash !== result.artifacts.corrected.hash) fail('corrected code not deployed');
tx(corrected.upgrade, 'success', 'corrected.upgrade', bundle.identities.factory, [bundle.identities.factory, bundle.identities.contract]);
checkUpgrade(corrected.upgrade, 'corrected.upgrade', suppliedCorrection, bundle.identities.factory);
upgradeAccounting(corrected, 'corrected');
tx(corrected.first, corrected.status === 'regressed' ? 'failure' : 'success', 'corrected.first', bundle.identities.proposer, [bundle.identities.contract]);
checkOperation(corrected.first, 'corrected.first', bundle.identities.proposer);
checkOperation(corrected.retry, 'corrected.retry', bundle.identities.proposer);
retryBalances(corrected, 'corrected');
if (corrected.status === 'preserved' && BigInt(corrected.afterFirst.recipientBalance) - BigInt(corrected.before.recipientBalance) !== declaredTransferYocto) fail('preserved correction did not pay the declared transfer');

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
if (result.summary !== undefined) {
  for (const n of expectedNames) if (result.summary?.[n] !== observed[n]) fail(`summary ${n} does not match derived outcome`);
  if (result.summary.sameStartingState !== true) fail('summary sameStartingState is not true');
}

const verdict = {
  schema: 'near-rehearsal/local-sputnik-three-branch-verdict/v3',
  verdict: 'local-three-branch-verified',
  status: 'complete',
  scope: 'offline consistency from supplied bytes, raw state and receipts; not cryptographic execution attestation',
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
