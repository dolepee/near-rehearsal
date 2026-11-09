# NEAR Rehearsal Repair

Generate a source patch for a supported NEAR contract failure, compile it, and check the monetary result with an independent local replay. Download the source diff and the exact tested WASM with their replay evidence.

The supported repair case is [Sputnik DAO #238](https://github.com/near-daos/sputnik-dao-contract/issues/238): a failed asynchronous proposal retains its 1 NEAR bond. Rehearsal asks the configured model for a patch, then independently checks the built contract's bond return, receipt-backed retry, healthy payout and authority behavior. The model cannot edit the acceptance criteria.

## Choose the entry point

The UI serves three distinct local routes. They are not interchangeable:

| You want to... | Start | Runtime | What it proves |
| --- | --- | --- | --- |
| Review a supplied repair without a model account | `/review` | Sandbox **2.14.0**; Rust **1.86.0** only for source-build | A supplied bundle's hashes, candidate identity and declared recovery behavior; either build the supplied patch or replay the recorded WASM |
| Generate a fresh model repair | `/repair` | Sandbox **2.14.0**, Rust **1.86.0**, configured local model provider | Fresh baseline → generated patch → build → fresh replay → persisted-failure recovery → acceptance → diff and review bundle |
| Inspect the older authored comparison | `/` | Sandbox **2.6.2**, no model account or Rust build | Same frozen inherited state → baseline, supplied candidate and correction → verification/export |

The reviewer quickstart is for a supplied candidate and never calls a model. Fresh generation is a separate producer path. The manual comparison at `/` is an advanced authored fixture, not a generated repair.

## Reviewer quickstart: supplied candidate, no model

This is the shortest path for someone who has an accepted repair bundle, or who wants to inspect the checked-in recorded example. It does not require a model login.

### Prerequisites

- Node **24** (the reference version in `.nvmrc`) or Node **26**.
- `npm run setup` in this repository.
- A NEAR Sandbox **2.14.0** binary directory. The supported archives are **Linux x86_64** and **native macOS arm64**. The directory contains `near-sandbox`; pass the directory, not the executable.
- **Recorded WASM replay:** no Rust build and no pinned source checkout.
- **Source build:** additionally a clean checkout of `near-daos/sputnik-dao-contract` at `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`, Rust **1.86.0**, and the `wasm32-unknown-unknown` target.

The checksum-verified runtime download and source/compiler commands are in [local repair setup](docs/local-repair-setup.md#sandbox-runtimes). Do not substitute a newer or older Sandbox release; the acceptance path checks the release, commit and protocol.

### Sandbox 2.14 and pinned source

Linux x86_64:

```sh
REPAIR_RUNTIME="$PWD/.local/sandbox-2.14.0"
mkdir -p "$REPAIR_RUNTIME"
curl --fail --location --max-time 300 \
  https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.14.0/near-sandbox.tar.gz \
  --output "$REPAIR_RUNTIME/archive.tar.gz"
echo "a0ba004218b218bd74351795e7ce2eda4a2b6af5cd3e252bd5e8bfe3c8f2e691  $REPAIR_RUNTIME/archive.tar.gz" | sha256sum -c -
tar -xzf "$REPAIR_RUNTIME/archive.tar.gz" -C "$REPAIR_RUNTIME"
chmod +x "$REPAIR_RUNTIME/Linux-x86_64/near-sandbox"
export REPAIR_SANDBOX_DIR="$REPAIR_RUNTIME/Linux-x86_64"
```

Native macOS arm64:

```sh
REPAIR_RUNTIME="$PWD/.local/sandbox-2.14.0"
mkdir -p "$REPAIR_RUNTIME"
curl --fail --location --max-time 300 \
  https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Darwin-arm64/2.14.0/near-sandbox.tar.gz \
  --output "$REPAIR_RUNTIME/archive.tar.gz"
echo "ea53448ef97540c012e5c3d967c74d78292b0465a98cf7027811a936718fe232  $REPAIR_RUNTIME/archive.tar.gz" | shasum -a 256 -c -
tar -xzf "$REPAIR_RUNTIME/archive.tar.gz" -C "$REPAIR_RUNTIME"
export REPAIR_SANDBOX_DIR="$REPAIR_RUNTIME/Darwin-arm64"
```

For source-build, add a clean checkout and compiler target:

```sh
mkdir -p .local
git clone https://github.com/near-daos/sputnik-dao-contract.git .local/sputnik-source
git -C .local/sputnik-source switch --detach 5434a59dec23ee0c49df8c8c4350c208a7e75b0b
export REPAIR_SOURCE_DIR="$PWD/.local/sputnik-source"
rustup toolchain install 1.86.0 --profile minimal
rustup target add wasm32-unknown-unknown --toolchain 1.86.0
```

`npm run doctor -- --flow repair` checks the Node, dependency and Sandbox configuration without starting a chain. A source-build review also needs `REPAIR_SOURCE_DIR` and the Rust target above.

### Start the reviewer page

Recorded replay is the no-Rust path:

```sh
git clone https://github.com/dolepee/near-rehearsal.git
cd near-rehearsal
git switch main
npm run setup

REPAIR_SANDBOX_DIR=/path/to/near-sandbox-2.14 \
PORT=4174 npm run ui:review
```

Open **http://127.0.0.1:4174/review**, choose **Load example (recorded candidate)**, select **Recorded WASM replay**, and run it.

For source-build, configure the clean pinned source as well:

```sh
REPAIR_SOURCE_DIR=/path/to/sputnik-dao-contract \
REPAIR_SANDBOX_DIR=/path/to/near-sandbox-2.14 \
PORT=4174 npm run ui:review
```

The page then offers **Source build** and **Recorded WASM replay**. Source-build is the default when its prerequisites are present. Both modes verify the bundle hashes and candidate identities before reserving an output directory. Neither calls a model.

The checked-in example is a **recorded model candidate**, not a new model run and not an authored control. The page still performs a fresh local Sandbox execution. A successful result is a review of the supplied candidate and its declared case; it is not a claim that the model generated anything during the review.

### Review from the command line

The browser and the command-line handoff use the same `repair-review` path. See [repair review handoff](docs/repair-review-handoff.md) for the complete failure handling.

```sh
npm run setup

# Source build: apply the supplied patch to the exact clean checkout.
npm run repair:review -- \
  --bundle /path/to/repair-browser-export.json \
  --out /tmp/repair-handoff \
  --source /path/to/sputnik-dao-contract \
  --sandbox-dir /path/to/near-sandbox-2.14

# Recorded WASM replay: no Rust build and no source checkout.
npm run repair:review -- \
  --bundle /path/to/repair-browser-export.json \
  --out /tmp/repair-replay \
  --mode recorded-wasm \
  --sandbox-dir /path/to/near-sandbox-2.14
```

`REPAIR_SANDBOX_DIR=/path/to/near-sandbox-2.14` may be used instead of `--sandbox-dir` in either command. The output directory must be absent or empty. After a successful run inspect `review-result.json`; it records the mode, bundle and source hashes, new or recorded WASM identity, first recovery and retry deltas, preservation and authority checks.

Source-build applies the exported patch to a clean pinned checkout and builds the WASM by executing the patch. Its digest may match or differ from the recorded artifact; either way it is a new execution, not a byte-reproducibility claim. Recorded-WASM mode executes the exact supplied bytes and does **not** claim that a source build produces them. Both modes refuse local source changes or untracked inputs and never merge, publish or upgrade an external contract.

## Generate a fresh model repair

Fresh generation is the only route that asks a model for a patch. It needs your own existing supported Codex CLI login, an available model, the pinned source checkout, a dedicated temporary provider runtime, an enforced provider policy and the Rust build tools. Rehearsal never includes credentials in a bundle. Provider availability, subscription entitlement and output quality are not guaranteed.

Follow [local repair setup](docs/local-repair-setup.md) for those requirements. Then:

```sh
npm run doctor -- --flow repair --generate
ulimit -n 65535
PORT=4174 npm run ui:repair
```

Open **http://127.0.0.1:4174/repair** and choose **Run fresh repair**. The checked launcher reports missing configuration before starting the app. If you start the server directly without a provider, its repair job completes the baseline and reports **Inconclusive**; it never substitutes the authored `repair.patch` as model output. A generated candidate that fails acceptance remains rejected. Only accepted repair results offer a review bundle; available generated patches remain inspectable on failed attempts.

The doctor is a local configuration check, not a login/model call or an execution attestation. Actual generation still verifies the provider boundary and can fail honestly. Running a recorded export or the authored control is not fresh model generation.

## Verify and replay an export

### Repair review bundle

Repair review bundles contain the canonical patch, compiled WASM, candidate identity and the exact serialized baseline, candidate and persisted-recovery reports with matching hashes. The recovery report's exported canonical text and raw execution file have separate digests. See the [repair pipeline documentation](case-triage/rehearsal-repair/README.md) for reconstruction and acceptance, or [rerun the recorded generated artifact](case-triage/rehearsal-repair/README.md#persisted-failure-recovery) without another model call. Fresh chain replay requires Sandbox 2.14.0. Hash checks establish byte consistency, not a cryptographic execution attestation.

### Manual comparison export

The advanced manual comparison exports contain the frozen state, candidate/correction WASMs, receipts and review metadata. Use the repository helper, not command text from an untrusted file:

```sh
node case-triage/sputnik-public-capture/export-helper.cjs verify \
  --export /path/to/sputnik-export.json --out /tmp/sputnik-verify
node case-triage/sputnik-public-capture/export-helper.cjs replay \
  --export /path/to/sputnik-export.json --out /tmp/sputnik-replay \
  --sandbox-dir /path/to/sandbox-2.6.2-directory
```

## Advanced: manual upgrade comparison

This is the older authored comparison. It is useful for inspecting the frozen-state behaviour and export format, but it is **not** the source-repair product and does not generate a model candidate.

The following download is the Linux x86_64 runtime tested by the manual CI job. For native macOS arm64, see [runtime setup](docs/local-repair-setup.md#sandbox-runtimes).

```sh
SANDBOX_DIR="$PWD/.local/sandbox-2.6.2"
mkdir -p "$SANDBOX_DIR"
curl --fail --location --max-time 300 \
  https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.6.2/near-sandbox.tar.gz \
  --output "$SANDBOX_DIR/archive.tar.gz"
echo "58c6d71091bc7a329b9d90784be42d1f313e0bf9fc4e1f2b967d60cdc407cdcf  $SANDBOX_DIR/archive.tar.gz" | sha256sum -c -
tar -xzf "$SANDBOX_DIR/archive.tar.gz" -C "$SANDBOX_DIR"
export NEAR_SANDBOX_BIN_PATH="$SANDBOX_DIR/Linux-x86_64"
export NEAR_SANDBOX_BINARY_PATH="$NEAR_SANDBOX_BIN_PATH"
npm run doctor -- --flow manual
ulimit -n 65535
PORT=4174 npm run ui:sputnik
```

Open **http://127.0.0.1:4174/**. Choose the default bad candidate and correction, then **Run three-branch rehearsal**. The expected recipient changes are baseline **+1 NEAR**, seeded bad candidate **0**, correction **+1 NEAR**. The page shows the same starting state and receipt-derived outcomes. Select **Verify and export** to create a portable review. A contract regression is a completed measured result; infrastructure failures remain inconclusive.

The manual comparison's seeded regression and correction are labelled authored fixtures. When serving both the manual route and repair/review routes in one process, leave `NEAR_SANDBOX_BIN_PATH` and `NEAR_SANDBOX_BINARY_PATH` pointing at 2.6.2, and set `REPAIR_SANDBOX_DIR` separately to 2.14.0. Do not replace one runtime version with the other.

## Supported platforms and runtimes

| Flow | Sandbox | Runtime platform | Build tools | Provider |
| --- | --- | --- | --- | --- |
| `/review` recorded replay | 2.14.0 | Linux x86_64 or native macOS arm64 | None beyond Node | None |
| `/review` source build | 2.14.0 | Linux x86_64 or native macOS arm64 | Rust 1.86.0 + `wasm32-unknown-unknown` | None |
| `/repair` fresh generation | 2.14.0 | Linux x86_64 or native macOS arm64 | Rust 1.86.0 + `wasm32-unknown-unknown` | Existing Codex login, model and enforced policy |
| `/` manual comparison | 2.6.2 | Linux x86_64 or native macOS arm64 | None beyond Node | None |

Node 24 is the reference version; Node 26 is also supported for the offline suite and has been exercised natively on macOS arm64. The runtime archives for **Linux-x86_64** and **Darwin-arm64** are distinct and must not be relabelled. This repository does not claim arbitrary Linux arm64 or Docker-emulation support.

## Install and run the offline tests

Use Node **24** (the reference version in `.nvmrc`) or Node **26**. Both run the offline CI suite.

```sh
git clone https://github.com/dolepee/near-rehearsal.git
cd near-rehearsal
git switch main
npm run setup
npm test
```

`npm run setup` performs the clean install with install hooks ignored and applies the repository's compatibility shim so an explicitly configured Sandbox directory is honored. It does not install Rust, start a chain, log into a provider or purchase anything. `npm test` runs the offline core suite, including report/verifier controls, UI/history behavior and setup failure checks. Its final output explicitly states that live model and Sandbox execution were not run. The real Sandbox flow and Rust/Repair suites run separately in CI.

## Scope and source

- Execution uses local test funds. No public-chain payment, live DAO recovery, automatic public-DAO upgrade, customer adoption or production authorization is claimed.
- The repair target is source revision `5434a59dec23ee0c49df8c8c4350c208a7e75b0b` and `sputnikdao2/src/proposals.rs`. Unsupported families are not automatically repaired.
- Source input, build, artifact identity and declared behavioral checks are independent of the model response. A pass covers the exact code and tested inputs.
- The generated WASM replaces the local account's code without calling `new()`. The recovery checks the first bond return, no additional refund on retry, and preservation of an unpaid healthy Transfer and an already-paid obligation. This uses local account-key deploy plus private `migrate`, not the timed factory or DAO-governance upgrade path.
- The acceptance checks unauthorized update/finalize attempts, an already-paid healthy control, and an inherited unpaid Transfer that still pays its declared beneficiary exactly once.
- `case-triage/rehearsal-repair/` contains the source repair producer/controller/build/replay path.
- `case-triage/sputnik-public-capture/` contains the inherited-state manual comparison and export helper.
- `ui/sputnik/` serves the reviewer, repair and manual routes. `docs/legacy-refund-app.md` preserves the earlier refund example.
- The server binds to localhost by default. This repository does not provide a hosted model service or universally portable Docker image.

## Provenance and release status

- [`provenance.json`](provenance.json) records the fixture, seeded candidates and public first-slice identities. [`substrate/provenance.json`](substrate/provenance.json) records the upstream test-fixture bytes and commits.
- The upstream Sputnik evidence carries its MIT notice at [`case-triage/sputnik-226/review-packet/evidence/SPUTNIK-LICENSE`](case-triage/sputnik-226/review-packet/evidence/SPUTNIK-LICENSE). That upstream notice is not a license for this repository as a whole.
- This repository has no root `LICENSE` file. Licensing and public redistribution are **owner decisions still to be made**; do not assume or add a project license. The private package metadata and the merge/release hold remain in force until the owner explicitly lifts them.

## Repository layout

- `case-triage/rehearsal-repair/` — source repair producer, controller, build, recovery and acceptance path.
- `case-triage/sputnik-public-capture/` — frozen Sputnik state, manual three-branch comparison and portable export helper.
- `ui/sputnik/` — `/review`, `/repair` and `/` local interfaces.
- `docs/` — setup, handoff and release-review notes.
- `test-fixtures/` — the recorded repair bundle used by the reviewer example.
- `provenance.json`, `substrate/provenance.json` — provenance records described above.
