NEAR REHEARSAL: RUNNABLE FIRST PROOF

Prepared for qdee, 4 November 2026.
Decision: build NEAR Rehearsal, primary track Open Innovation.

START HERE

See the repository README for the current supported workflow.
RESULTS.txt contains the observed outcomes in plain language.
report.json and raw/ contain the actual captured local execution evidence.

This is a first execution probe, not the finished product. It does not capture
mainnet state, accept arbitrary migrations or supply a production release gate.
It has not been deployed, published or submitted to the hackathon.

WHAT ACTUALLY RAN

Four fresh local NEAR chains ran unmodified official NEAR Sandbox 1.29.0,
protocol 56. In every branch, the same upstream fungible-token contract was
initialized to 10,000 owner tokens and 0 receiver tokens. Full initialized FT
storage had an identical SHA-256 in every branch. The deliberately faulty
candidate was then deployed onto that existing initialized state. The deployment
changed code and preserved the full observed contract storage.

A normal transfer out and back passed in all four branches. A rejected
ft_transfer_call refunded 100 units with the original contract. After the
seeded callback-trap upgrade it left 100 units with the receiver. Restoring the
original code BEFORE a new test transaction restored the refund behavior.

The trap is an intentionally seeded fixture. This is not a new vulnerability
discovery, a claim about current deployed contracts, or an exploit attempt.
Only local test tokens were used. No public testnet/mainnet writes occurred.

RUNTIME LIMITATION

The workspace caps open file descriptors at 16,384. The newer Sandbox binary
requested 65,535 and could not initialize. We used an unmodified official
historical binary that runs within the limit. We did not change or bypass the
platform resource limit. Current-protocol parity has NOT been demonstrated.
A rerun on a supported current runtime is required before a release claim.

The client uses two small, disclosed health-check fixes in prepare-local.cjs:
connect to 127.0.0.1 instead of a listen wildcard, and print statusCode instead
of trying to JSON-serialize a circular HTTP response. With the historical
runtime, REHEARSAL_LEGACY_RPC=1 sends the same signed serialized transactions
through broadcast_tx_commit because send_tx was not available in that version.
Neither change modifies the NEAR runtime binary or its receipt semantics.

REPRODUCE THE RECORDED HISTORICAL EXPERIMENT

Requirements: Node.js 24, npm, Linux x86_64 for the exact recorded binary.
The normal dependency installation downloads its own Sandbox binary. The exact
recorded run explicitly selects the historical binary instead.

1. Run in this directory:

   npm ci
   node prepare-local.cjs

2. Download the official archive:

   https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/1.29.0/near-sandbox.tar.gz

   Extract the member Linux-x86_64/near-sandbox into a local runtime directory.
   The executable's SHA-256 must be:
   603fdb887e23149ea6a4d1818d9188e43c3f7c9f2e800c3b68f5183bb546fa17

3. Set both SDK path variables to the DIRECTORY containing that executable:

   NEAR_SANDBOX_BIN_PATH=/absolute/path/to/runtime \
   NEAR_SANDBOX_BINARY_PATH=/absolute/path/to/runtime \
   REHEARSAL_LEGACY_RPC=1 npm run probe

The probe creates isolated local accounts and chains, runs all four scenarios,
asserts the specified balances and storage identity, saves raw outcomes, and
stops its nodes. A successful run exits zero and writes report.json. It replaces
the captured report/raw files in this directory; keep a copy if comparing runs.
Fresh transaction IDs, block hashes and gas details will differ across runs.

CURRENT-RUNTIME FOLLOW-UP

Use an official current NEAR Sandbox binary appropriate to the host, record its
exact version/hash, set both directory variables above, and leave
REHEARSAL_LEGACY_RPC unset. Run on a host meeting that binary's documented
resource requirements. Do not describe the npm dependency's default 2.6.2
binary as the latest NEAR runtime. We did not execute the current-runtime
follow-up in this workspace.

FILES

probe.cjs             Executes paired local scenarios and writes the report.
patch-wasm.cjs        Creates the deliberately seeded callback-trap fixture.
prepare-local.cjs     Reproducible client health-check compatibility fixes.
package*.json         Pinned Node dependency installation.
fixtures/            Pinned upstream test WASM and seeded local candidate.
provenance.json       Upstream source commit, file URLs and SHA-256 values.
report.json          Captured observations, identities, snapshots and limits.
raw/                 Complete native transaction outcomes for all four cases.
RESULTS.txt           Human-readable outcome summary.
third_party/         Upstream repository license texts.

PROVENANCE

Upstream fixtures come from near/near-workspaces-js at commit
d0eba4afcd17aebbb8a71db57eef898866901dbf. They are not authored by this project.
The callback patch changes only the exported ft_resolve_transfer function body
to an unconditional trap and preserves the rest of the module. It must never
be deployed to a public chain.

Repository:
https://github.com/near/near-workspaces-js
Original upstream test:
https://github.com/near/near-workspaces-js/blob/d0eba4afcd17aebbb8a71db57eef898866901dbf/__tests__/04.cross-contract-calls-with-fungible-token.ava.ts

CLAIM BOUNDARIES

Matching FT storage is not matching every global chain condition. An execution
hash binds a captured file; it does not independently authenticate consensus.
This fixture tests one callback regression and ordinary-transfer controls.
It does not test arbitrary upgrades, migration layouts, all receipt schedules,
production authorization, customer usefulness or competitive superiority.
The restored-code branch starts a NEW transaction; code rollback does not undo
the already observed failing transfer.
