# Sputnik #226 — recorded case review

This packet is generated from the verified-case evidence at
`case-triage/sputnik-226/verified-case/`, committed on
`review/sputnik-226-verified-case` at `92c338a40b24d60e428e6ca94c0110c64c4b690c`.

It is a **recorded case review**. It presents the verified raw evidence and a
real rerun command. The raw evidence is copied into `evidence/` so every link
resolves from this directory.

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
- every required-success stage and every child receipt succeeded;
- transaction signer/receiver and receipt executors stay inside the recorded contract/actor context;
- both retry receipt graphs failed with the expected contract error and no beneficiary receipt;
- positive, ordered finality targets were reached before the final views;
- proposal ID, proposer, receiver, amount and the claimed balance account agree across all states;
- unchanged full DAO config, surviving proposal, `Approved` status and root vote;
- exactly one local NEAR paid, including after both retries;
- the separately labelled wrong-hash and unauthorized-caller controls;
- the native Rust result and per-stage evidence;
- every displayed packet fact matches a canonical derivation of the raw evidence, excluding only `generatedAt`.

Run the regression probes:

```sh
node case-triage/sputnik-226/review-packet/verify.cjs --self-test
```

The self-test rejects: a failed approve child receipt under a successful top-level
status; a recipient account unbound from the proposal receiver; zeroed finality
targets; a packet display claiming 999 NEAR while raw evidence proves 1; and an
altered total recipient delta. Evidence checksums are updated where applicable,
so these are semantic and display-binding checks, not just hash checks.

Offline consistency checking is **not cryptographic proof of execution**. It
checks the recorded JSON and hashes. Rerun the harness for an execution check.

## Rerun the actual case

Use the fixed-case runner. It verifies the recorded packet and supplied
artifacts, checks that the selected local runtime reports `2.6.2`, records the
runtime hash, then runs the existing harness into a new output directory:

```sh
node case-triage/sputnik-226/run-case.cjs \
  --sandbox-dir "/path/to/pinned/sandbox-directory" \
  --out "/path/to/new-output-directory"
```

`--sandbox-dir` is the directory expected by the patched Node binding, not the
Rust executable-file value. Omit `--out` to use a fresh timestamped directory
under `case-triage/sputnik-226/runs/`.

The runner refuses an existing output directory, a missing/invalid runtime, a
runtime that does not report `2.6.2`, reference-packet or artifact mismatch, and
failed/incomplete execution. It prints the fresh `node-evidence.json` path and
the tested scope. The recorded packet and native reference result are not
re-executed or presented as the fresh run.

## Rebuild the packet

Only after a verified-case refresh:

```sh
node case-triage/sputnik-226/review-packet/build-packet.cjs
```

The build validates the full source evidence before it replaces any copied
evidence, then derives the packet from `node-evidence.json`. It does not invent a
result. The local server runs the same verifier at startup and refuses to serve an
invalid packet.

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
