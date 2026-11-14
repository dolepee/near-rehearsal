'use strict';
const assert = require('node:assert/strict');
const {reconcilePrincipal} = require('./approved-refund-principal.cjs');
const BOND = 10n ** 24n;
const gas = 231540775509500000000n;
assert.equal(reconcilePrincipal({before: 10999433200835226100000000n, after: 10999201660059716600000000n, gas}), 0n, 'duplicate net minus gas must be zero');
assert.equal(reconcilePrincipal({before: 10000000000000000000000000n, after: 10999433200835226100000000n, gas: 566799164773900000000n}), BOND, 'retry net plus gas must equal the bond');
assert.notEqual(reconcilePrincipal({before: 10999433200835226100000000n, after: 10999201660059716600000000n, gas}), gas, 'the old after === before + gas shortcut is rejected');
console.log('approved-refund-principal: signed gas reconciliation passes');
