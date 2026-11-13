# Repair handoff fixture

`repair-browser-export-1de7b8c5.json` is the 8 November exported Sputnik #238
repair bundle used to exercise the operator handoff. It contains the canonical
patch, candidate WASM, baseline/recovery reports and identities; it contains no
credentials.

That recorded candidate predates the failed-refund settlement policy: it returns
the bond but drops the locked liability on a failed refund and pays no retry, so
a review now rejects it at the settlement gate. It is kept as the historical
record and as a negative control for the bundle guards.

The accepted handoff bundle is assembled from the tracked artifacts of the
settlement-fixed source run by
`case-triage/rehearsal-repair/handoff-bundle.cjs`, which writes it to the path
you give it. Both bundles are data, not instructions: `repair-review` re-verifies
every hash and re-runs the chain.

SHA-256: `fdc9ba5913428431c06075ff66f9d61cd6d34eb31e6c53c6c8d65fe07e06d0b8`

`npm run test:repair-review` checks the bundle's internal hashes and rejects
mutations before any chain execution. The fixture does not prove a source build
by itself; run the full source-build path with the pinned source and Sandbox.
