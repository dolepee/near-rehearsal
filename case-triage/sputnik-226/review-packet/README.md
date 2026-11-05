# Sputnik #226 — read-only reviewer packet

This packet is generated from the verified-case evidence at
`case-triage/sputnik-226/verified-case/`, committed on
`review/sputnik-226-verified-case` at `92c338a40b24d60e428e6ca94c0110c64c4b690c`.

It is a **read-only** local review surface. It has no execution button, upload
flow, deployment, funds, or network call from the page. The raw evidence is
copied into `evidence/` so every link resolves from this directory.

## Run it

```sh
cd case-triage/sputnik-226/review-packet
node serve.cjs
# http://127.0.0.1:4201/
```

The server binds only `127.0.0.1`, defaults to port `4201`, and serves static
files with no dependencies. Use `node serve.cjs --port=4201` to make the port
explicit.

## Verify the recorded evidence offline

```sh
node case-triage/sputnik-226/review-packet/verify.cjs
```

It checks:

- `SHA256SUMS` against every evidence file;
- base/candidate WASM hashes and byte counts;
- Node inputs, deployed candidate code hash, provenance, and harness commit;
- every required-success stage succeeded;
- both retry stages failed with a contract error;
- finality targets were reached before the final views;
- unchanged full DAO config, surviving proposal, `Approved` status and root vote;
- exactly one local NEAR paid, including after both retries;
- the separately labelled wrong-hash and unauthorized-caller controls;
- the native Rust result and per-stage evidence.

Test a meaningful tampered evidence case:

```sh
node case-triage/sputnik-226/review-packet/verify.cjs --self-test
```

The self-test changes the recorded total recipient delta, updates the matching
checksum, and confirms the verifier rejects it.

Offline consistency checking is **not cryptographic proof of execution**. It
checks the recorded JSON and hashes. Rerun the harness for an execution check.

## Rerun the actual case

The packet's `evidence/base.wasm` and `evidence/candidate.wasm` are the exact
source-built artifacts recorded in the run. Use the existing Rehearsal Node
dependency (`near-workspaces 5.0.0`) and a local pinned Sandbox directory:

```sh
cd case-triage/sputnik-226
BASE_WASM="$PWD/review-packet/evidence/base.wasm" \
BASE_WASM_SHA256=d1269a7be654211172cde60bccfa05a76996a3163b55abaeb58737f8661aaebf \
CANDIDATE_WASM="$PWD/review-packet/evidence/candidate.wasm" \
CANDIDATE_WASM_SHA256=088c69b79aaf6c7b2d8196348c65f66f44a773f05e1f350120a78579f594daf3 \
NODE_SANDBOX_BIN_DIR="/path/to/pinned/sandbox-directory" \
EVIDENCE_PATH="$PWD/review-packet/rerun-evidence.json" \
node node-harness.cjs
```

Do not reuse a Rust `NEAR_SANDBOX_BIN_PATH` executable-file value here. The
patched Node binding expects the directory.

## Rebuild the packet

Only after a verified-case refresh:

```sh
node case-triage/sputnik-226/review-packet/build-packet.cjs
```

The build copies the actual verified-case files and derives the summary from
`node-evidence.json`; it does not invent a result.

## Scope

- Historical Sputnik source, locally constructed old-version state.
- Authorized configured-factory update, not governance `UpgradeSelf` and not the
  self-call/callback branch.
- Two tested retry routes: duplicate `VoteApprove` and `Finalize`.
- No universal exactly-once guarantee.
- No safe-release, onchain-mainnet, current-app Sputnik-support, maintainer
  acceptance, or measured preference/time-saving claim.
- Native `near-workspaces` already proves the same invariant; the hypothesis is
  reviewer effort and packaging, not a unique execution primitive.
