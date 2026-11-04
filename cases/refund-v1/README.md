# Funded refund claim — supported example

This is an authored, local-Sandbox example, not a public-contract capture.

- Baseline contract holds 1.00 sandbox NEAR.
- An existing user has a 0.10 NEAR refund entitlement.
- `claim_refund()` transfers 0.10 NEAR to the caller and clears the entitlement.
- The seeded bad v2 migration writes v2 but drops the entitlement, so the same claim fails with `NO_REFUND` while the contract still holds the money.
- The corrected v2 migration preserves the entitlement, so the same claim transfers and succeeds.

The bad migration is deliberately seeded for release-review contrast. No production bug, public write, deployment or custody claim is made.

## Reproducible transfer check

```sh
npm ci --ignore-scripts
node scripts/patch-near-sandbox.cjs
npm run test:refund
```

On the arm64 development host, point `NEAR_SANDBOX_BIN_PATH` at the wrapper directory and set a high file-descriptor limit first.

The check records the actual transaction hash, entitlement before/after, contract and user balances, and receipt statuses. The user balance is net of signer gas; the contract balance includes storage cost. The gross transfer is 0.10 NEAR.
