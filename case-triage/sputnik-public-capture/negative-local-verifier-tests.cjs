'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const here = __dirname;
const out = path.join(here, 'out');
const verifier = path.join(here, 'verify-local-three.cjs');
const baseResult = JSON.parse(fs.readFileSync(path.join(out, 'local-three-branch.json'), 'utf8'));
const baseBundle = JSON.parse(fs.readFileSync(path.join(out, 'local-frozen-bundle.json'), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'near-sputnik-negative-'));
function run(name, mutate) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'out'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'out', 'local-frozen-bundle.json'), JSON.stringify(baseBundle, null, 2));
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
];
const result = {schema: 'near-rehearsal/local-verifier-negative-tests/v2', allRejected: cases.every((c) => c.rejected), cases};
fs.writeFileSync(path.join(out, 'negative-local-verifier-tests.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.allRejected) process.exitCode = 1;
