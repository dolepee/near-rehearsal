'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const here = __dirname;
const caseRoot = process.env.CASE_DIR ? path.resolve(process.env.CASE_DIR) : here;
const out = path.join(caseRoot, 'out');
const verifier = path.join(here, 'verify-local-three.cjs');
const baseResult = JSON.parse(fs.readFileSync(path.join(out, 'local-three-branch.json'), 'utf8'));
const baseBundle = JSON.parse(fs.readFileSync(path.join(out, 'local-frozen-bundle.json'), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'near-sputnik-negative-'));
function run(name, mutate) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'out'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'out', 'local-frozen-bundle.json'), JSON.stringify(baseBundle, null, 2));
  fs.copyFileSync(path.join(out, 'input-manifest.json'), path.join(dir, 'out', 'input-manifest.json'));
  fs.copyFileSync(path.join(out, 'candidate.wasm'), path.join(dir, 'out', 'candidate.wasm'));
  fs.copyFileSync(path.join(out, 'correction.wasm'), path.join(dir, 'out', 'correction.wasm'));
  const r = JSON.parse(JSON.stringify(baseResult));
  const b = JSON.parse(JSON.stringify(baseBundle));
  mutate(r, b);
  fs.writeFileSync(path.join(dir, 'out', 'local-three-branch.json'), JSON.stringify(r, null, 2));
  fs.writeFileSync(path.join(dir, 'out', 'local-frozen-bundle.json'), JSON.stringify(b, null, 2));
  const p = spawnSync(process.execPath, [verifier], {env: {...process.env, CASE_DIR: dir}, encoding: 'utf8'});
  return {name, rejected: p.status !== 0, exit: p.status};
}
// A positive control proves the fixture is complete before any mutated case is
// counted. Without this, an ENOENT could be mistaken for an invariant failure.
const positiveControl = run('positive-control', () => {});
if (positiveControl.rejected) {
  throw new Error(`positive control did not pass; fixture or verifier is broken (exit ${positiveControl.exit})`);
}
const cases = [
  run('baseline-operation-failed', (r) => { r.branches.baseline.first.failed = true; r.branches.baseline.first.succeeded = false; }),
  run('candidate-unexpectedly-green', (r) => { r.branches.candidate.first.failed = false; r.branches.candidate.first.succeeded = true; }),
  run('candidate-missing-failed-receipt', (r) => { r.branches.candidate.first.receipts = r.branches.candidate.first.receipts.filter((x) => !x.status?.Failure); }),
  run('candidate-paid', (r) => { r.branches.candidate.afterFirst.recipientBalance = String(BigInt(r.branches.candidate.before.recipientBalance) + 10n ** 24n); }),
  run('candidate-code-mismatch', (r) => { r.branches.candidate.afterUpgrade.codeHash = '11111111111111111111111111111111'; }),
  run('corrected-code-mismatch', (r) => { r.branches.corrected.afterUpgrade.codeHash = '11111111111111111111111111111111'; }),
  run('empty-receipt-status', (r) => { r.branches.baseline.first.receipts[0].status = {}; }),
  run('unbound-executor', (r) => { r.branches.baseline.first.receipts[0].executorId = 'other.testnet'; }),
  run('initial-state-mismatch', (r) => { r.branches.corrected.initial.stateHash = 'deadbeef'; }),
  run('missing-local-block', (r) => { delete r.branches.candidate.localBlock.height; }),
  run('token-total-mismatch', (r) => { r.branches.baseline.first.totalTokensBurntYocto = '1'; }),
  run('inconclusive-status', (r) => { r.status = 'inconclusive'; r.completed = false; }),
  run('primary-all-green', (r) => { r.primaryComparison.candidate = 'preserved'; }),
  run('raw-state-value-stale-hash', (r, b) => { b.state[0].value = 'AAAA'; }),
  run('raw-code-stale-hash', (r, b) => { b.code = 'AAAA'; }),
  run('missing-root-receipt', (r) => { r.branches.candidate.first.receiptIds.push('MISSING_ROOT'); }),
  run('duplicate-receipt-id', (r) => { r.branches.candidate.first.receipts.push(JSON.parse(JSON.stringify(r.branches.candidate.first.receipts[0]))); }),
  run('operation-recipient-args', (r) => { const a = r.branches.baseline.first.transaction.actions[0].FunctionCall; const decoded = JSON.parse(Buffer.from(a.args, 'base64').toString('utf8')); decoded.proposal.Transfer.receiver_id = 'attacker.test.near'; a.args = Buffer.from(JSON.stringify(decoded)).toString('base64'); }),
  run('preserved-candidate-no-payout', (r) => { r.branches.candidate.status = 'preserved'; r.branches.candidate.afterFirst.recipientBalance = r.branches.candidate.before.recipientBalance; }),
  run('preserved-correction-no-payout', (r) => { r.branches.corrected.afterFirst.recipientBalance = r.branches.corrected.before.recipientBalance; }),
  run('unexplained-balance-drain', (r) => { r.branches.corrected.afterUpgrade.contractBalance = String(BigInt(r.branches.corrected.afterUpgrade.contractBalance) - 50n * 10n ** 24n); }),
  run('quarter-near-candidate-upgrade-loss', (r) => { r.branches.candidate.afterUpgrade.contractBalance = String(BigInt(r.branches.candidate.afterUpgrade.contractBalance) - 25n * 10n ** 22n); }),
  run('quarter-near-corrected-upgrade-loss', (r) => { r.branches.corrected.afterUpgrade.contractBalance = String(BigInt(r.branches.corrected.afterUpgrade.contractBalance) - 25n * 10n ** 22n); }),
  run('first-operation-balance-drain', (r) => { r.branches.corrected.afterFirst.contractBalance = String(BigInt(r.branches.corrected.afterFirst.contractBalance) - 50n * 10n ** 24n); }),
  run('quarter-near-first-loss', (r) => { r.branches.corrected.afterFirst.contractBalance = String(BigInt(r.branches.corrected.afterFirst.contractBalance) - 25n * 10n ** 22n); }),
  run('quarter-near-retry-loss', (r) => { r.branches.corrected.afterRetry.contractBalance = String(BigInt(r.branches.corrected.afterRetry.contractBalance) - 25n * 10n ** 22n); }),
  run('missing-bond-refund', (r) => { r.branches.corrected.afterFirst.actorBalance = String(BigInt(r.branches.corrected.afterFirst.actorBalance) - 10n ** 24n); }),
  run('disconnected-receipt-cycle', (r) => { const t = r.branches.baseline.first; t.receipts.push({id: 'CYCLE_A', blockHash: 'a', receiptIds: ['CYCLE_B'], executorId: t.receipts[0].executorId, status: {SuccessValue: ''}, gasBurntUnits: '1', tokensBurntYocto: '1', logs: []}, {id: 'CYCLE_B', blockHash: 'b', receiptIds: ['CYCLE_A'], executorId: t.receipts[0].executorId, status: {SuccessValue: ''}, gasBurntUnits: '1', tokensBurntYocto: '1', logs: []}); }),
  run('receipt-self-loop', (r) => { const t = r.branches.baseline.first; t.receipts[0].receiptIds.push(t.receipts[0].id); }),
  run('recomputed-receipt-cost', (r) => { r.branches.baseline.first.receipts[0].tokensBurntYocto = '999'; }),
];
if (baseResult.branches.recoveryExperiment) {
  cases.push(
    run('recovery-missing-accounting-before', (r) => { delete r.branches.recoveryExperiment.afterCorrectedUpgrade; }),
    run('recovery-wrong-operation-payout', (r) => { const b = r.branches.recoveryExperiment; b.afterCorrectedOperation.recipientBalance = String(BigInt(b.afterCorrectedOperation.recipientBalance) + 10n ** 24n); }),
    run('recovery-wrong-operation-actor-basis', (r) => { const b = r.branches.recoveryExperiment; b.afterCorrectedUpgrade.actorBalance = String(BigInt(b.afterCorrectedUpgrade.actorBalance) + 10n ** 24n); }),
    run('recovery-retry-contract-loss', (r) => { const b = r.branches.recoveryExperiment; b.afterCorrectedRetry.contractBalance = String(BigInt(b.afterCorrectedRetry.contractBalance) - 25n * 10n ** 22n); }),
    run('recovery-retry-actor-gain', (r) => { const b = r.branches.recoveryExperiment; b.afterCorrectedRetry.actorBalance = String(BigInt(b.afterCorrectedRetry.actorBalance) + 10n ** 24n); }),
    run('recovery-missing-check-layout', (r) => { delete r.branches.recoveryExperiment.checks.correctedRetryDidNotPay; }),
  );
}
const result = {schema: 'near-rehearsal/local-verifier-negative-tests/v3', positiveControl, allRejected: cases.every((c) => c.rejected), cases};
fs.writeFileSync(path.join(out, 'negative-local-verifier-tests.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.allRejected) process.exitCode = 1;
