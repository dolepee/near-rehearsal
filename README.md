# NEAR Rehearsal Repair

Check a source repair before merging it: build the patch, execute the supported financial and authority checks, and hand the evidence to another reviewer for an independent rebuild and replay. Optional model generation can propose the patch; it cannot change the acceptance policy.

The supported repair case is [Sputnik DAO #238](https://github.com/near-daos/sputnik-dao-contract/issues/238): a failed asynchronous proposal retains its 1 NEAR bond. Rehearsal asks the configured model for a patch, then independently checks the built contract's bond return, receipt-backed retry, healthy payout and authority behavior. The model cannot edit the acceptance criteria.

## Choose the entry point

The UI serves five local interfaces. They are not interchangeable:

| You want to... | Start | Runtime | What it proves |
| --- | --- | --- | --- |
| Choose a repair path | `/` | None | A static front door: generate a fresh repair or independently review a supplied one. It does not execute or auto-start either path. |
| Review a supplied repair without a model account | `/review` | Sandbox **2.14.0**; Rust **1.86.0** only for source-build | A supplied bundle's hashes, candidate identity and declared recovery behavior; either build the supplied patch or replay the recorded WASM |
| Check a maintainer source patch | `/repair?mode=patch` or `npm run ui:patch` | Sandbox **2.14.0**, Rust **1.86.0**, clean pinned source; **no model account** | The submitted diff, actual built WASM and persisted recovery/preservation checks with a downloadable evidence package |
| Generate a fresh model repair | `/repair` | Sandbox **2.14.0**, Rust **1.86.0**, configured local model provider | Fresh baseline → generated patch → build → fresh replay → persisted-failure recovery → acceptance → diff and review bundle |
| Inspect the older authored comparison | `/compare` (legacy `/index.html`) | Sandbox **2.6.2**, no model account or Rust build | Same frozen inherited state → baseline, supplied candidate and correction → verification/export |

The reviewer quickstart is for a supplied candidate and never calls a model. Fresh generation is a separate producer path. The front door at `/` is navigation only. The authored comparison at `/compare` — with `/index.html` kept as its legacy alias — is an advanced fixture, not a generated repair.

## Start with your source patch

Use **`/repair?mode=patch`** to check a maintainer diff. This is the primary workflow and needs no model account, wallet or API key. Source builds require a supported Linux x86_64 host with PID-namespace confinement. Native macOS supports recorded WASM replay, not source compilation.

**Pending compiler release #26:** the protected source-build instructions below are not available at the pre-merge baseline. Do not compile untrusted patches on that baseline. This documentation change remains held until the implementation and its final review land.

1. Complete the [runtime and source setup](docs/local-repair-setup.md#sandbox-runtimes), including the [compiler boundary and dependency cache](docs/local-repair-setup.md#compiler-boundary-and-dependency-cache).
2. In that same terminal, run `npm run doctor -- --flow repair --mode patch`, then `PORT=4174 npm run ui:patch`.
3. Open **http://127.0.0.1:4174/repair?mode=patch**, submit the supported Sputnik diff and run the checks. An incomplete run is not an accepted repair.
4. For an accepted run, export the review bundle. Open **`/review`**, select that bundle and choose **Source build** to independently rebuild and rerun it. Download the reviewer's own fresh evidence after acceptance.

This supports one pinned Sputnik source family, not arbitrary NEAR contracts. The public site shows recorded execution; these commands run a fresh local Sandbox. Source review needs an enforced compiler launcher; it stops with `BUILD_BOUNDARY_UNAVAILABLE` when that protection cannot run. Do not disable host protections to get past the check.

Already have a review bundle? Continue with the reviewer quickstart below. **Recorded WASM replay** needs the pinned Sandbox but neither Rust nor a compiler launcher; it does not establish source-to-WASM reproducibility.

## Reviewer quickstart: supplied candidate, no model

This is the shortest path for someone who has an accepted repair bundle, or who wants to inspect the checked-in recorded example. It does not require a model login.

### Prerequisites

- Node **24** (the reference version in `.nvmrc`) or Node **26**.
- `npm run setup` in this repository.
- A NEAR Sandbox **2.14.0** binary directory. The supported archives are **Linux x86_64** and **native macOS arm64**. The directory contains `near-sandbox`; pass the directory, not the executable.
- **Recorded WASM replay:** no Rust build and no pinned source checkout.
- **Source build:** additionally a clean checkout of `near-daos/sputnik-dao-contract` at `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`, Rust **1.86.0**, the `wasm32-unknown-unknown` target, and a supported Linux x86_64 host, and the [enforced compiler boundary and fetched dependency cache](docs/local-repair-setup.md#compiler-boundary-and-dependency-cache).

The checksum-verified runtime download and source/compiler commands are in [local repair setup](docs/local-repair-setup.md#sandbox-runtimes). Do not substitute a newer or older Sandbox release; the acceptance path checks the release, commit and protocol.

### Get the repository

Use one clone and run the setup once, before the `.local` runtime/source commands below:

```sh
git clone https://github.com/dolepee/near-rehearsal.git
cd near-rehearsal
git switch main
npm run setup
```

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

`npm run doctor -- --flow repair` checks the Node, dependency and Sandbox configuration without starting a chain. For source-build readiness, use `npm run doctor -- --flow repair --mode patch`; this additionally checks the clean source, Rust target and live compiler boundary. Fetch the pinned dependency cache as described in the linked setup first.

### Start the reviewer page

Stay in the repository root and the same shell where you exported
`REPAIR_SANDBOX_DIR` above. Recorded replay is the no-Rust path:

```sh
PORT=4174 npm run ui:review
```

Open **http://127.0.0.1:4174/review**, choose **Load example (recorded candidate)**, select **Recorded WASM replay**, and run it.

For source-build, complete the optional pinned-source and compiler steps above
before starting the server. If it is already running, stop it and run the same
start command again after exporting `REPAIR_SOURCE_DIR`.

On a supported Linux source-build host the page offers **Source build** and **Recorded WASM replay**. On native macOS, source build is unavailable; use recorded replay. Source-build is the default when its prerequisites are present. Both modes verify the bundle hashes and candidate identities before reserving an output directory. Neither calls a model.

The checked-in example is a **recorded model candidate**, not a new model run and not an authored control. The page still performs a fresh local Sandbox execution. A successful result is a review of the supplied candidate and its declared case; it is not a claim that the model generated anything during the review.

### Review from the command line

The browser and the command-line handoff use the same `repair-review` path.
After setup and the runtime export above, these commands run the
settlement-fixed candidate without Rust or a model account. See [repair review handoff](docs/repair-review-handoff.md) for the complete failure handling.

The bundle is assembled from the tracked artifacts of the accepted source run,
so it is rebuilt rather than stored twice:

```sh
node case-triage/rehearsal-repair/handoff-bundle.cjs /tmp/settlement-fixed-bundle.json

npm run repair:review -- \
  --bundle /tmp/settlement-fixed-bundle.json \
  --out .local/review-recorded \
  --mode recorded-wasm
```

For source-build, first complete the optional source/compiler steps and export
`REPAIR_SOURCE_DIR` above, then run:

```sh
npm run repair:review -- \
  --bundle /tmp/settlement-fixed-bundle.json \
  --out .local/review-source \
  --source "$REPAIR_SOURCE_DIR"
```

The checked-in `test-fixtures/repair-browser-export-1de7b8c5.json` is the
8 November recorded model candidate. It predates the failed-refund settlement
policy and is now rejected at that gate: it returns the bond but drops the
locked liability and pays no retry. It is kept as the historical record and as
a negative control, so use the rebuilt bundle for an accepted handoff.

Both commands use the exported `REPAIR_SANDBOX_DIR`; `--sandbox-dir` is available
if you prefer passing the real binary directory explicitly. To review your own
download, replace only the `--bundle` value. The output directory must be absent
or empty: choose a new `--out` directory for each repeat. After a successful run
inspect `review-result.json`; it records the mode, bundle and source hashes, new
or recorded WASM identity, first recovery and retry deltas, preservation and
authority checks.

Source-build applies the exported patch to a clean pinned checkout and builds the WASM by executing the patch. Its digest may match or differ from the recorded artifact; either way it is a new execution, not a byte-reproducibility claim. Recorded-WASM mode executes the exact supplied bytes and does **not** claim that a source build produces them. Source-build refuses local source changes or untracked inputs; recorded-WASM does not require or inspect a source checkout. Both modes verify the bundle identity and require an absent or empty output directory, and neither merges, publishes or upgrades an external contract.

## Review a maintainer patch

A maintainer can submit a source diff directly, without first producing a
Rehearsal bundle and without a model account:

```sh
npm run review:patch -- \
  --patch /path/to/candidate.diff \
  --source "$REPAIR_SOURCE_DIR" \
  --out .local/review-patch \
  --sandbox-dir "$REPAIR_SANDBOX_DIR"
```

The command reuses the pinned build, fresh replay and persisted-recovery
acceptance. It writes `ACCEPTED`, `REJECTED`, `INPUT_ERROR`, `BUILD_ERROR` or
`INCONCLUSIVE` with the patch, logs and hashes preserved. `ACCEPTED` means the
defined checks passed for this case, not that the patch is universally safe.
Caller-supplied repository/base/head labels are recorded as supplied metadata,
not verified provenance. See [review a maintainer patch](docs/review-patch.md).

## Generate a fresh model repair

Fresh generation is the only route that asks a model for a patch. It needs your own existing supported Codex CLI login, an available model, the pinned source checkout, a dedicated temporary provider runtime, an enforced provider policy and the Rust build tools. Rehearsal never includes credentials in a bundle. Provider availability, subscription entitlement and output quality are not guaranteed.

Follow [local repair setup](docs/local-repair-setup.md) for those requirements. Then:

```sh
npm run doctor -- --flow repair --generate
ulimit -n 65535
PORT=4174 npm run ui:repair
```

Open **http://127.0.0.1:4174/repair** and choose **Run fresh repair**. The checked launcher reports missing configuration before starting the app.

For the model-free source-patch route, use the separate launcher:

```sh
npm run doctor -- --flow repair --mode patch
PORT=4174 npm run ui:patch
```

This checks the pinned source, Rust/Sandbox and the local checker, but never provider credentials. Open **http://127.0.0.1:4174/repair?mode=patch**. The existing `ui:repair` generator command remains unchanged. If you start the server directly without a provider, its repair job completes the baseline and reports **Inconclusive**; it never substitutes the authored `repair.patch` as model output. A generated candidate that fails acceptance remains rejected. Only accepted repair results offer a review bundle; available generated patches remain inspectable on failed attempts.

The doctor is a local configuration check, not a login/model call or an execution attestation. Actual generation still verifies the provider boundary and can fail honestly. Running a recorded export or the authored control is not fresh model generation.

## Verify and replay an export

### Repair review bundle

Repair review bundles contain the canonical patch, compiled WASM, candidate identity and the exact serialized baseline, candidate and persisted-recovery reports with matching hashes. The recovery report's exported canonical text and raw execution file have separate digests. See the [repair pipeline documentation](case-triage/rehearsal-repair/README.md) for reconstruction and acceptance, or [rerun the recorded generated artifact](case-triage/rehearsal-repair/README.md#persisted-failure-recovery) without another model call. Fresh chain replay requires Sandbox 2.14.0. Hash checks establish byte consistency, not a cryptographic execution attestation.

### Authored comparison export

The advanced authored comparison exports contain the frozen state, candidate/correction WASMs, receipts and review metadata. Use the repository helper, not command text from an untrusted file:

```sh
node case-triage/sputnik-public-capture/export-helper.cjs verify \
  --export /path/to/sputnik-export.json --out /tmp/sputnik-verify
node case-triage/sputnik-public-capture/export-helper.cjs replay \
  --export /path/to/sputnik-export.json --out /tmp/sputnik-replay \
  --sandbox-dir /path/to/sandbox-2.6.2-directory
```

## Advanced: authored upgrade comparison

This is the older authored comparison at `/compare`. It is useful for inspecting the frozen-state behaviour and export format, but it is **not** the source-repair product and does not generate a model candidate. `/index.html` is retained as its legacy alias.

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

Open **http://127.0.0.1:4174/compare**. Choose the default bad candidate and correction, then **Run three-branch rehearsal**. The expected recipient changes are baseline **+1 NEAR**, seeded bad candidate **0**, correction **+1 NEAR**. The page shows the same starting state and receipt-derived outcomes. Select **Verify and export** to create a portable review. A contract regression is a completed measured result; infrastructure failures remain inconclusive.

The authored comparison's seeded regression and correction are labelled fixtures. When serving `/compare` and the repair/review routes in one process, leave `NEAR_SANDBOX_BIN_PATH` and `NEAR_SANDBOX_BINARY_PATH` pointing at 2.6.2, and set `REPAIR_SANDBOX_DIR` separately to 2.14.0. Do not replace one runtime version with the other.

## Supported platforms and runtimes

| Flow | Sandbox | Tested chain/build coverage | Build tools | Provider generation |
| --- | --- | --- | --- | --- |
| `/review` recorded replay | 2.14.0 | Linux x86_64 CI; native macOS arm64 chain/replay exercised | None beyond Node | None |
| `/review` source build | 2.14.0 | Linux x86_64 CI; native macOS arm64 build/replay exercised | Rust 1.86.0 + `wasm32-unknown-unknown` | None |
| `/repair` fresh generation | 2.14.0 | Linux x86_64 CI covers source build/replay; it does not exercise a live model provider | Rust 1.86.0 + `wasm32-unknown-unknown` | Existing Codex login, model and enforced policy; local prerequisite, not CI-proven |
| `/compare` authored comparison (legacy `/index.html`) | 2.6.2 | Linux x86_64 CI; native macOS arm64 chain/replay exercised | None beyond Node | None |

Linux CI proves the source build/replay and manual chain paths. It does **not** prove Linux live model generation; provider availability, entitlement and output quality remain local prerequisites and separate from those CI results. Node 24 is the reference version; Node 26 is also supported for the offline suite and has been exercised natively on macOS arm64. The runtime archives for **Linux-x86_64** and **Darwin-arm64** are distinct and must not be relabelled. This repository does not claim arbitrary Linux arm64 or Docker-emulation support.

## Install and run the offline tests

Use Node **24** (the reference version in `.nvmrc`) or Node **26**. Both run the offline CI suite. From the repository root after the setup above:

```sh
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
- `ui/sputnik/` serves `/` (front door), `/review`, `/repair`, and `/compare` with `/index.html` as its legacy alias. `docs/legacy-refund-app.md` preserves the earlier refund example.
- The server binds to localhost by default. This repository does not provide a hosted model service or universally portable Docker image.

## Provenance and attribution

- [`provenance.json`](provenance.json) records the fixture, seeded candidates and public first-slice identities. [`substrate/provenance.json`](substrate/provenance.json) records the upstream test-fixture bytes and commits.
- The supported case is [Sputnik DAO #238](https://github.com/near-daos/sputnik-dao-contract/issues/238), and the tested source is [`near-daos/sputnik-dao-contract` at `5434a59`](https://github.com/near-daos/sputnik-dao-contract/tree/5434a59dec23ee0c49df8c8c4350c208a7e75b0b).
- The upstream Sputnik evidence includes its MIT notice at [`case-triage/sputnik-226/review-packet/evidence/SPUTNIK-LICENSE`](case-triage/sputnik-226/review-packet/evidence/SPUTNIK-LICENSE). That notice is retained as upstream attribution.

## Evidence boundary

An independent baseline using ordinary `near-workspaces` reproduced the same stranded-bond recovery and healthy controls with the existing repair candidate. It did not generate a new repair or compare the complete product workflow. Rehearsal combines source repair, persisted-state verification, portable evidence and independent reviewer handoff. A speed advantage or maintainer preference for that complete workflow has not been established.

## License, attribution and source window

The repository's original code is licensed under [GPL-3.0-only](LICENSE); upstream components retain their own terms. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSES/](LICENSES/) for the upstream texts and the recorded package/source discrepancies.

Rehearsal's implementation was developed during the hackathon window beginning 19 October 2026 with AI coding assistance. Upstream source and tools predate the project and are credited in the notice above. Authored fixtures are kept distinct from the [actual recorded model-generated reviewer candidate](test-fixtures/repair-browser-export-1de7b8c5.json).

`near-workspaces`, `wabt`, Node.js packages and the NEAR Sandbox runtime are downloaded dependencies, not bundled in this repository; `node_modules/` is not tracked.

## Repository layout

- `case-triage/rehearsal-repair/` — source repair producer, controller, build, recovery and acceptance path.
- `case-triage/sputnik-public-capture/` — frozen Sputnik state, manual three-branch comparison and portable export helper.
- `ui/sputnik/` — `/` front door, `/review`, `/repair`, and `/compare` with `/index.html` as its legacy alias.
- `docs/` — setup, handoff and release-review notes.
- `test-fixtures/` — the recorded repair bundle used by the reviewer example.
- `provenance.json`, `substrate/provenance.json` — provenance records described above.
