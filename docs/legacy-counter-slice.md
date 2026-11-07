# Historical counter/public slice

This is retained historical documentation for the earlier counter and public testnet slice. The current supported app is described in [README.md](../README.md). It is not the current refund maintainer app.

# NEAR Rehearsal — bounded first slice

A local release-rehearsal workflow for a small NEAR contract already holding user state.

It captures a deployed contract's code and state at a fixed block, imports that state into fresh Sandbox branches, applies a candidate upgrade and migration, and runs the same existing-user operation against baseline, a deliberately bad candidate and the corrected candidate. The output is a pinned report plus a rerunnable regression.

This is a technical slice, not a production release gate or an audit.


## Public first slice (meets the externally deployed condition)

The public slice is `counter.testnet` on NEAR testnet, captured read-only at final block `276146679` (`4gnNG8v5SaJmpDdC49ivXUBmLU1FiGLmw7GQSZC4Dkn5`).

- Source: `https://github.com/tansawit/near-counter-app`, commit `d777350aefa1e76734cbd0ed7633bd072acd511f`, `assembly/main.ts`
- Deployed code hash: `7H96nK1NFTYUUgiRxNER5AjRfUeD4W1TVNC6eKfSgzrf`
- Code SHA-256: `5d4892a56646ca96f76a2632e7d21117ac541a4fc58f661ab2acff5bab7adcac`
- Captured state: `counter = 291`, 3 bytes; state SHA-256 `0c51bd223ce23d8c4decdddd1f7a113a4370610092d7e3fba56140f06d776926`
- Source build check: `near-sdk-as` 0.4.2 built the public source to the same code SHA-256 as the captured deployed bytes.

The declared v2 migration adds a `version` marker (`2`); it preserves the `counter` value. The old-user operation is `incrementCounter({value:1})`, read with `getCounter()`.

- Baseline: `291 -> 292`.
- Seeded bad migration: writes `version = 1`; the same `incrementCounter` panics with `v2 migration missing`.
- Corrected migration: writes `version = 2`; the same operation succeeds; `292`.

Every branch imported the same code hash and state hash. The bad candidate is explicitly seeded. No public writes, no deployment, no production authorization, and no claim that the migration is an upstream release.

The command is `npm run public`; replay is `npm run replay:public`; verification is `npm run verify:public`; the one-page maintainer packet is generated with `npm run review:packet` into `out/release-review.html` and `out/release-review.json`.

`out/public-report.json` retains the transaction hash, final status, receipt failures and structured failure for every operation. `out/public-regression.json` pins the capture hash, runtime, candidate WASM hashes and expected outcomes; `--replay` loads that file rather than hardcoding the current local WASMs.


### Execution guard and replay integrity

Every replay starts with `Worker.init({ network: 'sandbox' })`; after init, the runner requires the execution RPC host to be `127.0.0.1`, `localhost` or `::1` before it creates an account or deploys anything. A configured `NEAR_WORKSPACES_NETWORK=testnet` does not override this.

The exported `operation` is validated, not ignored: this slice accepts only `incrementCounter({value:1})`/`getCounter()`, and rejects any other method, view or args before starting a sandbox. The migration records its before-state before `callRaw('migrate')` and its after-state after the receipt, so `changedState` is a true pre/post comparison. The report distinguishes `capturedRuntime`, `regressionRuntime` and `replayRuntime`.

Transport, read and decode failures are marked `inconclusive`; they cannot become a contract regression. `regressionObserved` requires the bad branch's actual structured receipt failure (`tx.failed === true`), not merely a missing or failed read. The verifier rejects incomplete or inconclusive reports.

The regression manifest's runtime fields are a declared part of the replay. If the actual runtime differs, replay is `inconclusive` and exits nonzero; it does not report a complete regression. The verifier separately compares the manifest, the actual runtime and the report's recorded declaration, so a stale report cannot verify against an altered manifest. A fresh capture has no prior `regressionRuntime` in its report, but its newly written manifest still has to match the actual run.

### Fair baseline and setup

A competent `near-workspaces` maintainer can already call `importContract({ testnetContract: 'counter.testnet', withData: true })` for this 3-byte state. Import is not a unique advantage. The measured delta here is the packaged release-review workflow: pinned public block/code/state, three paired branches, structured receipt outcomes, migration comparison and a replayable export.

No extra operator intervention was needed after the run started. The capture is three read-only RPC queries at one final block; the run starts three local Sandbox branches and one declared migration per candidate. The runtime is 2.6.2/protocol 77 on an x86_64 binary under emulation on this arm64 host, so elapsed time is not a native performance benchmark. See `out/public-effort.json`.

## Earlier local fixture

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
out/release-review.html one-page maintainer review packet
out/release-review.json machine-readable packet evidence
substrate/              inspected historical probe material; not product evidence
```

The historical probe material under `substrate/` is included only for provenance. It creates fresh local FT state and patches a callback; it does not capture deployed state or run a migration. It is not the workflow demonstrated here.
