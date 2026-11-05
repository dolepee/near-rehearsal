# Pilot: Sputnik #226 old-proposal upgrade

Status: **preparation only, not compiled or executed on this host**. This is a local pilot, not a product adapter and not a mainnet claim.

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

The harness deploys a **source-built base** WASM to a fresh local Sandbox account, calls `new`, creates a transfer proposal, then self-calls the real `update()` entry point with **source-built candidate** bytes. `update()` deploys the candidate and calls `migrate()` in the same promise chain. The pre-upgrade transfer proposal is then approved.

This is deliberately not an import of mainnet state:

> Locally constructed Sputnik DAO state for a pre-upgrade transfer proposal; not captured public-chain state.

No live factory, no mainnet RPC, no public keys, no deployment and no real funds.

## Exact toolchain and dependencies

Historical constraints from the #226 tree:

- `near-sdk = 5.10.0`, `near-contract-standards = 5.10.0`.
- `near-workspaces = 0.17.0`, `near-sandbox-utils = 0.13.0`, `tokio`, `walrus`, `anyhow`, `rand` from `Cargo.lock`.
- Cargo metadata pins the reproducible image `sourcescan/cargo-near:0.13.3-rust-1.84.1`, digest `sha256:baa712c5d2b7522d38175e36330d336ad2c4ce32bfaaa41af94ce40407ecd803`.
- Rust edition 2018; target `wasm32-unknown-unknown`.
- CI at the time used Node `20.17.0` for the Ava tests. Node is not required for this Rust harness.

Do **not** use the review machine’s Rust `1.96.1` or `1.97.1` as proof of the historical build. Install the 1.84.1 toolchain explicitly. A latest Rust build is only a local diagnostic artifact.

## Build base and candidate

Docker is absent on the review machine, so `reproducible-wasm` cannot be produced there yet. `cargo near build non-reproducible-wasm` is a local build and does not require Docker; it requires `cargo-near` to be installed. That artifact is **not** NEP-330 reproducible and must be labelled non-reproducible. It is acceptable for exercising the harness, not for claiming byte-identical historical output.

Install the historical toolchain and cargo-near:

```sh
rustup toolchain install 1.84.1 --profile minimal --target wasm32-unknown-unknown
cargo install cargo-near --version 0.13.3 --locked
```

Create separate worktrees so the stale committed `res/` files cannot be mistaken for source builds:

```sh
git worktree add ../sputnik-base a9a9ed1019d517b519ca214592388e7fdbf13ea5
git worktree add ../sputnik-candidate 8112278fc2874a3abc12fb056b2d4c97ff796431

(cd ../sputnik-base/sputnikdao2 && cargo +1.84.1 near build non-reproducible-wasm --locked)
(cd ../sputnik-candidate/sputnikdao2 && cargo +1.84.1 near build non-reproducible-wasm --locked)

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
export NEAR_SANDBOX_BIN_PATH="/path/to/pinned/near-sandbox-directory"
export NEAR_SANDBOX_BINARY_PATH="$NEAR_SANDBOX_BIN_PATH"
ulimit -n 65535
cargo +1.84.1 test -p sputnikdao2 --test test_pilot_old_proposal_upgrade -- --ignored --nocapture
```

The harness uses `near_workspaces::sandbox()` and no mainnet endpoint. The review machine’s pinned Sandbox 2.6.2 should be supplied through `NEAR_SANDBOX_BIN_PATH`; `near-sandbox-utils 0.13.0` wiring must be confirmed on that machine.

## Comparator

Preserve and run the competent existing test unchanged:

```sh
cargo +1.84.1 test -p sputnikdao-factory2 --test test_upgrade test_upgrade -- --nocapture
```

That test imports the live mainnet factory and remains the current-workflow comparator. This pilot does not replace or modify it.

## What to observe

- The transfer proposal exists before the upgrade.
- `update()` self-call succeeds.
- Candidate code hash equals `pilot/candidate.wasm`.
- `migrate()` completes.
- `get_config()` is unchanged.
- `act_proposal(id, VoteApprove)` on the old transfer proposal succeeds after the upgrade.

If they pass, old proposal state and the real upgrade/migrate entry point survived for this locally constructed state. If they fail, record the exact transaction and error; do not infer a mainnet failure.

## Blockers

- No source-built base/candidate artifacts yet.
- Docker absent: no reproducible candidate artifact; non-reproducible build is local-only.
- `near-workspaces 0.17.0` / `near-sandbox-utils 0.13.0` sandbox wiring and actual sandbox build identity need review-machine confirmation.
- Maintainer acceptance pending; no outreach from triage.
