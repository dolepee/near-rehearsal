# F18 confined CI build

- Workflow run: 43624915270
- Head: f44933a99332cf78ec72af24c9683c2b0f493918
- Artifact: repair-review-source-build
- WASM SHA-256: 133c60cfb711d285c613c386d6b745ef6525438f5290b1d9feeffbd44f58d09d
- WASM size: 540609 bytes
- Patch SHA-256: 9ae060af97dcb7f4ced31d135ac84b0130f274032f17c2acb1a56e43a6ebf3d0
- Applied source SHA-256: 1e1c693fc2cae3c2ce3159a1e0d79699a6e8085148b5c521cb166acddd74464c
- Rust: 1.86.0; target: wasm32-unknown-unknown
- Command: cargo build --target wasm32-unknown-unknown --release --locked -p sputnikdao2
- Boundary: bwrap, build exit 0; outside read/write denied, environment canary absent, network denied.

This replaces the exploratory local build. Reports, bundles and acceptance evidence must be regenerated against these exact bytes.
