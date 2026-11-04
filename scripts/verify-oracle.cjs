'use strict';
const assert = require('node:assert');
const counter = '9007199254740992';
const expected = (BigInt(counter) + 1n).toString();
assert.strictEqual(expected, '9007199254740993');
assert.notStrictEqual(String(Number(counter) + 1), expected);
console.log(JSON.stringify({ counter, expected, numberWouldBe: String(Number(counter) + 1) }));
