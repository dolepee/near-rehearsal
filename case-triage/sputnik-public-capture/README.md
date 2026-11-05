# Public Sputnik child DAO capture probe

Status: **`capture-baseline-verified`** for one public testnet child DAO.

This is a read-only capture and local Sandbox feasibility proof. It is not a
candidate upgrade, a production recovery, or a claim that the public DAO was
modified. No public transaction, deployment, production key or production
authorization was used.

## Case

- Account: `aya.sputnikv2.testnet`
- Network: NEAR testnet
- Captured block: `276345877`
- Block hash: `HVF4oi1E1NBPdjdDY8bYHQJXdre6ZpVzvqZucFfhXfwj`
- Reported contract version: `2.0.0`
- Code hash: `8RMeZ5cXDap6TENxaJKtigRYf3n139iHmTRe8ZUNey6N`
- Code SHA-256: `6e3f1814d40769d8f57b9a7af689d22aaab96d3232cec4d861311829c1d2318f`
- Code size: `469723` bytes
- Raw state hash: `ccf05075e2a4ec999945640a9bff19fea2c5168b8ef1350018ebb30d396156e4`
- Raw state size: `829` bytes across `5` records
- Contract balance: `7000395442672319400000000` yoctoNEAR (`7.0003954426723194` NEAR)
- Existing obligation: proposal `0`, `InProgress` at the captured block, proposer `nima.testnet`, `FunctionCall`
- Policy `proposal_bond`: `1000000000000000000000000` yoctoNEAR (`1` NEAR)
- Policy `proposal_period`: `604800000000000` ns (7 days)
- Submission time: `1622665541332966908` ns (2021); the proposal is expired at the captured block.

The existing operation is `Finalize` on the expired proposal. Source inspection
of the Sputnik `Finalize` path shows an expired proposal is rejected with
`return_bonds=true`, returning `policy.proposal_bond` to the proposer. This is
the public-eligibility basis; it is not a claim that the bond was recovered on
the public chain.

## What was proven

The proof imports the captured account under the **same contract account ID**
into a fresh local Sandbox, preserves the exact raw code and raw state, and
preserves the exact contract balance. It then:

1. calls `get_policy` and `get_proposal` after import;
2. creates a local access key only for the captured proposer/council actor
   `nima.testnet`;
3. runs `Finalize` locally;
4. observes the proposal resolve to `Expired`;
5. observes the recipient `nima.testnet`, the policy bond `1` NEAR, a negative
   contract delta and a positive actor delta;
6. retries `Finalize` and gets `ERR_PROPOSAL_NOT_IN_PROGRESS` with unchanged state;
7. calls `Finalize` from an unauthorized local actor and gets
   `ERR_PERMISSION_DENIED` with unchanged state.

The local actor balance is **synthetic**: `60` NEAR was assigned for local gas.
The captured actor balance was `200765607938634197700000000` yoctoNEAR and is not
claimed as preserved. Any actor gas/funding is separate from the contract
balance.

## Captured/local context

- Captured block height `276345877`; local Sandbox block height `0`.
- Captured block timestamp `1793884499674135800` ns; local Sandbox timestamp is
  recorded in `out/baseline.json` and differs.
- Local runtime: `2.6.2`, protocol `77`, commit
  `2f9ddb711ebd94a306eaec06030d87ef8dfc51fa`.
- The local block/time difference is recorded, not treated as the production
  context.

## Result

See `out/verdict.json` for the machine-readable summary and
`out/baseline.json` for the raw run evidence.

The observed payout fields are:

- recipient: `nima.testnet`
- declared policy bond: `1` NEAR
- contract delta: negative
- actor delta: positive, net of local gas/fees
- retry: failed without mutation
- unauthorized operation: failed without mutation

The exact gross transfer receipt action is not treated as independently proven;
the declared bond and observed balance deltas are reported separately.

## Commands

From the repository root, with `near-workspaces` installed and a pinned
`near-sandbox` `2.6.2` available:

```sh
node case-triage/sputnik-public-capture/capture.cjs
node case-triage/sputnik-public-capture/run-baseline.cjs
node case-triage/sputnik-public-capture/verify-baseline.cjs
```

The capture uses read-only `view_account`, `view_code`, `view_state` and
`call_function` queries. The runner refuses a non-local execution RPC.

On an emulated arm64 host, point `NEAR_SANDBOX_BIN_PATH` and
`NEAR_SANDBOX_BINARY_PATH` at the pinned runtime wrapper and raise the file
descriptor limit:

```sh
export NEAR_SANDBOX_BIN_PATH=/path/to/pinned/near-sandbox
export NEAR_SANDBOX_BINARY_PATH="$NEAR_SANDBOX_BIN_PATH"
ulimit -n 65535
```

`NEAR_RPC` can point at an alternative read-only testnet RPC if the default is
rate-limited.

## Scope limits

This proves one old-layout child DAO, one existing expired-proposal bond-refund
obligation, and a local baseline operation. It does not prove:

- a candidate migration or a corrected candidate;
- arbitrary Sputnik child DAOs or contract families;
- source-to-WASM provenance;
- public recovery of production funds;
- exact production block/time context;
- that a fresh public operation is currently authorized or funded.
