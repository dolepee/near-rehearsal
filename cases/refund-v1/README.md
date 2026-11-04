# Funded refund claim — supported example

This is an authored, local-Sandbox example, not a public-contract capture.

- The contract is funded with 1.00 sandbox NEAR.
- One stored beneficiary has a 0.10 NEAR refund entitlement.
- `claim_refund()` pays the stored beneficiary, then clears the entitlement.
- The seeded bad v2 migration writes v2 but drops the entitlement, so the same beneficiary claim fails with `NO_REFUND` while the contract still holds the money.
- The corrected v2 migration preserves the entitlement, so the same claim transfers and succeeds.

## Controls

- `init` succeeds once; a second call fails with `ALREADY_INIT` and preserves the state.
- An outsider claim fails with `OUTSIDER` and preserves the entitlement.
- A non-owner migration call fails with `MIGRATION` and preserves the state.
- A second claim by the beneficiary fails with `NO_REFUND`; the entitlement stays zero.

The bad migration is deliberately seeded for release-review contrast. No production bug, public write, deployment or custody claim is made.

## Reproducible three-way run

```sh
npm ci --ignore-scripts
node scripts/patch-near-sandbox.cjs
npm run rehearse:refund
```

The runner captures one funded state, imports that exact code/state into three fresh local Sandbox branches, and writes `out/refund-report.json`:

- baseline: `claim_refund()` → transfer;
- bad: candidate deploy + owner migration → `NO_REFUND`;
- corrected: candidate deploy + owner migration → transfer.

It records entitlement before/after migration and after claim, the captured and branch runtime, code and state hashes, raw linked receipts with gas/tokens burnt, and balance deltas. Migration gas is excluded from the claim delta by recording the post-migration, pre-claim balance. The bad branch is accepted only when the failure is the structured `NO_REFUND` receipt and no successful transfer receipt exists; transport, deploy, migration or read failures are `inconclusive`.

On the arm64 development host, point `NEAR_SANDBOX_BIN_PATH` at the wrapper directory and set a high file-descriptor limit first.

The gross entitlement is 0.10 NEAR. The user's net increase is below that because the signer pays gas; the contract balance is shown separately and includes storage/setup cost.
