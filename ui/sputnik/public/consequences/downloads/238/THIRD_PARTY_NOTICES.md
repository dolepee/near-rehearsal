# Third-Party Notices

This repository's original code is licensed under **GPL-3.0-only**. The complete text is in [LICENSE](LICENSE), SHA-256 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`.

The components below retain their own upstream terms. Their texts are reproduced under [LICENSES/](LICENSES/) so the upstream terms remain separate from the root GPL. Existing upstream notice copies in the case-triage material are retained unchanged.

## Sputnik DAO

**Upstream:** [near-daos/sputnik-dao-contract](https://github.com/near-daos/sputnik-dao-contract)

**Revisions referenced by the repository:**

- `5434a59dec23ee0c49df8c8c4350c208a7e75b0b` — supported repair base.
- `a9a9ed1019d517b519ca214592388e7fdbf13ea5` — historical base for the old-proposal case.
- `8112278fc2874a3abc12fb056b2d4c97ff796431` — historical candidate for the old-proposal case.

**Build records:** `case-triage/rehearsal-repair/build-manifest.json` and `case-triage/sputnik-226/manifest.json`. The recorded commands include `cargo build --target wasm32-unknown-unknown --release --locked -p sputnikdao2` with Rust 1.86.0, and `cargo +1.84.1 near build non-reproducible-wasm --locked --no-abi` followed by the required `wasm-opt` post-step for the historical PR #226 artifacts.

**Included artifacts:** tracked Sputnik WASM paths in this repository, including upstream source-built base/candidate artifacts and project-modified partial, repaired, seeded and generated candidates. Modified artifacts are not upstream releases.

**Upstream notice:** MIT License, Copyright (c) 2021 near-daos. Retained at [LICENSES/sputnik-dao-contract-MIT.txt](LICENSES/sputnik-dao-contract-MIT.txt), SHA-256 `7b8e9dff98141c37de809e0d5f5d8b663cf747e0d16637fbe671cccb3cf89a6f`. Existing copies at `case-triage/sputnik-226/verified-case/SPUTNIK-LICENSE` and `case-triage/sputnik-226/review-packet/evidence/SPUTNIK-LICENSE` are preserved.

## NEAR counter example

**Upstream:** [tansawit/near-counter-app](https://github.com/tansawit/near-counter-app) at `d777350aefa1e76734cbd0ed7633bd072acd511f`.

**Source:** `assembly/main.ts`; build script `node asconfig.js`; upstream `near-sdk-as` 0.4.2.

**Embedded counter WASM:** `out/public-capture.json` stores the upstream counter binary at `codeBase64` — 31,579 bytes, SHA-256 `5d4892a56646ca96f76a2632e7d21117ac541a4fc58f661ab2acff5bab7adcac`. The existing record identifies that digest as the upstream `near-sdk-as` 0.4.2 source build and records `sourceBuildMatchesDeployed: true`. It is embedded in JSON, not present as a separate tracked `.wasm` path.

**Project fixtures:** `contracts/counter-v2-buggy.wat` and `contracts/counter-v2-fixed.wat` are project-authored fixtures, not copies of the upstream source.

**Upstream notices:**

- [LICENSES/near-counter-LICENSE](LICENSES/near-counter-LICENSE) — MIT-style text, Copyright 2020 NEAR Inc; SHA-256 `4ea76409578618a41a1f6dd02bb495d5202805a17b9ad3b1f1af973cae3ae0d9`.
- [LICENSES/near-counter-LICENSE-APACHE](LICENSES/near-counter-LICENSE-APACHE) — Apache License 2.0; SHA-256 `62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a`.

The upstream `package.json` has `"license": null`; that metadata does not replace the two upstream notice files above.

## NEAR Workspaces test fixtures

**Upstream:** [near/near-workspaces-js](https://github.com/near/near-workspaces-js) at `d0eba4afcd17aebbb8a71db57eef898866901dbf`.

**Original binary locations:** `__tests__/build/debug/fungible_token.wasm` (201,136 bytes; SHA-256 `afdb62b051a7b7222e0fc1b7e119d6921a9addd159fe531ce0801218db74d735`) and `__tests__/build/debug/defi.wasm` (118,869 bytes; SHA-256 `503639ba0f69c6bfd4870b9bd79fec959aeaeacdfcee650bb3c4467e736153b0`). The original test source is `__tests__/04.cross-contract-calls-with-fungible-token.ava.ts`.

These upstream fixture bytes are not tracked in this checkout. `substrate/provenance.json` records their URLs and hashes; `substrate/fixtures/` is absent. The upstream commit contains prebuilt WASMs; no source or build recipe for them is established in this inventory.

**Upstream notices:**

- [LICENSES/near-workspaces-js-LICENSE](LICENSES/near-workspaces-js-LICENSE) — GPLv3; SHA-256 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`.
- [LICENSES/near-workspaces-js-LICENSE-APACHE](LICENSES/near-workspaces-js-LICENSE-APACHE) — Apache License 2.0; SHA-256 `62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a`.

## `near-workspaces` 5.0.0

**Package:** `near-workspaces@5.0.0` from <https://registry.npmjs.org/near-workspaces/5.0.0>.

**Official npm `gitHead`:** `20b58f0acd60d76517479f3b295f4c7ab938061f`.

**Source:** <https://github.com/near/workspaces-js/tree/20b58f0acd60d76517479f3b295f4c7ab938061f/packages/js>; package directory `packages/js`; declared build script `tsc`.

**Metadata versus shipped text:** the npm `package.json` says `"license": "(MIT AND Apache-2.0)"` and the npm README badges say MIT and Apache-2.0, but the actual npm tarball contains a GPLv3 `LICENSE` (SHA-256 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`). The source repository root at the same `gitHead` contains GPLv3 `LICENSE` and Apache-2.0 `LICENSE-APACHE`; the source package reports version `3.0.0` while the npm tarball reports `5.0.0`. This metadata/text discrepancy is recorded, not treated as resolved.

The package also contains a prebuilt `core_contracts/testnet-linkdrop.wasm` (SHA-256 `006468efb06dbc91e04dbc90a31fac4b8684062e9e4f9c228de53154f6f49c72`); source/build correspondence for that WASM is not established in this inventory.

**Upstream notices:** [LICENSES/near-workspaces-5.0.0-LICENSE](LICENSES/near-workspaces-5.0.0-LICENSE) (GPLv3; SHA-256 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`) and [LICENSES/near-workspaces-5.0.0-LICENSE-APACHE](LICENSES/near-workspaces-5.0.0-LICENSE-APACHE) (Apache License 2.0; SHA-256 `62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a`).

## Project-authored fixtures

The following are project-authored and do not inherit a third-party notice from the upstream examples they model:

- `contracts/counter-v2-buggy.wat` / `.wasm`
- `contracts/counter-v2-fixed.wat` / `.wasm`
- `contracts/refund-v1.wat` / `.wasm`
- `contracts/refund-v2-bad.wat` / `.wasm`
- `contracts/refund-v2-fixed.wat` / `.wasm`
- `contracts/refund-v2-half-payout.wat` / `.wasm`
- `contracts/state-v1.wat` / `.wasm`
- `contracts/state-v2-buggy.wat` / `.wasm`
- `contracts/state-v2-fixed.wat` / `.wasm`

They are compiled by `scripts/compile-contracts.cjs` with `wabt` 1.0.36; their `.wasm` outputs are tracked alongside the `.wat` sources.

The generated candidate patches and candidate source under `case-triage/rehearsal-repair/model-candidate/` and `case-triage/rehearsal-repair/generated/e8262f5a/` are project-generated modifications of the Sputnik source; they are not upstream releases.

## Embedded reviewer artifacts

A scan of JSON base64 values found 17 embedded WASM occurrences across eight distinct SHA-256 digests. Five are duplicates of tracked `.wasm` paths. The three distinct embedded artifacts are the counter capture above, the recorded Sputnik #238 candidate below, and the historical `aya` capture below.

### Recorded Sputnik #238 candidate

`test-fixtures/repair-browser-export-1de7b8c5.json` stores the recorded model-generated candidate at `candidate.wasm.base64` — 527,543 bytes, SHA-256 `7de8d74ccaa45e9e5b4084cbee87bcdb2ee3cfc8df762de941a07bafc39b0207`.

- Source: `near-daos/sputnik-dao-contract` at `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`, `sputnikdao2/src/proposals.rs`.
- Applied source SHA-256: `765af4b0dfe3d8d719ea1418e9c5d5763af1799bd437f95690d856f8e05de88c`.
- Canonical patch: `repair.patch`, 7,320 bytes, SHA-256 `3ac7ef93d6f24a26451e6758bcc558274168efd66ec1b1570dd3c512080535b3`.
- Build: Rust 1.86.0, `wasm32-unknown-unknown`; the recorded acceptance result is `ok: true`.

This is a project-generated modified artifact, not an upstream release.

### Historical `aya.sputnikv2.testnet` capture

`case-triage/sputnik-public-capture/out/capture.json` stores a captured binary at `code.base64` — 469,723 bytes, SHA-256 `6e3f1814d40769d8f57b9a7af689d22aaab96d3232cec4d861311829c1d2318f`.

- Source account: `aya.sputnikv2.testnet`, NEAR testnet.
- Captured block: `276345877`; block hash `HVF4oi1E1NBPdjdDY8bYHQJXdre6ZpVzvqZucFfhXfwj`; code hash `8RMeZ5cXDap6TENxaJKtigRYf3n139iHmTRe8ZUNey6N`.
- Source/build correspondence is unestablished in this inventory. Public availability is not a license and is not a source-build proof.

## Dependencies and runtime

`near-workspaces`, `wabt`, Node.js packages and other entries in `package-lock.json` are downloaded dependencies. `node_modules/` is not tracked. The NEAR Sandbox runtime is downloaded separately for local execution and is not bundled in this repository. Those dependencies remain subject to their own terms and notices.
