'use strict';
const assert = require('node:assert/strict');
const {structuredTransactionFailure, isStructuredTransactionFailure} = require('./transaction-classification.cjs');

class TransactionError extends Error {
  constructor(value) { super(JSON.stringify(value)); this.value = value; }
  parse() { return this.value; }
}
const contractFailure = new TransactionError({failed: true, Failure: {ActionError: {}}});
assert.equal(isStructuredTransactionFailure(contractFailure), true);
assert.deepEqual(structuredTransactionFailure(contractFailure), {failed: true, Failure: {ActionError: {}}});

const transport = new Error('RPC unavailable');
assert.equal(isStructuredTransactionFailure(transport), false);
assert.equal(structuredTransactionFailure(transport), null);

const malformed = new Error('view failed');
malformed.parse = () => { throw new Error('not a transaction result'); };
assert.equal(isStructuredTransactionFailure(malformed), false);

console.log(JSON.stringify({
  schema: 'near-rehearsal/operation-error-classification/v1',
  cases: ['structured-contract-failure', 'transport-error', 'malformed-transaction-error'],
  passed: true,
}, null, 2));
