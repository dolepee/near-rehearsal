# Independent SDK baseline — issue #238

Two runs are kept deliberately separate:

- First run: 2026-11-08 02:24–02:38 UTC (03:24–03:38 WAT). Raw file:
  `research/sdk-baseline-report-first.json`. It compared the unpatched upstream source and
  recorded `sourceHashMatches: false`; that is preserved, not overwritten.
- Corrected run: source path points at the patch-applied source, output is
  `research/sdk-baseline-report-applied-source.json`.

Isolated branch `research/sdk-baseline`.

## Purpose

Check the generated `e8262f5a` artifact through ordinary `near-workspaces` flows, independently of
Rehearsal's runner and report checker. The script uses the pinned Sputnik base artifact, replaces it
with the candidate artifact, and observes published DAO state and balance outcomes after a
pre-upgrade proposal fails because its action targets a missing account.

## Inputs

- Base WASM SHA-256: `5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578`
- Candidate WASM SHA-256: `49a5120cee5f4e453a37e40b18231ce9b0fef95c08dca4fdbf23f102937eb923`
- Patch SHA-256: `532741a3f689863844d0af147ec08d278420cd74920f68f817234747e295fedc`
- Candidate code hash: `5xUkZovAU6pY3opPEaDxZcX1qz92E6mGimGGzq9NsqbG`
- Base code hash: `74poc4ikfTRgzo8oWnFdQzg3gPtsu4VYcL1z5p653nMm`
- Runtime: Sandbox 2.14.0, commit `bc4e9e8cfb03d9e82f027883055624e18576993e`, protocol 88.
- Applied source: `research/applied-source/sputnikdao2/src/proposals.rs`, SHA-256
  `82efc4225e307b97068cd7bd984da78f9a83ecf51e1b21749de344f45aa53b22`, produced by applying
  `repair.patch` to upstream commit `5434a59…` in a clean worktree. See the README beside it.

## Command

```bash
NODE_PATH=/path/to/near-rehearsal/repo/node_modules \
NEAR_SANDBOX_BIN_PATH=/path/to/near-sandbox-2.14-wrapper \
NEAR_SOURCE_FILE=research/applied-source/sputnikdao2/src/proposals.rs \
NEAR_UPSTREAM_SOURCE=/path/to/sputnik-dao-contract/sputnikdao2/src/proposals.rs \
NEAR_BASELINE_OUT=research/sdk-baseline-report-applied-source.json \
node research/sdk-baseline.cjs
```

All inputs are overridable: `NEAR_REPAIR_DIR`, `NEAR_BASE_WASM`, `NEAR_CANDIDATE_WASM`,
`NEAR_PATCH`, `NEAR_IDENTITY`, `NEAR_SOURCE_FILE`, `NEAR_UPSTREAM_SOURCE`, `NEAR_BASELINE_OUT`.
Relative paths resolve from the repository root.

## Result

The old code reproduced the missing-target failure. After deploying and migrating to the candidate:

- A single Finalize returned the proposal bond: locked balance moved from 1 NEAR to 0, contract
  balance fell by exactly 1 NEAR, and the proposer received that 1 NEAR less transaction gas.
- The failed proposal's action still did not pay `missing-target.test.near`; recipient balance
  delta was exactly 0.
- A second Finalize did not return another bond; locked delta was 0 and contract balance was
  unchanged.
- Both Finalizes executed with the candidate code hash.
- Pre-upgrade and post-upgrade inherited raw state, policy, proposal and locked bond were identical.
- The missing-target receipt failed with `AccountDoesNotExist` as expected; successful finalization
  receipts were not required to be failure-free.

Healthy controls, on a separate sandbox:

- An already-approved transfer stayed paid across upgrade and a later Finalize.
- An inherited, unpaid healthy transfer survived the upgrade unchanged and paid exactly once when
  approved.
- Its bond returned once, with the vote and preceding failed-Finalize gas accounted for.
- The paid proposal's finalization was rejected as not in progress and did not pay again.

The script now fails nonzero if any required boolean is not true, while still writing the raw report
first. All checks in the corrected raw report are true.

## Timing

- One-time authoring/setup this turn: about 4 minutes for the clean worktree, patch application,
  portable-path changes and assertion wiring. This is not part of the measured run.
- Repeated run: **306,414 ms (5 min 6.4 s)**, from process start to report write. It includes two
  fresh sandboxes: the recovery workflow and the separate healthy-controls workflow, with all
  settlement waits.

## Limit

This is one matched-artifact run with two independent `near-workspaces` sandboxes. It does not
establish a general benchmark, does not use Rehearsal's report schema, and does not resolve any
broader product questions.
