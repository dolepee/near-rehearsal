# Rehearsal Repair checkpoint

Status: **source-built issue #238 reproduction complete on local Sandbox 2.14.0; repair loop not yet implemented.**

## Pinned source

- Repository: `https://github.com/near-daos/sputnik-dao-contract`
- Commit: `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`
- Toolchain: Rust `1.86.0`, target `wasm32-unknown-unknown`
- Reproducible build entry, from the source checkout:

```sh
(cd sputnikdao2 && cargo near build reproducible-wasm)
```

The repository's `build.sh` uses the same `cargo near build reproducible-wasm`
entry for each contract. The direct compile fallback is:

```sh
cargo build --target wasm32-unknown-unknown --release --locked -p sputnikdao2
```

- Built artifact: `target/wasm32-unknown-unknown/release/sputnikdao2.wasm`
- Artifact SHA-256: `5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578`

## Reproduction result

The pinned source build was run on near-sandbox `2.14.0`. Both branches executed
from separately initialized local state:

- Healthy control: proposal `Approved`; contract `-0.1 NEAR`; recipient `+0.1 NEAR`; proposer `-0.0008363133581916 NEAR`.
- Failed async FunctionCall: proposal `Failed`; contract `+1 NEAR`; recipient `0`; proposer `-1.0008566935666626 NEAR`.

The failed branch shows the inherited proposal bond staying in the contract
while the proposer bears the bond plus gas. Raw receipts and deltas are in
`out/issue238-local.json`.

The earlier `FunctionCallError: CompilationError: PrepareError: Deserialization`
failures were specific to the older sandbox runtimes tested (`2.6.2`, `2.10.0`,
`2.11.0`); the same artifact initializes on `2.14.0`. The runner now finalizes
`new` and waits for the first view before creating a proposal.

## Next bounded step

Implement the source-only repair path and compile it without granting it test or
predicate access. The current checkpoint establishes the reproduction and the
healthy control; it is not a model-generated patch and not a repair claim.
