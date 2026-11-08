# Repair handoff fixture

`repair-browser-export-1de7b8c5.json` is the current exported Sputnik #238
repair bundle used to exercise the operator handoff. It contains the canonical
patch, candidate WASM, baseline/recovery reports and identities; it contains no
credentials.

SHA-256: `fdc9ba5913428431c06075ff66f9d61cd6d34eb31e6c53c6c8d65fe07e06d0b8`

`npm run test:repair-review` checks the bundle's internal hashes and rejects
mutations before any chain execution. The fixture does not prove a source build
by itself; run the full source-build path with the pinned source and Sandbox.
