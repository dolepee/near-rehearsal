'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verify} = require('./acceptance.cjs');
const here = __dirname;
const base = JSON.parse(fs.readFileSync(path.join(here, 'out/issue238-local.json'), 'utf8'));
const repaired = JSON.parse(fs.readFileSync(path.join(here, 'out/issue238-repaired.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const expectFail = (label, mutate) => {
  const b = clone(base);
  const r = clone(repaired);
  mutate(b, r);
  const errors = verify(b, r);
  assert.ok(errors.length > 0, label);
  console.log(`rejected: ${label}`);
};
assert.deepEqual(verify(base, repaired), []);
console.log('accepted: base reproduction plus repaired control');
expectFail('base failed branch hides the stranded bond', (b) => { b.failed.deltas.contract = '0'; });
expectFail('repair double-returns the bond', (b, r) => { r.failed.deltas.contract = '-1000000000000000000000000'; });
expectFail('healthy payout missing', (b, r) => { r.healthy.deltas.recipient = '0'; });
expectFail('failed proposal marked approved', (b, r) => { r.failed.after.proposal.status = 'Approved'; });
expectFail('repaired artifact identity changed', (b, r) => { r.source.wasmSha256 = '0'.repeat(64); });
expectFail('unauthorized callback recorded as accepted', (b, r) => { r.healthy.unauthorizedCallback.receipts[0].status = { SuccessValue: '' }; });
expectFail('healthy beneficiary changed', (b, r) => { r.healthy.kind.Transfer.receiver_id = 'attacker.test.near'; });
console.log(JSON.stringify({
  schema: 'near-rehearsal/repair-acceptance-tests/v1',
  positiveControl: true,
  cases: ['base-stranded-bond', 'double-refund', 'missing-payout', 'false-failed-status', 'artifact-identity', 'unauthorized-callback', 'beneficiary-immutability'],
  passed: true,
}, null, 2));
