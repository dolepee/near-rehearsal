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

## Supported custom candidate

The local UI accepts a supported refund-family candidate WASM plus declared `migrate({})` and `claim_refund({})` inputs. The server checks the candidate hash and required exports, writes a run-specific case, and executes those exact bytes. The corrected reference stays fixed. Unsupported families, fields, methods and hash edits reject.

A supplied candidate is classified from its own outcome: beneficiary paid, structured `NO_REFUND`, amount regression, or inconclusive. A paid result requires the actual contract-to-beneficiary `Transfer.deposit` to equal the captured 0.10 NEAR entitlement, not merely a linked receipt or positive net balance. The uploaded corrected sample therefore produces a paid candidate result and remains exportable; the uploaded bad sample produces the structured failure; a half-payout sample is reported as an amount regression and is not exportable. There is no requirement that every candidate reproduce the seeded bug.

## Reproducible three-way run

```sh
npm ci --ignore-scripts
node scripts/patch-near-sandbox.cjs
npm run test:guards
npm run rehearse:refund
npm run rehearse:refund -- --case cases/refund-v1/half-case.json --report out/refund-half-report.json
npm run test:amount
```

`npm run test:guards` validates the fixed capture schema and rejects changed code hashes, beneficiary bytes, entitlement, runtime pin, unknown case/candidate fields, and an unrelated beneficiary gas-refund receipt. `npm run rehearse:refund` captures one funded state, imports that exact code/state into three fresh local Sandbox branches, and writes `out/refund-report.json`:

- baseline: `claim_refund()` → transfer;
- bad: candidate deploy + owner migration → `NO_REFUND`;
- corrected: candidate deploy + owner migration → transfer.

It records entitlement before/after migration and after claim, the captured and branch runtime, code and state hashes, raw linked receipts with gas/tokens burnt, and balance deltas. The completion gate requires the contract's `SuccessReceiptId` to link to a `SuccessValue` receipt executed by the captured beneficiary; an unrelated receipt executed by that account is not accepted. Migration gas is excluded from the claim delta by recording the post-migration, pre-claim balance. Failed-claim balances are marked `interim` because signer gas may settle after the read. The bad branch is accepted only when the failure is the structured `NO_REFUND` receipt and no beneficiary transfer link exists; transport, deploy, migration or read failures are `inconclusive`. A successful claim that transfers 0.05 NEAR against the 0.10 entitlement is recorded as `amount-regression`; the report is incomplete and its export is rejected.

On the arm64 development host, point `NEAR_SANDBOX_BIN_PATH` at the wrapper directory and set a high file-descriptor limit first.

The gross entitlement is 0.10 NEAR. The user's net increase is below that because the signer pays gas; the contract balance is shown separately and includes storage/setup cost. The case declares the runtime pin `2.6.2`, protocol `77`, commit `2f9ddb711ebd94a306eaec06030d87ef8dfc51fa`; the report is incomplete if either the captured or actual runtime differs.

## Verifier-backed export

```sh
npm run export:refund
npm run verify:refund-export -- out/exports/<bundle>
npm run replay:refund-export -- out/exports/<bundle>
```

Only a complete report that passes `verify-refund-report.cjs` is exported. The bundle pins the case, capture, runtime, report and input hashes; replay executes a fresh three-way run from the bundled capture and verifies the new report. Tampered reports, captures, or bundle inputs are rejected.
