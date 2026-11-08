# Repair review handoff

This is the operator path for a downloaded Sputnik #238 repair bundle. It is
intended for a clean checkout and a separate output directory. The bundle is
data, not instructions: every hash and identity used by the run is checked
before a file is written or a command is executed.

## Prerequisites

For `source-build` (the default):

- Node.js and `npm run setup` in this repository. The setup command performs
  the supported clean install with install hooks ignored and applies the
  compatibility shim.
- Git checkout of `near-daos/sputnik-dao-contract` at
  `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`.
- Rust `1.86.0` with the `wasm32-unknown-unknown` target.
- A supplied NEAR Sandbox `2.14.0` binary directory, passed with
  `--sandbox-dir` or `REPAIR_SANDBOX_DIR`. The runtime's version, commit and
  protocol are checked by the existing acceptance code.

For `--mode recorded-wasm`, Rust and the source checkout are not required.
Neither mode downloads a runtime, calls a model, publishes anything or
upgrades an external contract.

## Browser reviewer

For a bundle-only review, start the local UI and open `/review`. Source-build
needs both the clean pinned source checkout and the Sandbox directory:

```sh
REPAIR_SOURCE_DIR=/path/to/clean/sputnik-dao-contract \
REPAIR_SANDBOX_DIR=/path/to/near-sandbox-2.14 \
PORT=4174 npm run ui:review
```

For recorded-only review, omit the source checkout:

```sh
REPAIR_SANDBOX_DIR=/path/to/near-sandbox-2.14 PORT=4174 npm run ui:review
```

Open `http://127.0.0.1:4174/review`, select the bundle JSON or load the example,
then choose one of the two modes:

- **Source build** (default when configured) applies the supplied patch to the
  server-configured pinned checkout, builds with Rust 1.86.0 and
  `wasm32-unknown-unknown`, then runs the persisted recovery and acceptance.
- **Recorded WASM replay** executes the supplied artifact without a build.

The page uses the same `repair-review` CLI, keeps addressable history and offers
distinct input, evidence and sanitized result downloads only after acceptance.
It does not expose host paths or raw runtime files. The example is a recorded
model candidate; the page still executes it in a fresh Sandbox.

A review runs as its own process group, so stopping the server terminates the
build, pipeline and Sandbox descendants rather than leaving them running; the
35-minute limit does the same and records the run as interrupted. Selecting a
bundle clears the previous candidate and disables Run until the new bytes are
read and hashed, and a delayed startup restoration never replaces a run the
reviewer opened explicitly.

## Commands

```sh
npm run setup
npm run test:repair-review

npm run repair:review -- \
  --bundle test-fixtures/repair-browser-export-1de7b8c5.json \
  --out /tmp/repair-handoff \
  --source /path/to/sputnik-dao-contract \
  --sandbox-dir /path/to/near-sandbox-2.14
```

The output directory must be absent or empty. The command verifies:

- bundle schema, run and case identity;
- exact patch text and compiled WASM bytes;
- baseline and recovery canonical report text;
- the recorded recovery acceptance and artifact identities;
- the candidate source identity;
- the supplied base WASM hash;
- the exact clean source checkout HEAD (source-build mode), including no
  untracked inputs;
- the new build's identity against the pipeline report.

A failure is reported before the chain is started. A mismatch is never
repaired by substituting a default or reusing another run's artifact.

## Modes are not interchangeable

`source-build` produces a WASM by executing the supplied patch. Its digest may
match the recorded artifact or differ; either way this is a new execution, not a
byte-reproducibility claim. The result file records both digests.

`recorded-wasm` runs the exact supplied candidate bytes. It proves that the
artifact can be unpacked and executed, but it does **not** prove that a source
build produces those bytes. The result file labels it accordingly.

The source checkout must be a clean pinned tree: tracked changes and untracked
inputs are rejected before the build. A dirty or locally modified tree is not
the source revision named by the bundle.

## Evidence and outcome

After a successful run, inspect:

- `review-result.json` — mode, bundle and source hashes, new/recorded WASM,
  first recovery gross/gas/proposer-net, retry gross/gas/proposer-net and signed
  account deltas, preservation and authority checks;
- `source-build/pipeline.json` — patch application, toolchain, new artifact and
  fresh-state checks;
- `source-build/candidate-identity.json` — the new build's identity;
- `source-build/persisted/persisted-recovery.json` — the actual inherited
  failure, upgrade, first recovery, retry and healthy controls;
- `source-build/persisted/persisted-recovery-acceptance.json` — recomputed
  acceptance result and errors;
- `input/` — the verified bundle reports, patch and recorded WASM.

The acceptance checks the first 1 NEAR bond recovery, no additional principal
on retry, preservation of the already-failed proposal and its locked state,
rejection of unauthorized update/finalize attempts, an already-paid healthy
control, and an inherited unpaid Transfer that still pays its declared
beneficiary exactly once. These are local Sandbox results for the declared
case, not production authorization.

## Failure handling

Common blockers and the honest response:

- **`near-workspaces` missing** — run `npm run setup` in this repository. The chain
  must not be started with a partially installed workspace.
- **source HEAD mismatch** — check out the exact commit; do not edit the
  recorded source identity to fit a newer tree.
- **base WASM mismatch** — use the base artifact shipped with the repository;
  do not replace it with the candidate or an authored control.
- **Sandbox unavailable** — supply a verified 2.14.0 directory; do not relabel
  an older runtime.
- **acceptance failure** — keep the raw report. A rejected candidate is a
  measured failure, not a reason to switch modes silently.

If a run fails after preflight, the output directory is deliberately retained
with the raw input and any execution evidence. Use a new `--out` for a retry;
the command never silently reuses a partial run.

The command does not merge, open a pull request, publish a report or perform a
live upgrade. Those are separate review actions.
