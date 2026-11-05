# Rehearsal Repair checkpoint

Status: **partial, blocked before issue #238 reproduction.**

## Pinned source

- Repository: `https://github.com/near-daos/sputnik-dao-contract`
- Commit: `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`
- Toolchain: Rust `1.86.0`, target `wasm32-unknown-unknown`
- Build command, from the source checkout:

```sh
cargo build --target wasm32-unknown-unknown --release --locked -p sputnikdao2
```

- Built artifact: `target/wasm32-unknown-unknown/release/sputnikdao2.wasm`
- Artifact SHA-256: `5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578`

## Current blocker

The source compiles. The compiled artifact does not initialize under the local
near-sandbox runtimes tested here. The observed failure at `new` is:

```text
FunctionCallError: CompilationError: PrepareError: Deserialization
```

This was reproduced with near-sandbox `2.6.2`, `2.10.0` and `2.11.0`. The
prebuilt historical fixture deploys and runs, so this is a compatibility issue
with this source build, not a generic RPC failure.

Do not treat issue #238 as reproduced until the compiled source initializes and
the failed-async and healthy control branches have both executed from the same
frozen state.

## Next bounded step

Resolve the runtime compatibility issue without changing proposal/refund
semantics, then run `issue238-local.cjs` against the pinned compiled artifact and
record the healthy and failed branches separately.
