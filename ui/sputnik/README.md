# Sputnik local rehearsal interface

Consequence-first local page for the supported `sputnik-dao-v2` frozen-state
case. It invokes the real `case-triage/sputnik-public-capture/local-three-branch.cjs`
runner; it does not load a committed report as a fresh result.

## Run

```sh
PORT=4174 npm run ui:sputnik
```

Open `http://127.0.0.1:4174`.

Required local environment:

```sh
export NODE_PATH=/path/to/node_modules
export NEAR_SANDBOX_BIN_PATH=/path/to/near-sandbox
export NEAR_SANDBOX_BINARY_PATH="$NEAR_SANDBOX_BIN_PATH"
```

## Inputs

- Candidate: the default seeded-bad fixture, the historical healthy candidate,
  or an uploaded supported-family WASM.
- Correction: the verified-good correction or an uploaded supported-family
  WASM.

The browser computes SHA-256; the server revalidates bytes and hashes and writes
an input manifest. The runner labels each artifact from that manifest, not from
a hardcoded filename. Alternate builds are accepted within the declared family
exports (`update`, `migrate`, `act_proposal`).

## Outcomes

The default run is expected to show:

- baseline: `preserved`
- seeded candidate: `regressed` with a failed contract call and zero recipient payout
- correction: `preserved`

The verifier derives those statuses from receipts and balances. A healthy
candidate can produce an all-green completed report; a broken correction stays
`regressed`. Runtime/RPC failure is `inconclusive`.

## Same-bundle rerun and export

After a complete run, **Rerun correction from same frozen bundle** starts a new
run with the original candidate and frozen bundle, and the **current Correction
selection** (including an uploaded correction). The selected bytes are validated
and written into the new run; the previous report remains addressable by its run
ID.

**Verify and export** runs the verifier and writes `export.json` under the run
directory. The export is a self-contained JSON download containing the frozen
state, actual candidate/correction bytes and hashes, input manifest, raw report
and verdict. The emitted verify command uses the run directory, not its `out`
subdirectory. A server restart preserves completed reports and marks interrupted
jobs inconclusive; the page turns repeated missing-job polls into a terminal
retry message.


## Portable export reproduction

The downloaded export JSON is self-contained. Use the repo helper, not the
command text embedded in an untrusted export:

```sh
node case-triage/sputnik-public-capture/export-helper.cjs verify   --export /path/to/sputnik-export.json --out /tmp/sputnik-verify

node case-triage/sputnik-public-capture/export-helper.cjs replay   --export /path/to/sputnik-export.json --out /tmp/sputnik-replay   --sandbox-dir /path/to/directory-containing-near-sandbox
```

`--sandbox-dir` is the **directory** containing the patched `near-sandbox`
binary, not the binary path itself. The helper unpacks the included frozen
bundle, candidate/correction bytes, manifest and raw report, verifies them with
the shared verifier, and only replays through the known runner. It does not
execute shell text from the export.
