'use strict';
const structuredTransactionFailure = (error) => {
  try {
    const parsed = typeof error?.parse === 'function' ? error.parse() : null;
    if (error?.constructor?.name === 'TransactionError' || error?.name === 'TransactionError') return parsed || {failed: true};
    return parsed && (parsed.failed === true || parsed.Failure) ? parsed : null;
  } catch { return null; }
};
const isStructuredTransactionFailure = (error) => structuredTransactionFailure(error) !== null;
module.exports = {structuredTransactionFailure, isStructuredTransactionFailure};
