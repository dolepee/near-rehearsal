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
an input manifest. The `healthy` selection resolves to the verified good artifact;
invalid selections clear the old input instead of reusing it. Choosing Upload
clears the current artifact immediately, and Run plus correction rerun stay
disabled until a valid file has been read and hashed; cancelling or selecting an
invalid file leaves the input cleared. The runner labels each artifact from that
manifest, not from a hardcoded filename. Alternate builds are accepted within
the declared family exports (`update`, `migrate`, `act_proposal`).

## Repair journey

`/repair` is the supported Sputnik issue #238 repair slice. It keeps the manual
release-comparison journey at `/` and uses the existing
`case-triage/rehearsal-repair/codex-producer.cjs` and
`repair-pipeline.cjs` as the execution path.

The browser sends only the supported case ID. Configure the local operator
environment on the server (never in the browser):

```sh
REPAIR_SOURCE_DIR=/path/to/pinned/rebuild-base \
REPAIR_SANDBOX_DIR=/path/to/directory-containing-near-sandbox \
MODEL_PRODUCER_SANDBOX_CMD='["<outer-policy-wrapper>","--permission-profile","<profile>","{workspace}","--"]' \
CODEX_PERMISSION_PROFILE='<profile>' \
CODEX_AUTH_SOURCE="$HOME/.codex/auth.json" \
CODEX_BIN="$(command -v codex)" \
PORT=4174 npm run ui:sputnik
```

`REPAIR_SOURCE_DIR` must be the exact pinned source tree. The default base WASM
is the retained `case-triage/rehearsal-repair/bundle/artifacts/base.wasm`.
`CODEX_PRIVATE_RUNTIME` can name a temporary private runtime; no token values
are read into the app. The server checks the configuration and reports missing
items without exposing paths or secrets.

One click starts a fresh baseline reproduction, one model generation, the
pinned build, a local Sandbox replay and the existing acceptance checks. Run
directories are unique under `out/sputnik-ui/repair-runs`. The page shows the
actual `reproducing`, `generating`, `compiling` and `replaying` phases, elapsed
time and one truthful terminal state. It never substitutes a committed report
or authored patch. A generated patch can be downloaded after generation; the
review bundle is available only after an accepted run. Completed results remain
addressable after refresh or restart; interrupted jobs are marked interrupted.

## Reviewer handoff

`/review` is the reviewer-facing entry point for a downloaded repair bundle. It
accepts a JSON bundle in the browser, verifies its declared hashes and
identities, and then runs either `scripts/repair-review.cjs --mode source-build`
with the server-configured pinned source and Rust 1.86 toolchain, or
`--mode recorded-wasm` against the local Sandbox 2.14 directory. The page keeps
addressable history and offers distinct input, evidence and sanitized result
downloads only after acceptance. It does not call a model.

One review runs at a time, in its own process group. Stopping the server
terminates that group with escalating signals, so the build, pipeline and
Sandbox descendants stop too rather than continuing in the background; a review
still open after 35 minutes is stopped the same way and recorded as
interrupted, never accepted. A bundle read that has been superseded, and a
startup restoration of the previous run, are discarded rather than replacing
the reviewer's current choice.

```sh
REPAIR_SANDBOX_DIR=/path/to/directory-containing-near-sandbox \
PORT=4174 npm run ui:review
```

Open `http://127.0.0.1:4174/review`. A newly chosen bundle clears the previous
one and disables Run until its bytes are read and hashed. The example button loads the checked-in
`test-fixtures/repair-browser-export-1de7b8c5.json`; a real replay takes several
minutes under a local Sandbox.

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
