# Public Sputnik child DAO capture probe

Status: **`capture-baseline-verified`** for one public testnet child DAO; public candidate-upgrade route **unsupported/inconclusive**; local frozen-state three-branch runner **verified**.

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
balance. Gas is reported in gas units; yoctoNEAR amounts are reported from
receipt `tokens_burnt`, with transaction-outcome and receipt totals kept
separate from the declared bond and net balance deltas.

## Captured/local context

- Captured block height `276345877`; local Sandbox block height `0`.
- Captured block timestamp `1793884499674135814` ns, stored as an exact string;
  local Sandbox timestamp is recorded in `out/baseline.json` and differs.
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

## Candidate-upgrade probe

The declared public governance route (`store_blob` → `add_proposal(UpgradeSelf)`
→ `VoteApprove` → `upgrade_self` → `migrate`) was exercised only against the
local import of the captured block. `store_blob` and `add_proposal` succeeded;
`VoteApprove` exhausted the available gas at 300 Tgas and no code was deployed.
This is recorded in `out/candidate-probe.json` as **`incompatible`**. It is a
route/gas finding, not evidence that the candidate migration regressed a user
obligation. No higher-gas or altered-governance detour was taken.

## Frozen-state three-branch runner

`local-three-branch.cjs` builds the old local configured-factory fixture once,
creates its existing obligation, then freezes and exports one bundle:

- exact base code and raw state;
- contract account balance and identity;
- proposer identity, access key and balance;
- recipient balance and proposal/policy views.

Each branch imports that same bundle into a fresh Sandbox and verifies the
state hash, code hash, balances, policy and proposal before any upgrade.

- `baseline`: old state → existing operation → retry.
- `candidate`: old state → **seeded bad candidate** → failed operation →
  retry, classified `regressed` with the raw contract failure and no payout.
  This is a completed red report, not a runner/infrastructure failure.
- `corrected`: **old state → verified-good candidate directly → operation →
  retry**, classified `preserved` (the primary correction comparison).
- `recoveryExperiment`: optional only with `INCLUDE_RECOVERY=1`; old state →
  seeded bad upgrade → failed obligation → repair with the verified-good
  candidate. It is not part of the default three-branch report.

Candidate and correction are independent inputs (`CANDIDATE_WASM`,
`CORRECTED_WASM`). `supported-family.json` records the default example hashes;
the verifier binds the actual supplied bytes to the run's input manifest and
code hashes, so an alternate supported build can be green or red on its own
receipts. The historical healthy candidate is a separate selectable role and is
never labelled broken.

The seeded bad artifact is generated by `build-seeded-bad-candidate.cjs`; it is
the real candidate migration with only `act_proposal` replaced by `unreachable`.
It is a test fixture, not a historical release.

See `out/local-three-branch.json` and `out/local-three-verdict.json`. The
verifier recomputes the frozen raw-code SHA/code hash and sorted raw-storage
hash, binds the actual candidate/correction bytes, requires every root and child
receipt ID to resolve exactly once, decodes the operation and binds method,
action, proposal ID, recipient and amount to the frozen obligation, then derives
the displayed statuses from those facts. It does not trust stored booleans or
cached status. Its output is **offline consistency**, not cryptographic
execution attestation.

## Commands

From the repository root, with `near-workspaces` installed and a pinned
`near-sandbox` `2.6.2` available:

```sh
node case-triage/sputnik-public-capture/capture.cjs
node case-triage/sputnik-public-capture/run-baseline.cjs
node case-triage/sputnik-public-capture/verify-baseline.cjs
node case-triage/sputnik-public-capture/negative-verifier-tests.cjs
node case-triage/sputnik-public-capture/candidate-probe.cjs
WABT_BIN_DIR=/path/to/wabt/bin node case-triage/sputnik-public-capture/build-seeded-bad-candidate.cjs
node case-triage/sputnik-public-capture/local-three-branch.cjs
node case-triage/sputnik-public-capture/verify-local-three.cjs
node case-triage/sputnik-public-capture/negative-local-verifier-tests.cjs
PORT=4174 npm run ui:sputnik
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

The local interface is `ui/sputnik/`; it uses a separate run directory per
click, downloads a self-contained export JSON, and can rerun correction from
the original frozen bundle with a newly selected correction. Completed reports
survive a server restart; interrupted jobs are marked `inconclusive`.

## Scope limits

This proves one old-layout child DAO's capture/import/baseline feasibility, and a
separate local frozen-state candidate/correction comparison. It does not prove a
public candidate migration, public recovery, or that the captured public route
can pay for and execute the upgrade.

It does not prove:
- arbitrary Sputnik child DAOs or contract families;
- source-to-WASM provenance;
- public recovery of production funds;
- exact production block/time context;
- that a fresh public operation is currently authorized or funded.


## Portable export

An export JSON is self-contained. From a clean checkout:

```sh
npm ci
node case-triage/sputnik-public-capture/export-helper.cjs verify   --export /path/to/sputnik-export.json --out /tmp/sputnik-verify
node case-triage/sputnik-public-capture/export-helper.cjs replay   --export /path/to/sputnik-export.json --out /tmp/sputnik-replay   --sandbox-dir /path/to/directory-containing-near-sandbox
```

The sandbox argument is the runtime directory, not the binary file. The helper
unpacks the exported state, report, manifest and actual WASMs, calls the shared
verifier, and only replays with the known local runner. Export command strings
are informational and are never executed.


## Runner job isolation

`local-three-branch.cjs` writes only to an explicit `SPUTNIK_OUT_DIR`. If it is
omitted, it creates a fresh `out/jobs/<timestamp>-<pid>` directory rather than
using the recorded `out/` proof. `FROZEN_BUNDLE` is the input bundle and
`FROZEN_BUNDLE_OUT` is the output path (default `$SPUTNIK_OUT_DIR/local-frozen-bundle.json`).
The UI server allocates a unique run directory per invocation, supplies a distinct
candidate/correction WASM and never reuses a previous report.
