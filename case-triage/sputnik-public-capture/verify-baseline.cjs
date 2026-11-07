'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashContract } = require('near-workspaces');

const ROOT = process.env.CASE_DIR ? path.resolve(process.env.CASE_DIR) : __dirname;
const OUT = path.join(ROOT, 'out');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const fail = (m) => { throw new Error(m); };
const read = (name) => JSON.parse(fs.readFileSync(path.join(OUT, name), 'utf8'));
const capture = read('capture.json');
const baseline = read('baseline.json');

const required = (o, keys, label) => { for (const k of keys) if (!(k in (o || {}))) fail(`${label} missing ${k}`); };
const asString = (v, label) => { if (typeof v !== 'string' || !v.length) fail(`${label} must be a non-empty string`); return v; };
const asYocto = (v, label) => { try { return BigInt(asString(v, label)); } catch { fail(`${label} is not an integer yocto string`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

required(capture, ['schema', 'sourceAccount', 'network', 'block', 'account', 'code', 'state', 'policy', 'proposal'], 'capture');
if (capture.schema !== 'near-rehearsal/public-capture-probe/v1') fail('capture schema mismatch');
if (capture.network !== 'testnet') fail('unexpected capture network');
for (const k of ['height', 'hash', 'timestamp']) required(capture.block, [k], 'capture.block');
asString(capture.block.hash, 'capture.block.hash');
asString(capture.block.timestamp, 'capture.block.timestamp');
if (capture.block.timestamp !== String(capture.block.timestamp_nanosec ?? capture.block.timestamp)) fail('capture timestamp is not exact string');
if (!capture.block.timestampNanosec || capture.block.timestamp !== capture.block.timestampNanosec) fail('capture timestampNanosec missing');
asString(capture.sourceAccount, 'capture.sourceAccount');
asString(capture.code.hash, 'capture.code.hash');
asString(capture.code.sha256, 'capture.code.sha256');
asString(capture.state.hash, 'capture.state.hash');
asString(capture.account.amount, 'capture.account.amount');
asString(capture.policy.proposal_bond, 'capture.policy.proposal_bond');
asString(capture.proposal.proposer, 'capture.proposal.proposer');

if (hashContract(Buffer.from(capture.code.base64, 'base64')) !== capture.code.hash) fail('capture code hash mismatch');
if (sha256(Buffer.from(capture.code.base64, 'base64')) !== capture.code.sha256) fail('capture code sha256 mismatch');
const captureStateHash = sha256(JSON.stringify(capture.state.items.map(({ key, value }) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key))));
if (captureStateHash !== capture.state.hash) fail('capture state hash mismatch');

required(baseline, ['schema', 'source', 'block', 'captureHashes', 'execution', 'import', 'actor', 'views', 'baseline', 'retry', 'unauthorized', 'checks', 'verdict'], 'baseline');
if (baseline.schema !== 'near-rehearsal/public-capture-baseline/v2') fail('baseline schema mismatch');
if (baseline.source !== capture.sourceAccount) fail('baseline source does not match capture');
if (!same(baseline.block, capture.block)) fail('baseline block does not match capture');
if (!same(baseline.captureHashes, { code: capture.code.hash, state: capture.state.hash, codeSha256: capture.code.sha256 })) fail('capture hash binding mismatch');
if (baseline.execution?.runtime?.version !== '2.6.2') fail('sandbox runtime is not 2.6.2');
if (baseline.execution?.localBlock?.height === undefined) fail('local block height missing');
if (!baseline.execution?.localBlock?.hash) fail('local block hash missing');
asString(baseline.execution.localBlock.timestamp, 'local block timestamp');
if (baseline.import?.codeHash !== capture.code.hash) fail('import code hash mismatch');
if (baseline.import?.stateHash !== capture.state.hash) fail('import state hash mismatch');
if (baseline.import?.matches !== true) fail('import match flag is not true');
if (asYocto(baseline.import?.balance, 'import balance') !== asYocto(capture.account.amount, 'capture balance')) fail('import balance does not preserve capture');
if (baseline.actor?.account !== capture.proposal.proposer) fail('actor identity mismatch');
if (baseline.actor?.capturedBalancePreserved !== false) fail('actor funding must be explicitly synthetic');
if (baseline.actor?.publicKey !== baseline.actor?.keyStorePublicKey) fail('actor key-store/public-key mismatch');
if (!baseline.actor?.accessKeyView?.block_hash || baseline.actor?.accessKeyView?.block_height === undefined) fail('finalized actor access-key view is missing block context');
if (baseline.actor?.accessKeyView?.permission !== 'FullAccess') fail('actor access key is not full access');

const recognizedStatus = (s) => s && ['SuccessValue', 'SuccessReceiptId', 'Failure'].some((k) => Object.prototype.hasOwnProperty.call(s, k));
function tx(t, expected, label, signerId) {
  required(t, ['transactionHash', 'finalExecutionStatus', 'transaction', 'receiptIds', 'receipts', 'transactionOutcomeStatus', 'succeeded', 'failed', 'gasBurntUnits', 'transactionOutcomeTokensBurntYocto', 'receiptTokensBurntYocto', 'totalTokensBurntYocto'], label);
  asString(t.transactionHash, `${label}.transactionHash`);
  if (t.finalExecutionStatus !== 'FINAL') fail(`${label} is not FINAL`);
  required(t.transaction, ['signerId', 'receiverId', 'actions'], `${label}.transaction`);
  asString(t.transaction.signerId, `${label}.transaction.signerId`);
  asString(t.transaction.receiverId, `${label}.transaction.receiverId`);
  if (t.transaction.receiverId !== capture.sourceAccount) fail(`${label} receiver is not the captured contract`);
  if (signerId && t.transaction.signerId !== signerId) fail(`${label} signer mismatch`);
  if (!Array.isArray(t.transaction.actions) || t.transaction.actions.length === 0) fail(`${label} has no transaction actions`);
  if (!Array.isArray(t.receiptIds) || t.receiptIds.length === 0) fail(`${label} has no transaction outcome receipt ids`);
  if (!Array.isArray(t.receipts) || t.receipts.length === 0) fail(`${label} has no child receipts`);
  if (!recognizedStatus(t.transactionOutcomeStatus)) fail(`${label} has no recognized transaction outcome status`);
  const allowedExecutors = new Set([capture.sourceAccount, capture.proposal.proposer, t.transaction.signerId, t.transaction.receiverId]);
  for (const r of t.receipts) {
    if (!r.id) fail(`${label} child receipt has no id`);
    if (!recognizedStatus(r.status)) fail(`${label} child receipt has no recognized status`);
    if (!allowedExecutors.has(r.executorId)) fail(`${label} receipt executor is not bound: ${r.executorId}`);
  }
  if (!t.receiptIds.some((id) => t.receipts.some((r) => r.id === id))) fail(`${label} receipt graph is not closed`);
  if (!t.receipts.some((r) => r.executorId === capture.sourceAccount)) fail(`${label} has no contract execution receipt`);
  if (!t.receipts.some((r) => r.executorId === t.transaction.signerId || r.executorId === capture.proposal.proposer)) fail(`${label} has no actor execution receipt`);
  if (expected === 'success') {
    if (t.succeeded !== true || t.failed !== false) fail(`${label} did not succeed`);
    if (t.failure) fail(`${label} carries a failure`);
    if (t.receipts.some((r) => r.status?.Failure)) fail(`${label} has a failed child receipt`);
  } else {
    if (t.succeeded !== false || t.failed !== true) fail(`${label} did not fail`);
    if (!t.failure) fail(`${label} has no failure evidence`);
    if (!t.receipts.some((r) => r.status?.Failure)) fail(`${label} has no failed child receipt`);
  }
  asYocto(t.transactionOutcomeTokensBurntYocto, `${label}.transactionOutcomeTokensBurntYocto`);
  asYocto(t.receiptTokensBurntYocto, `${label}.receiptTokensBurntYocto`);
  asYocto(t.totalTokensBurntYocto, `${label}.totalTokensBurntYocto`);
  if (BigInt(t.transactionOutcomeTokensBurntYocto) + BigInt(t.receiptTokensBurntYocto) !== BigInt(t.totalTokensBurntYocto)) fail(`${label} token-burn total contradicts components`);
  asString(t.gasBurntUnits, `${label}.gasBurntUnits`);
}
tx(baseline.baseline?.tx, 'success', 'baseline.tx', baseline.actor?.account);
tx(baseline.retry?.tx, 'failure', 'retry.tx', baseline.actor?.account);
tx(baseline.unauthorized?.tx, 'failure', 'unauthorized.tx', null);

const b = baseline.baseline;
required(b, ['balances', 'payout', 'proposalAfter', 'stateHashAfter'], 'baseline.baseline');
for (const k of ['contractBefore', 'contractAfter', 'actorBefore', 'actorAfter']) asYocto(b.balances?.[k], `baseline.balances.${k}`);
asYocto(b.payout?.contractDeltaYocto, 'payout.contractDeltaYocto');
asYocto(b.payout?.actorDeltaYocto, 'payout.actorDeltaYocto');
asYocto(b.payout?.declaredBondYocto, 'payout.declaredBondYocto');
asYocto(b.payout?.transactionOutcomeTokensBurntYocto, 'payout.transactionOutcomeTokensBurntYocto');
asYocto(b.payout?.receiptTokensBurntYocto, 'payout.receiptTokensBurntYocto');
asYocto(b.payout?.totalTokensBurntYocto, 'payout.totalTokensBurntYocto');
if (b.payout.recipient !== capture.proposal.proposer) fail('payout recipient mismatch');
if (b.payout.declaredBondYocto !== capture.policy.proposal_bond) fail('declared bond mismatch');
const contractDelta = BigInt(b.balances.contractAfter) - BigInt(b.balances.contractBefore);
const actorDelta = BigInt(b.balances.actorAfter) - BigInt(b.balances.actorBefore);
if (contractDelta.toString() !== b.payout.contractDeltaYocto) fail('contract balance contradicts payout delta');
if (actorDelta.toString() !== b.payout.actorDeltaYocto) fail('actor balance contradicts payout delta');
if (b.proposalAfter?.status !== 'Expired') fail('proposal did not resolve as Expired');
if (b.stateHashAfter !== baseline.retry.stateHashBefore) fail('baseline and retry state hashes do not join');
if (b.stateHashAfter !== baseline.unauthorized.stateHashBefore) fail('baseline and unauthorized state hashes do not join');
if (b.payout.gasBurntUnits === undefined) fail('gas units missing');

function negative(n, label) {
  required(n, ['tx', 'stateUnchanged', 'stateHashBefore', 'stateHashAfter', 'contractBefore', 'contractAfter', 'contractDeltaYocto'], label);
  asYocto(n.contractBefore, `${label}.contractBefore`);
  asYocto(n.contractAfter, `${label}.contractAfter`);
  asYocto(n.contractDeltaYocto, `${label}.contractDeltaYocto`);
  if (BigInt(n.contractAfter) - BigInt(n.contractBefore) !== BigInt(n.contractDeltaYocto)) fail(`${label} contract delta contradiction`);
  if (n.stateUnchanged !== true || n.stateHashBefore !== n.stateHashAfter) fail(`${label} mutated state`);
  if (BigInt(n.contractDeltaYocto) <= -BigInt(capture.policy.proposal_bond) / 2n) fail(`${label} contract lost bond-scale funds`);
}
negative(baseline.retry, 'retry');
negative(baseline.unauthorized, 'unauthorized');
if (BigInt(baseline.retry.actorDeltaYocto) > 0n) fail('retry actor gained funds');
if (baseline.unauthorized.proposerUnchanged !== true) fail('unauthorized proposer balance changed');

const checks = {
  baselineSucceeded: b.tx.succeeded === true && b.tx.failed === false && b.tx.finalExecutionStatus === 'FINAL',
  proposalResolved: b.proposalAfter?.status === 'Expired',
  contractFundsDecreased: contractDelta < 0n,
  actorFundsChanged: actorDelta > 0n,
  stateChanged: b.stateHashAfter !== capture.state.hash,
  retryDidNotPayAgain: baseline.retry.tx.failed === true && baseline.retry.tx.finalExecutionStatus === 'FINAL' && baseline.retry.stateUnchanged === true && BigInt(baseline.retry.contractDeltaYocto) > -BigInt(capture.policy.proposal_bond) / 2n && BigInt(baseline.retry.actorDeltaYocto) <= 0n,
  unauthorizedFailedWithoutMutation: baseline.unauthorized.tx.failed === true && baseline.unauthorized.tx.finalExecutionStatus === 'FINAL' && baseline.unauthorized.stateUnchanged === true && baseline.unauthorized.proposerUnchanged === true && BigInt(baseline.unauthorized.contractDeltaYocto) > -BigInt(capture.policy.proposal_bond) / 2n,
};
if (Object.values(checks).some((v) => v !== true)) fail(`recomputed checks failed: ${JSON.stringify(checks)}`);
if (!same(baseline.checks, checks)) fail('stored checks contradict raw evidence');
if (baseline.verdict !== 'capture-baseline-verified') fail('stored verdict is not verified');

const verdict = {
  schema: 'near-rehearsal/public-capture-verdict/v2',
  verdict: 'capture-baseline-verified',
  source: capture.sourceAccount,
  network: capture.network,
  capturedBlock: capture.block,
  code: { hash: capture.code.hash, sha256: capture.code.sha256, bytes: capture.code.bytes },
  state: { hash: capture.state.hash, bytes: capture.state.bytes, count: capture.state.count },
  contractBalanceYocto: capture.account.amount,
  proposal: { id: capture.proposal.id, proposer: capture.proposal.proposer, status: capture.proposal.status, kind: capture.proposal.kind },
  policy: { proposalBondYocto: capture.policy.proposal_bond, proposalPeriodNs: capture.policy.proposal_period },
  localRuntime: baseline.execution.runtime,
  localBlock: baseline.execution.localBlock,
  capturedBlockContext: baseline.execution.capturedBlock,
  import: baseline.import,
  actor: baseline.actor,
  operation: b.operation,
  payout: b.payout,
  retry: { failed: baseline.retry.tx.failed, finalExecutionStatus: baseline.retry.tx.finalExecutionStatus, stateUnchanged: baseline.retry.stateUnchanged, contractDeltaYocto: baseline.retry.contractDeltaYocto, actorDeltaYocto: baseline.retry.actorDeltaYocto, failure: baseline.retry.tx.failure },
  unauthorized: { failed: baseline.unauthorized.tx.failed, finalExecutionStatus: baseline.unauthorized.tx.finalExecutionStatus, stateUnchanged: baseline.unauthorized.stateUnchanged, contractDeltaYocto: baseline.unauthorized.contractDeltaYocto, proposerUnchanged: baseline.unauthorized.proposerUnchanged, failure: baseline.unauthorized.tx.failure },
  checks,
  limitations: [
    'Local Sandbox execution only; no public write, no production key, no production recovery.',
    'The contract account ID, code, raw state and contract balance were preserved; the local actor balance was synthetic and is not claimed as the captured actor balance.',
    'Local Sandbox starts at block 0 with a later wall-clock timestamp than the captured block; this is recorded, not treated as the production context.',
    'The proposal is an existing expired proposal on public testnet; the bond amount is declared by policy. Net contract/actor deltas and tokens burned are distinct from the declared bond; no exact gross transfer receipt is claimed.',
    'This proves capture/import/baseline feasibility for one old-layout child DAO. It does not prove candidate migration, correction, arbitrary contracts, or public recovery.',
  ],
};
fs.writeFileSync(path.join(OUT, 'verdict.json'), json(verdict));
console.log(json({ verdict: verdict.verdict, checks, source: verdict.source, block: verdict.capturedBlock.height, payout: verdict.payout }));
