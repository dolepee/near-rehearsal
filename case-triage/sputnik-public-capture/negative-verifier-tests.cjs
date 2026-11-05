'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const here = __dirname;
const out = path.join(here, 'out');
const verifier = path.join(here, 'verify-baseline.cjs');
const baseCapture = fs.readFileSync(path.join(out, 'capture.json'));
const baseBaseline = JSON.parse(fs.readFileSync(path.join(out, 'baseline.json'), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'near-rehearsal-negative-'));

function run(name, mutate) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', 'capture.json'), baseCapture);
  const b = JSON.parse(JSON.stringify(baseBaseline));
  mutate(b);
  fs.writeFileSync(path.join(dir, 'out', 'baseline.json'), JSON.stringify(b, null, 2) + '\n');
  const r = spawnSync(process.execPath, [verifier], {
    encoding: 'utf8', env: { ...process.env, CASE_DIR: dir },
  });
  return { name, rejected: r.status !== 0, exit: r.status, stderr: (r.stderr || '').trim().split('\n').slice(-1)[0] };
}

const cases = [
  run('missing-baseline-tx', (b) => { delete b.baseline.tx; }),
  run('failed-child-receipt', (b) => { b.baseline.tx.receipts[0].status = { Failure: { error: 'mutated' } }; }),
  run('retry-claims-success', (b) => { b.retry.tx.failed = false; b.retry.tx.succeeded = true; }),
  run('empty-stored-checks', (b) => { b.checks = {}; }),
  run('changed-source-and-block', (b) => { b.source = 'other.near'; b.block.hash = '11111111111111111111111111111111'; }),
  run('contradictory-actor-balance', (b) => { b.baseline.balances.actorAfter = b.baseline.balances.actorBefore; }),
  run('missing-finality', (b) => { b.baseline.tx.finalExecutionStatus = 'NOT_FINAL'; }),
  run('empty-receipt-status', (b) => { b.baseline.tx.receipts[0].status = {}; }),
  run('unbound-receipt-executor', (b) => { b.baseline.tx.receipts[0].executorId = 'other.testnet'; }),
  run('missing-local-block-height', (b) => { delete b.execution.localBlock.height; }),
  run('missing-transaction-graph', (b) => { delete b.baseline.tx.transaction; delete b.baseline.tx.receiptIds; }),
];
const result = { schema: 'near-rehearsal/public-verifier-negative-tests/v1', allRejected: cases.every((c) => c.rejected), cases };
fs.writeFileSync(path.join(out, 'negative-verifier-tests.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.allRejected) process.exitCode = 1;
