'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verifyMixedReport} = require('./mixed-policy.cjs');
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/mixed-obligation-intended.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(base));
const opts = {requireBlockPinned: true};

const good = verifyMixedReport(base, opts);
assert.equal(good.ok, true, good.errors.join('; '));

const noAliceRefund = clone();
noAliceRefund.aliceRecovery.after.balances.alice = noAliceRefund.afterUpgrade.balances.alice;
noAliceRefund.aliceRecovery.deltas.proposer = '0';
const noRefundCheck = verifyMixedReport(noAliceRefund, opts);
assert.equal(noRefundCheck.ok, false);
assert.ok(noRefundCheck.errors.some((error) => /Alice proposer delta|bond minus/.test(error)));

const extraBobCredit = clone();
extraBobCredit.bobRetry.after.balances.bob = (BigInt(extraBobCredit.bobRetry.after.balances.bob) + 10n ** 24n).toString();
const extraCreditCheck = verifyMixedReport(extraBobCredit, opts);
assert.equal(extraCreditCheck.ok, false);
assert.ok(extraCreditCheck.errors.some((error) => /Bob retry changed bob balance/.test(error)));

const unpinned = clone();
delete unpinned.beforeUpgrade.blockHash;
assert.equal(verifyMixedReport(unpinned, opts).ok, false);

console.log('mixed-policy negatives: missing Alice refund, extra Bob retry credit and unpinned snapshots are rejected');
