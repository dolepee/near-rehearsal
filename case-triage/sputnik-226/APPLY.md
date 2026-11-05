# Sputnik #226 pilot handoff

This directory is a review handoff only. It does not modify the refund app.

- `sputnik-226-pilot.patch` applies to `near-daos/sputnik-dao-contract` at merge commit `278adc713e795f95a6da4d3007c7e03e8120f153`.
- `README.md` is the case dossier and execution notes.
- `old_proposal_upgrade.rs` is the standalone harness.
- `manifest.json` pins commits, dependencies and blockers.
- `node-harness.cjs` is the standalone Node CJS equivalent using the Rehearsal `near-workspaces 5.0.0` dependency.

Apply:

```sh
git clone https://github.com/near-daos/sputnik-dao-contract.git
cd sputnik-dao-contract
git checkout 278adc713e795f95a6da4d3007c7e03e8120f153
git apply /path/to/sputnik-226-pilot.patch
```

Then follow `pilot/README.md` after applying. The patch has no mainnet import; the harness constructs local DAO state. For the Node route, run `node-harness.cjs` from the `near-rehearsal` root with the four WASM path/hash variables set; it writes raw receipt evidence only after all assertions pass.
