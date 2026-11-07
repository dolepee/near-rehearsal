# Local repair setup

This page configures the supported source repair. The manual upgrade comparison uses a separate Sandbox version and does not need a model login. Stay on `main`; the old `feat/sputnik-release-review` branch predates the repair interface.

## Sandbox runtimes

Use the **directory containing `near-sandbox`**, not the executable path.

| Flow | Release | Commit | Protocol |
| --- | --- | --- | --- |
| Manual `/` | 2.6.2 | `2f9ddb711ebd94a306eaec06030d87ef8dfc51fa` | 77 |
| Repair `/repair` | 2.14.0 | `bc4e9e8cfb03d9e82f027883055624e18576993e` | 88 |

Official archives follow this URL pattern:

```text
https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/<platform>/<version>/near-sandbox.tar.gz
```

`Linux-x86_64` and `Darwin-arm64` are distinct archives, not interchangeable. The manual Linux download/checksum is in the root README. A native macOS arm64 Repair download was independently executed and uses this verified archive checksum:

```sh
REPAIR_RUNTIME="$PWD/.local/sandbox-2.14.0"
mkdir -p "$REPAIR_RUNTIME"
curl --fail --location --max-time 300 \
  https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Darwin-arm64/2.14.0/near-sandbox.tar.gz \
  --output "$REPAIR_RUNTIME/archive.tar.gz"
echo "ea53448ef97540c012e5c3d967c74d78292b0465a98cf7027811a936718fe232  $REPAIR_RUNTIME/archive.tar.gz" | shasum -a 256 -c -
tar -xzf "$REPAIR_RUNTIME/archive.tar.gz" -C "$REPAIR_RUNTIME"
export REPAIR_SANDBOX_DIR="$REPAIR_RUNTIME/Darwin-arm64"
"$REPAIR_SANDBOX_DIR/near-sandbox" --version
npm run doctor -- --flow repair
```

For native Linux x86_64, the recovery CI job downloads and executes this exact 2.14.0 archive. Use its verified digest before extraction:

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
npm run doctor -- --flow repair
```

For manual execution on native macOS arm64, acquire the official `Darwin-arm64/2.6.2` archive and set `NEAR_SANDBOX_BIN_PATH` to its extracted directory. For Linux repair, use `Linux-x86_64/2.14.0`. These supplied-runtime paths must pass the release/commit/protocol check; do not relabel an older binary. No claim is made that arbitrary Linux arm64 hosts or Docker emulation work. Runtime downloads can take minutes and depend on network access.

When serving both routes in one process, leave `NEAR_SANDBOX_BIN_PATH` and `NEAR_SANDBOX_BINARY_PATH` pointing at 2.6.2, and set `REPAIR_SANDBOX_DIR` separately to 2.14.0. Repair children select their own runtime. The launcher does not replace the manual runtime globally.

## Source and compiler

```sh
mkdir -p .local
git clone https://github.com/near-daos/sputnik-dao-contract.git .local/sputnik-source
git -C .local/sputnik-source switch --detach 5434a59dec23ee0c49df8c8c4350c208a7e75b0b
export REPAIR_SOURCE_DIR="$PWD/.local/sputnik-source"
rustup toolchain install 1.86.0 --profile minimal
rustup target add wasm32-unknown-unknown --toolchain 1.86.0
```

Use the official Rust/rustup installation if `rustup` is not present. The controller discovers the actual Rust 1.86.0 toolchain under `RUSTUP_HOME` or the standard rustup home, and checks cargo/rustc versions. The browser never accepts arbitrary build commands or host source paths.

## Existing model account and policy

Install the official Codex CLI and sign in locally using its supported login flow. Never paste your auth file into this repository, the browser, chat or a report. A login alone does not establish that a requested model is included in your account.

Configure these values in your terminal:

| Variable | Purpose |
| --- | --- |
| `CODEX_BIN` | Absolute official CLI executable path; `command -v codex` locates it. |
| `CODEX_MODEL` | Optional model available to your existing account; omit to use the CLI default. |
| `CODEX_AUTH_SOURCE` | Path to the existing local auth file, normally `$HOME/.codex/auth.json`; never its contents. |
| `CODEX_PRIVATE_RUNTIME` | Dedicated absent or empty temporary directory used only by this producer. |
| `CODEX_PERMISSION_PROFILE` | Name of the enforced outer policy used by the producer wrapper. |
| `MODEL_PRODUCER_SANDBOX_CMD` | JSON argv prefix for that verified policy, including `{workspace}` and a matching `--permission-profile`. |

The controller's [tool-free producer instructions](../case-triage/rehearsal-repair/README.md#tool-free-local-producer-driver) define the required policy and placeholders. `node case-triage/rehearsal-repair/codex-producer.cjs --help` lists the driver arguments. There is no universal policy prefix that can be copied unchanged across CLI releases and operating systems. Supply the supported policy on your host; do not weaken the boundary to make a run pass.

```sh
export CODEX_BIN="$(command -v codex)"
export CODEX_AUTH_SOURCE="$HOME/.codex/auth.json"
export CODEX_PRIVATE_RUNTIME="$PWD/.local/provider-runtime"
# Set CODEX_PERMISSION_PROFILE and MODEL_PRODUCER_SANDBOX_CMD for your host.
npm run doctor -- --flow repair --generate
PORT=4174 npm run ui:repair
```

The doctor performs no login, provider call or chain execution and does not read auth contents. The real producer checks confinement before generation, removes its temporary auth reference afterward, and can still report an account/model or output failure. No credential fallback, paid API purchase, or authored-patch substitution is performed.

## Test categories

- `npm test`: offline core behavior, verifier/report controls, browser history and setup diagnostics; no network/model/Sandbox execution.
- CI `Pinned Sandbox three-branch flow`: actual manual baseline/candidate/correction transactions on 2.6.2 and separate verification.
- CI `Repair suites`: producer/controller/build/acceptance guards and browser-job tests; some use fake CLI/process controls. These are not genuine provider runs.
- `npm run ui:repair`: after successful preflight, the browser can start a fresh real baseline/model/build/replay attempt. An available provider account and Rust/Sandbox setup are required.

Expected output matters: `Accepted` is a completed supported repair experiment; `Rejected` is a measured failure; `Inconclusive`/`Interrupted` is not accepted evidence. An exported report can be verified offline for consistency; reproducing execution requires the matching runtime.
