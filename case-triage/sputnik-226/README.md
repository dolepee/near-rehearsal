# Pilot: Sputnik #226 old-proposal upgrade

Status: **source-built WASM prepared and native harness compiled; execution is being re-run after the configured-factory fixture correction**. This is a local pilot, not a product adapter, not governance `UpgradeSelf`, and not a mainnet claim.

## Why #226

`near-daos/sputnik-dao-contract#219` is unsuitable. It was closed, unmerged WIP; it has no candidate WASM and no CI checks. Its `VersionedProposal::update_votes` clones `latest_version_ref()` and mutates the clone, never writing votes back, so voting an existing proposal after the upgrade would be a no-op. It has no old-proposal migration test.

Merged successor `#226` adds state-version handling and a real `migrate()`. This pilot tests the same family without importing the live 3 MB `sputnik-dao.near` factory.

## Exact source pins

| Item | Value |
|---|---|
| Repo | `https://github.com/near-daos/sputnik-dao-contract` |
| PR | `#226` — Feature/214 indexer less indexing |
| Base | `a9a9ed1019d517b519ca214592388e7fdbf13ea5` |
| Candidate | `8112278fc2874a3abc12fb056b2d4c97ff796431` |
| Merge | `278adc713e795f95a6da4d3007c7e03e8120f153` |
| Merge tree | Candidate tree for this pilot |

## What is locally constructed

The harness deploys a **source-built base** WASM to a fresh local Sandbox account. Root calls `new()`, so the persisted `FactoryInfo.factory_id` is root. Root then calls the real `update()` entry point with **source-built candidate** bytes. This is the authorized configured-factory branch: `update()` deploys the candidate and calls `migrate()` in the same promise chain. It is **not** governance `UpgradeSelf` and **not** the self-call/callback branch; a direct DAO-to-DAO call would enter the callback path and consume `promise_result(0)` incorrectly.

This is deliberately not an import of mainnet state:

> Locally constructed Sputnik DAO state for a pre-upgrade transfer proposal; not captured public-chain state.

No live external factory, no mainnet RPC, no public keys, no deployment and no real funds. The factory identity is a local test configuration (`root`), not a production factory.

The pre-upgrade transfer proposal is created before the upgrade; after upgrade it is approved, the root vote must persist, and a separate recipient must receive the exact transfer amount.

## Exact toolchain and dependencies

Historical constraints from the #226 tree:

- `sputnikdao2/Cargo.toml` declares `near-sdk = "5.10.0"` and `near-contract-standards = "5.10.0"`; these are caret ranges, not exact resolved versions.
- The historical `Cargo.lock` resolves `near-sdk 5.11.0`, `near-sdk-macros 5.11.0` and `near-contract-standards 5.11.0`. Do not edit the lockfile or force 5.10.
- `near-workspaces = 0.17.0`, `near-sandbox-utils = 0.13.0`, `tokio`, `walrus`, `anyhow`, `rand` from `Cargo.lock`.
- Cargo metadata pins the reproducible image `sourcescan/cargo-near:0.13.3-rust-1.84.1`, digest `sha256:baa712c5d2b7522d38175e36330d336ad2c4ce32bfaaa41af94ce40407ecd803`.
- Rust edition 2018; target `wasm32-unknown-unknown`.
- CI at the time used Node `20.17.0` for the Ava tests. Node is not required for this Rust harness.

Do **not** use the review machine’s Rust `1.96.1` or `1.97.1` as proof of the historical build. Install the 1.84.1 toolchain explicitly. A latest Rust build is only a local diagnostic artifact.

## Build base and candidate

Docker is absent on the review machine, so `reproducible-wasm` cannot be produced there yet. Actual owner-host execution used official `cargo-near 0.13.3` with `--locked --no-abi`; the output ran on Sandbox 2.6.2 after a required `wasm-opt` post-step. Plain Cargo/MVP builds failed with `Deserialization`. Historical source and `Cargo.lock` were unchanged; this is **not** a reproducibility claim.

`cargo near build non-reproducible-wasm` is a local build and does not require Docker; it requires `cargo-near` to be installed. That artifact is **not** NEP-330 reproducible and must be labelled non-reproducible. It is acceptable for exercising the harness, not for claiming byte-identical historical output.

Install the historical toolchain and cargo-near:

```sh
rustup toolchain install 1.84.1 --profile minimal --target wasm32-unknown-unknown
cargo install cargo-near --version 0.13.3 --locked
```

Create separate worktrees so the stale committed `res/` files cannot be mistaken for source builds:

```sh
git worktree add ../sputnik-base a9a9ed1019d517b519ca214592388e7fdbf13ea5
git worktree add ../sputnik-candidate 8112278fc2874a3abc12fb056b2d4c97ff796431

(cd ../sputnik-base/sputnikdao2 && cargo +1.84.1 near build non-reproducible-wasm --locked --no-abi)
(cd ../sputnik-candidate/sputnikdao2 && cargo +1.84.1 near build non-reproducible-wasm --locked --no-abi)
# Then run the owner-host-required wasm-opt post-step and record its exact flags.

cp ../sputnik-base/target/near/sputnikdao2/sputnikdao2.wasm pilot/base.wasm
cp ../sputnik-candidate/target/near/sputnikdao2/sputnikdao2.wasm pilot/candidate.wasm
sha256sum pilot/base.wasm pilot/candidate.wasm
```

