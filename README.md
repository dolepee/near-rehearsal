# NEAR Rehearsal — bounded first slice

A local release-rehearsal workflow for a small NEAR contract already holding user state.

It captures a deployed contract's code and state at a fixed block, imports that state into fresh Sandbox branches, applies a candidate upgrade and migration, and runs the same existing-user operation against baseline, a deliberately bad candidate and the corrected candidate. The output is a pinned report plus a rerunnable regression.

This is a technical slice, not a production release gate or an audit.

## First supported contract

`state.test.near` — a minimal local Sandbox contract with an 8-byte `count`.

- Baseline source: `contracts/state-v1.wat`
- Seeded bad candidate: `contracts/state-v2-buggy.wat` — **SEEDED**, writes the old 8-byte layout from `migrate()`, then the v2 user operation panics.
- Corrected candidate: `contracts/state-v2-fixed.wat` — writes `version = 2` and the preserved count.
- Operation under test: existing user calls `increment()`; result is read with `get()`.

The recorded first capture is:

- Contract: `state.test.near`
- Block: `19`, hash `7mGLgxRWvCuP3W7gksjtdkrA5zdXTexbjbUE5HRuTQfw`
- Code hash: `ATAnoAtxXJks8XDQcaLDrKg3fvoACvT6HH6Vu28QTxrN`
- Code SHA-256: `8c6d5a3d12f1c9ea0253ae97628ba186974ba9ab350d03f5ae0605182f49200b`
- State SHA-256: `48d17bf1f1c1b15e659ea34c07e9cc213467bb6477326608654f701faa7584c3`
- State size: `8` bytes; captured `count = 5`

The contract is deployed only in local Sandbox. It is not a public testnet or mainnet contract. Its state is 8 bytes, well below the default 50 kB import limit. The capture and branch report contain the exact block, code hash, state hash and runtime. A new run will produce a new block hash; the pinned `out/capture.json` is the reproducible reference.

## Observed result

The run in `out/report.json` starts all three branches from the same captured state:

- Baseline: `increment()` succeeds; count `5 -> 6`.
- Seeded bad migration: `migrate()` runs, leaves the old 8-byte layout, and the same `increment()` fails with `state too short: expected v2`.
- Corrected migration: `migrate()` writes the v2 layout; the same `increment()` succeeds; count `5 -> 6`.

`out/regression.json` records the replay command, pinned capture and expected branch outcomes. The bad candidate is labelled everywhere as seeded.

## Run

Node.js 24 is required.

```sh
npm ci --ignore-scripts
node scripts/patch-near-sandbox.cjs
npm run compile
npm run rehearse
npm run verify
```

`npm ci --ignore-scripts` avoids the `near-sandbox` postinstall download on unsupported hosts. The patch makes `NEAR_SANDBOX_BIN_PATH` take precedence so a current binary or wrapper can be supplied.

On a normal Linux x86_64 host, point `NEAR_SANDBOX_BIN_PATH` and `NEAR_SANDBOX_BINARY_PATH` at a directory containing the current `near-sandbox` executable, raise the file-descriptor limit to at least 65535, and run `npm run rehearse`.

On this arm64 host the current x86_64 binary was run through an environment wrapper:

```sh
export NEAR_SANDBOX_REAL_BIN=/path/to/near-sandbox
export NEAR_SANDBOX_QEMU=/path/to/qemu-x86_64
export NEAR_SANDBOX_QEMU_LD_PREFIX=/path/to/x86_64/sysroot
export NEAR_SANDBOX_BIN_PATH=/path/to/dir/containing/sandbox-wrapper
export NEAR_SANDBOX_BINARY_PATH="$NEAR_SANDBOX_BIN_PATH"
ulimit -n 65535
npm run rehearse
```

The wrapper is `scripts/sandbox-wrapper.sh`; the runtime bytes are unmodified. The actual run recorded runtime 2.6.2, protocol 77, commit `2f9ddb711ebd94a306eaec06030d87ef8dfc51fa`.

## Replay from the capture

```sh
npm run replay
```

This reads `out/capture.json` and reruns the three branches without recapturing a baseline. It re-checks the imported code hash and state hash before running the operation.

## Claim boundaries

- Local Sandbox execution only; no public deployment, public transaction or real funds.
- The failing migration is explicitly seeded. No live vulnerability is claimed.
- Matching captured code/state hashes do not prove consensus, complete global chain state or production upgrade authorization.
- The first slice does not support arbitrary contracts, arbitrary migrations, large state, production keys or a hosted reviewer service.
- The report is evidence for one bounded contract and one declared operation, not a safety score.

## Layout

```
contracts/              WAT sources and compiled WASM
rehearse.cjs            capture, import and paired branch runner
scripts/compile-contracts.cjs
scripts/patch-near-sandbox.cjs
scripts/sandbox-wrapper.sh
out/capture.json        pinned code, state, block and runtime
out/report.json         branch outcomes and import checks
out/regression.json     replay contract
substrate/              inspected historical probe material; not product evidence
```

The historical probe material under `substrate/` is included only for provenance. It creates fresh local FT state and patches a callback; it does not capture deployed state or run a migration. It is not the workflow demonstrated here.
