'use strict';
const assert = require('node:assert/strict');
const {verify, BOND, TRANSFER} = require('./persisted-recovery-acceptance.cjs');

const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = 'a'.repeat(64);
const base = {
  schema: 'near-rehearsal/persisted-bond-recovery/v1',
  runtime: {
    sandbox: '2.14.0',
    commit: 'bc4e9e8cfb03d9e82f027883055624e18576993e',
    protocol: 88,
  },
  source: {
    baseWasmSha256: '5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578',
    baseWasmHash: 'base-code-hash',
  },
  candidate: {wasmSha256: hash, wasmHash: 'candidate-code-hash', wasmBytes: 100},
  initialization: {calls: 1, onlyOnce: true},
  accounts: {contract: 'dao.test.near', factory: 'factory.test.near', proposer: 'proposer.test.near'},
  authority: {
    upgradeMethod: 'account-key deploy + private migrate',
    upgradeCaller: 'dao.test.near',
    finalizeCaller: 'proposer.test.near',
    unauthorizedUpdateRejected: true,
    unauthorizedFinalizeRejected: true,
  },
  deploy: {succeeded: true},
  init: {succeeded: true},
  failed: {
    proposal: {status: 'Failed'},
    beforeProposal: {contract: '1000000000000000000000000000'},
    afterAdd: {contract: (1000000000000000000000000000n + BOND).toString(), proposal: {status: 'InProgress'}},
    add: {succeeded: true},
    vote: {succeeded: true},
    frozen: {
      proposal: {status: 'Failed'},
      lockedAmount: BOND.toString(),
    },
  },
  upgraded: {codeHash: 'candidate-code-hash'},
  preservation: {state: true, policy: true, proposal: true, lockedAmount: true, codeChanged: true, noNew: true},
  upgrade: {codeHash: 'candidate-code-hash', final: {receiptFailure: false}, migrate: {receiptFailure: false}},
  firstRecovery: {
    proposal: {status: 'Failed'},
    after: {lockedAmount: '0'},
    grossRecoveryYocto: BOND.toString(),
    noTargetPayment: true,
    deltas: {
      contract: '-1000000000000000000000000',
      proposer: '999999999999999000000000',
      recipient: '0',
      locked: (-BOND).toString(),
    },
  },
  secondRetry: {
    proposal: {status: 'Failed'},
    grossRecoveryYocto: '0',
    noTargetPayment: true,
    deltas: {contract: '0', proposer: '-123', recipient: '0', locked: '0'},
  },
  healthyPreservation: {
    checks: {
      settledApproved: true,
      settledPayout: TRANSFER.toString(),
      upgradeCode: true,
      proposalPreserved: true,
      recipientPreserved: true,
      lockedCleared: true,
      noFurtherPayout: true,
    },
  },
};

assert.deepEqual(verify(base), []);
console.log('accepted: persisted recovery with gross/net accounting');

const legitimateCosts = clone(base);
legitimateCosts.firstRecovery.deltas.contract = '-999999999999999750000000';
legitimateCosts.firstRecovery.deltas.proposer = '999999999999999000000000';
legitimateCosts.secondRetry.deltas.contract = '-5000000000000000000000';
assert.deepEqual(verify(legitimateCosts), []);
console.log('accepted: legitimate execution/storage deltas do not fail acceptance');

const reject = (label, mutate) => {
  const report = clone(base);
  mutate(report);
  assert.ok(verify(report).length > 0, label);
  console.log(`rejected: ${label}`);
};

reject('old-code proposal not Failed', (r) => { r.failed.proposal.status = 'Approved'; });
reject('bond not stranded', (r) => { r.failed.afterAdd.contract = r.failed.beforeProposal.contract; });
reject('unauthorized upgrade accepted', (r) => { r.authority.unauthorizedUpdateRejected = false; });
reject('unauthorized finalize accepted', (r) => { r.authority.unauthorizedFinalizeRejected = false; });
reject('state changed across upgrade', (r) => { r.preservation.state = false; });
reject('locked funds changed across upgrade', (r) => { r.preservation.lockedAmount = false; });
reject('candidate code not applied', (r) => { r.preservation.codeChanged = false; });
reject('first recovery wrong amount', (r) => { r.firstRecovery.grossRecoveryYocto = '1'; });
reject('first recovery leaves bond locked', (r) => { r.firstRecovery.after.lockedAmount = '1'; });
reject('second recovery pays again', (r) => { r.secondRetry.grossRecoveryYocto = BOND.toString(); });
reject('second recovery changes locked funds', (r) => { r.secondRetry.deltas.locked = (-BOND).toString(); });
reject('recipient paid on recovery', (r) => { r.firstRecovery.deltas.recipient = '1'; });
reject('past-settled payout wrong', (r) => { r.healthyPreservation.checks.settledPayout = '1'; });
reject('past-settled proposal changed', (r) => { r.healthyPreservation.checks.proposalPreserved = false; });
reject('past-settled paid again', (r) => { r.healthyPreservation.checks.noFurtherPayout = false; });

console.log(JSON.stringify({
  schema: 'near-rehearsal/persisted-bond-recovery-tests/v1',
  accepted: ['positive-control', 'legitimate-gas-storage-deltas'],
  rejected: [
    'old-code-not-failed', 'bond-not-stranded', 'unauthorized-upgrade', 'unauthorized-finalize',
    'state-changed', 'locked-changed', 'candidate-not-applied', 'first-wrong-amount',
    'first-still-locked', 'second-refund', 'second-locked-change', 'recipient-paid',
    'past-settled-wrong', 'past-settled-proposal-changed', 'past-settled-paid-again',
  ],
  passed: true,
}, null, 2));