Record both hashes in `pilot/manifest.json`. If the review machine gets Docker, use the exact reproducible command instead:

```sh
(cd ../sputnik-base/sputnikdao2 && cargo +1.84.1 near build reproducible-wasm --locked)
(cd ../sputnik-candidate/sputnikdao2 && cargo +1.84.1 near build reproducible-wasm --locked)
```

The committed `sputnikdao2/res/sputnikdao2.wasm` is **not** a candidate build: 417,124 bytes, SHA-256 `ddccaf0c1eb59aab1a509855b6e2837bd7fad067d77cb90ac895e5c5688fb461`, unchanged from base to merge. Do not use it.

## Run the standalone harness

Copy the harness into the crate test directory on the pilot branch:

```sh
cp pilot/old_proposal_upgrade.rs sputnikdao2/tests/test_pilot_old_proposal_upgrade.rs
export BASE_WASM="$PWD/pilot/base.wasm"
export CANDIDATE_WASM="$PWD/pilot/candidate.wasm"
export EVIDENCE_PATH="$PWD/pilot/evidence.log"
export NEAR_SANDBOX_BIN_PATH="/path/to/pinned/near-sandbox-directory"
export NEAR_SANDBOX_BINARY_PATH="$NEAR_SANDBOX_BIN_PATH"
ulimit -n 65535
cargo +1.84.1 test -p sputnikdao2 --test test_pilot_old_proposal_upgrade -- --ignored --nocapture
```

The harness uses `near_workspaces::sandbox()` and no mainnet endpoint.

**Sandbox path distinction:** Rust `near-sandbox-utils 0.13` expects `NEAR_SANDBOX_BIN_PATH` to be the sandbox executable **file**. The patched Node binding expects the **directory** containing it. Do not export one value and reuse it across both.

```sh
# Rust
export NEAR_SANDBOX_BIN_PATH="/path/to/pinned/near-sandbox"
# Node (separate value)
export NODE_SANDBOX_BIN_DIR="/path/to/pinned/sandbox-directory"
```

## near-workspaces 5.0.0 API checks

- `parseNEAR('1')` returns a decimal **string** in 5.0.0. Convert it to `BigInt` for `initialBalance`, `attachedDeposit` and accounting; keep the wire `amount` as a string.
- `provider.viewCodeRaw()` returns the base64 **string** `code_base64`; use `provider.viewCode()` or `Buffer.from(raw, 'base64')` before comparing bytes.
- `add_proposal` and `act_proposal` must be signed by the policy account (`[root.accountId]`), not by the DAO. The configured-factory `update` is signed by root; do not use the DAO self-call callback path.

## Standalone Node CJS equivalent

For an executable check using the Rehearsal dependencies already installed on the review machine, use the private-pilot copy at `case-triage/sputnik-226/node-harness.cjs` in `dolepee/near-rehearsal` branch `pilot/sputnik-226-old-proposal`. It uses `near-workspaces 5.0.0` and the pinned local Sandbox 2.6.2. It is a thin pilot runner, not a product adapter.

It requires source-built WASM paths and hashes:

```sh
export BASE_WASM="$PWD/pilot/base.wasm"
export BASE_WASM_SHA256="$(sha256sum "$BASE_WASM" | awk '{print $1}')"
export CANDIDATE_WASM="$PWD/pilot/candidate.wasm"
export CANDIDATE_WASM_SHA256="$(sha256sum "$CANDIDATE_WASM" | awk '{print $1}')"
export NODE_SANDBOX_BIN_DIR="/path/to/pinned/sandbox-directory"  # directory, not the Rust file value
export EVIDENCE_PATH="$PWD/pilot/evidence.json"
node case-triage/sputnik-226/node-harness.cjs
```

It waits, with a bounded 30-second barrier, for the finalized block to reach the highest transaction/receipt block before each final view. It persists partial or failed evidence with the failing stage and every completed raw transaction/receipt result; it only marks the run passed after the config, code, proposal, vote and recipient-balance assertions pass.

## Comparator

Preserve and run the competent existing test unchanged:

```sh
cargo +1.84.1 test -p sputnikdao-factory2 --test test_upgrade test_upgrade -- --nocapture
```

That test imports the live mainnet factory and remains the current-workflow comparator. This pilot does not replace or modify it.

## What to observe

- The transfer proposal exists before the upgrade; old-schema `get_proposal` is read as raw JSON and must not contain `last_actions_log`.
- Root's configured-factory `update(raw candidate)` succeeds. This is not the governance `UpgradeSelf` or DAO self-call callback branch.
- Candidate code hash equals `pilot/candidate.wasm`.
- `migrate()` completes.
- Full `get_config` JSON is identical before and after.
- `act_proposal(id, VoteApprove)` on the old proposal succeeds.
- Final proposal status is `Approved` and the root vote is present.
- The finalized-block barrier was satisfied after each state-changing transaction.
- The separate recipient’s balance increases by exactly the proposal amount.

If they pass, old proposal state and the real upgrade/migrate entry point survived for this locally constructed state. If they fail, record the exact transaction and error; do not infer a mainnet failure.

## Blockers

- No source-built base/candidate artifacts yet.
- Docker absent: no reproducible candidate artifact; non-reproducible build is local-only.
- `near-workspaces 0.17.0` / `near-sandbox-utils 0.13.0` sandbox wiring and actual sandbox build identity need review-machine confirmation.
- Maintainer acceptance pending; no outreach from triage.
