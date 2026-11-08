# NEAR Rehearsal Repair

Generate a source patch for a supported NEAR contract failure, compile it, and check the monetary result with an independent local replay. Download the source diff and the exact tested WASM with their replay evidence.

The supported repair case is [Sputnik DAO #238](https://github.com/near-daos/sputnik-dao-contract/issues/238): a failed asynchronous proposal retains its 1 NEAR bond. Rehearsal asks the configured model for a patch, then independently checks the built contract's bond return, receipt-backed retry, healthy payout and authority behavior. The model cannot edit the acceptance criteria.

## Choose a workflow

| Workflow | Open | Runtime | What it executes |
| --- | --- | --- | --- |
| Source repair | `/repair` | Sandbox **2.14.0**, Rust **1.86.0**, configured local model provider | Fresh baseline → generated patch → build → fresh replay → persisted-failure recovery → acceptance → diff and review bundle |
| Manual upgrade comparison | `/` | Sandbox **2.6.2**, no model account or Rust build needed | Same frozen inherited state → baseline, supplied candidate and correction → verification/export |

These are different tested flows. Do not replace one runtime version with the other. The manual comparison's seeded regression and correction are labelled authored fixtures. Source repair requires both fresh-state replay and recovery of a proposal that actually failed on the pinned old code. The same generated WASM replaces that account's code without calling `new()`. The recovery checks the first bond return, no additional refund on retry, and preservation of an unpaid healthy Transfer and an already-paid obligation. This uses local account-key deploy plus private `migrate`, not the timed factory or DAO-governance upgrade path. A successful result covers its declared local case, not arbitrary contracts or production safety.

## Install and run the offline tests

Use Node **24** (the reference version in `.nvmrc`) or Node **26**. Both run the offline CI suite. Native macOS arm64 execution has also been exercised on Node 26. Requirements for the actual chain/build paths are listed below.

```sh
git clone https://github.com/dolepee/near-rehearsal.git
cd near-rehearsal
git switch main
npm run setup
npm test
```

`setup` uses `npm ci --ignore-scripts`, then applies the repository's compatibility shim so an explicitly configured Sandbox directory is honored. It does not install Rust, start a chain, log into a provider or purchase anything. `npm test` runs the offline core suite, including report/verifier controls, UI/history behavior and setup failure checks. Its final output explicitly states that live model and Sandbox execution were not run. The real Sandbox flow and Rust/Repair suites run separately in CI.

## Try the manual comparison without a model account

The following download is the Linux x86_64 runtime tested by the manual CI job. For native macOS arm64 and the repair runtime, see [runtime setup](docs/local-repair-setup.md#sandbox-runtimes).

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

## Run a genuine model repair

The local producer needs your own existing supported Codex CLI login, an available model, the pinned source checkout, a dedicated temporary provider runtime, an enforced provider policy and the Rust build tools. Rehearsal never includes credentials in a bundle. Provider availability, subscription entitlement and output quality are not guaranteed.

Follow [local repair setup](docs/local-repair-setup.md) to configure those requirements. Then:

```sh
npm run doctor -- --flow repair --generate
ulimit -n 65535
PORT=4174 npm run ui:repair
```

Open **http://127.0.0.1:4174/repair** and choose **Run fresh repair**. The checked launcher reports missing configuration before starting the app. If you start the server directly without a provider, its repair job completes the baseline and reports **Inconclusive**; it never substitutes the authored `repair.patch` as model output. A generated candidate that fails acceptance remains rejected. Only accepted repair results offer a review bundle; available generated patches remain inspectable on failed attempts.

The doctor is a local configuration check, not a login/model call or an execution attestation. Actual generation still verifies the provider boundary and can fail honestly. Running a recorded export or the authored control is not fresh model generation.

## Verify and replay an export

Manual comparison exports contain the frozen state, candidate/correction WASMs, receipts and review metadata. Use the repository helper, not command text from an untrusted file:

```sh
node case-triage/sputnik-public-capture/export-helper.cjs verify \
  --export /path/to/sputnik-export.json --out /tmp/sputnik-verify
node case-triage/sputnik-public-capture/export-helper.cjs replay \
  --export /path/to/sputnik-export.json --out /tmp/sputnik-replay \
  --sandbox-dir /path/to/sandbox-2.6.2-directory
```

Repair review bundles contain the canonical patch, compiled WASM, candidate identity and exact serialized baseline, candidate and persisted-recovery reports with matching hashes. The recovery report's exported canonical text and raw execution file have separate digests. See the [repair pipeline documentation](case-triage/rehearsal-repair/README.md) for reconstruction and acceptance, or [rerun the recorded generated artifact](case-triage/rehearsal-repair/README.md#persisted-failure-recovery) without another model call. Reconstructing a downloaded repair bundle still requires unpacking its reports/artifacts and applying the patch to the pinned source; the manual comparison helper above does not accept repair bundles. Fresh chain replay requires Sandbox 2.14.0. Hash checks establish byte consistency, not a cryptographic execution attestation.

## Scope and source

- Execution uses local test funds. No public-chain payment, live DAO recovery or automatic upgrade authorization is claimed.
- The repair target is source revision `5434a59dec23ee0c49df8c8c4350c208a7e75b0b` and `sputnikdao2/src/proposals.rs`. Unsupported families are not automatically repaired.
- Source input, build, artifact identity and declared behavioral checks are independent of the model response. A pass covers the exact code and tested inputs.
- `case-triage/rehearsal-repair/` contains the source repair producer/controller/build/replay path.
- `case-triage/sputnik-public-capture/` contains the inherited-state manual comparison and export helper.
- `ui/sputnik/` serves the two local workflows. `docs/legacy-refund-app.md` preserves the earlier refund example.
- The server binds to localhost by default. This repository does not provide a hosted model service or universally portable Docker image.
