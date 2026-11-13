'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verifyMixedReport} = require('./mixed-policy.cjs');
const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'out', name), 'utf8'));
const expected = {
  'mixed-obligation-old.json': false,
  'mixed-obligation-future-only.json': false,
  'mixed-obligation-clear-all.json': false,
  'mixed-obligation-intended.json': true,
};
for (const [name, ok] of Object.entries(expected)) {
  const checked = verifyMixedReport(read(name));
  assert.equal(checked.ok, ok, `${name}: ${checked.errors.join('; ')}`);
  if (!ok) assert.ok(checked.errors.length > 0, `${name} rejecting candidate must explain why`);
}
const clear = verifyMixedReport(read('mixed-obligation-clear-all.json'));
assert.equal(clear.outcomes.bobLiabilityAfterAlice, false);
assert.equal(clear.outcomes.bobPaidExactlyOnce, false);
const pinnedIntended = verifyMixedReport(read('mixed-obligation-intended.json'), {requireBlockPinned: true});
assert.equal(pinnedIntended.ok, true, `pinned intended: ${pinnedIntended.errors.join('; ')}`);
const pinnedClear = verifyMixedReport(read('mixed-obligation-clear-all.json'), {requireBlockPinned: true});
assert.equal(pinnedClear.ok, false);
assert.ok(pinnedClear.errors.some((error) => /Bob liability disappeared/.test(error)));
const intended = verifyMixedReport(read('mixed-obligation-intended.json'));
assert.equal(intended.outcomes.alicePaid, true);
assert.equal(intended.outcomes.bobLiabilityAfterAlice, true);
assert.equal(intended.outcomes.bobPaidExactlyOnce, true);
console.log('mixed-policy: primary policy rejects old/future-only/clear-all and accepts intended');
