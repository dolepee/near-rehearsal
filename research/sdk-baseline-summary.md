# Independent SDK baseline — issue #238

Run: 2026-11-08 02:24–02:38 UTC (03:24–03:38 WAT). Isolated branch `research/sdk-baseline`.

## Purpose

Check the generated `e8262f5a` artifact through ordinary `near-workspaces` flows, independently of
Rehearsal's runner and report checker. The script uses the pinned Sputnik base artifact, replaces it
with the candidate artifact, and observes the published DAO state and balance outcomes after a
pre-upgrade proposal fails because its action targets a missing account.

## Inputs

- Base WASM SHA-256: `5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578`
- Candidate WASM SHA-256: `49a5120cee5f4e453a37e40b18231ce9b0fef95c08dca4fdbf23f102937eb923`
- Patch SHA-256: `532741a3f689863844d0af147ec08d278420cd74920f68f817234747e295fedc`
- Candidate code hash: `5xUkZovAU6pY3opPEaDxZcX1qz92E6mGimGGzq9NsqbG`
- Base code hash: `74poc4ikfTRgzo8oWnFdQzg3gPtsu4VYcL1z5p653nMm`
- Runtime: Sandbox 2.14.0, commit `bc4e9e8cfb03d9e82f027883055624e18576993e`, protocol 88.
- Source provenance: `candidate-identity.json` records source `82efc422…`; the checked-in
  `sputnikdao2/src/proposals.rs` at the pinned head hashes to `40ff4577…`. This mismatch is preserved
  in the output as `sourceHashMatches: false` and remains unresolved. It does not affect the WASM
  identities above.

## Command

```bash
NODE_PATH=/workspace/near-rehearsal/repo/node_modules \
NEAR_SANDBOX_BIN_PATH=/workspace/tools/near-sandbox-2.14-wrapper \
node research/sdk-baseline.cjs
```

Raw evidence: `research/sdk-baseline-report.json`.

## Result

The old code reproduced the missing-target failure. After deploying and migrating to the candidate:

- A single Finalize returned the proposal bond: locked balance moved from 1 NEAR to 0, contract
  balance fell by 1 NEAR, and the proposer received that 1 NEAR less the transaction gas.
- The failed proposal's action still did not pay `missing-target.test.near`; recipient balance
  delta was exactly 0.
- A second Finalize did not return another bond; locked delta was 0 and the contract balance was
  unchanged.
- Both Finalizes executed with the candidate code hash.

Healthy controls, on a separate sandbox:

- An already-approved transfer stayed paid across upgrade and a later Finalize.
- An inherited, unpaid healthy transfer survived the upgrade unchanged and paid exactly once when
  approved.
- Its bond returned once, with the vote and the preceding failed-Finalize gas accounted for.
- The paid proposal's finalization was rejected as not in progress and did not pay again.

All recorded checks are `true` in the raw report.

## Limit

This is one matched-artifact run with two independent `near-workspaces` sandboxes. It does not
establish a general benchmark, does not use Rehearsal's report schema, and does not resolve the
source-hash provenance mismatch.
