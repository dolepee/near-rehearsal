# NEAR Rehearsal

**Upgrade rehearsal for DAOs and agent treasuries.** Capture the state that matters, apply a declared migration, run the same obligation, and export a review that another machine can verify.

Most upgrade tests start from a clean fixture. That misses the dangerous case: an upgrade that compiles and passes fresh-state tests, but changes the meaning of an obligation already stored on chain. NEAR Rehearsal runs the real Sputnik DAO v2 contract family against a frozen inherited state and shows the consequence before the provenance.

## What this proves

- A **baseline** operation still pays the declared recipient after the upgrade.
- A **candidate** upgrade can be run against the same frozen state without touching the original proof.
- A **correction** can be rerun from the same frozen bundle with different WASM bytes.
- A complete review exports the captured state, actual candidate/correction WASMs, raw receipts, verdict and portable verify/replay instructions.
- A failed, timed-out or interrupted job is **inconclusive**, not a stale success.

The supported case is one Sputnik DAO v2 proposal with a `Transfer` obligation: the proposal declares one recipient and one amount, and the rehearsal checks the actual receipt graph and recipient balance against that obligation.

## The demo

1. Open the local page and run the default case.
2. The baseline is `preserved`.
3. The seeded bad candidate is `regressed`: the operation fails and the recipient is not paid.
4. Select a correction and rerun from the same frozen bundle.
5. The correction is `preserved`.
6. Export the completed correction run, then verify the downloaded JSON with the repo helper.

That is the whole product: **consequence first, proof second, portable review last.** No “trust the green badge” step.

## Run it locally

Requirements: Node.js 24.22.1 and a local NEAR Sandbox 2.6.2 runtime. The documented path is Linux x86_64; the owner’s macOS arm64 path uses the directory containing `near-sandbox` as `NEAR_SANDBOX_BIN_PATH`.

```sh
git clone https://github.com/dolepee/near-rehearsal.git
cd near-rehearsal
git switch feat/sputnik-release-review
npm ci --ignore-scripts
node scripts/patch-near-sandbox.cjs
```

Acquire the official NEAR sandbox:

```sh
SANDBOX_DIR="$PWD/.sandbox"
mkdir -p "$SANDBOX_DIR"
curl -fsSL \
  https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.6.2/near-sandbox.tar.gz \
  -o "$SANDBOX_DIR/near-sandbox.tar.gz"
echo "58c6d71091bc7a329b9d90784be42d1f313e0bf9fc4e1f2b967d60cdc407cdcf  $SANDBOX_DIR/near-sandbox.tar.gz" \
  | sha256sum -c -
tar --no-same-owner -xzf "$SANDBOX_DIR/near-sandbox.tar.gz" -C "$SANDBOX_DIR"
chmod +x "$SANDBOX_DIR/Linux-x86_64/near-sandbox"
export NEAR_SANDBOX_BIN_PATH="$SANDBOX_DIR/Linux-x86_64"
export NEAR_SANDBOX_BINARY_PATH="$NEAR_SANDBOX_BIN_PATH"
ulimit -n 65535
PORT=4174 npm run ui:sputnik
```

Open `http://127.0.0.1:4174`. The server binds to localhost only.

## Portable export verification

The export is self-contained. Use the repo helper; do not execute shell text embedded in a downloaded review:

```sh
node case-triage/sputnik-public-capture/export-helper.cjs verify \
  --export /path/to/sputnik-export.json --out /tmp/sputnik-verify

node case-triage/sputnik-public-capture/export-helper.cjs replay \
  --export /path/to/sputnik-export.json --out /tmp/sputnik-replay \
  --sandbox-dir /path/to/directory-containing-near-sandbox
```

`--sandbox-dir` is the **directory** containing the patched `near-sandbox` binary, not the binary path itself. Verify unpacks the included frozen bundle, WASMs, manifest and raw report, then invokes the shared verifier. Replay invokes the known runner from the unpacked bundle and verifies the new report; it does not trust the exported result.

## What is checked

- Candidate and correction bytes match their declared SHA-256 hashes and WASM code hashes.
- The frozen state, code hash, policy, proposal and recipient identity match the bundle.
- The actual transfer operation matches the frozen `proposal.kind.Transfer`: recipient, amount, token, message and proposal ID.
- Every root and child receipt resolves exactly once; no missing child, duplicate ID or unbound executor passes.
- Retry snapshots recompute recipient, contract and proposer balances instead of accepting stored booleans.
- Summary and comparison verdicts match the recomputed branch results, including the candidate.

The verifier’s output is **offline consistency**, not a cryptographic execution attestation. A complete exported review is evidence of a local replay and its stated checks, not a production authorization or an audit.

## Claim boundaries

- The bad candidate is a deliberately seeded local fixture derived from a verified candidate. It is not a live vulnerability, lost funds or a production incident.
- The local contract holds test funds; nothing is spent on a public chain.
- The UI and runner are local-only. There is no hosted reviewer service, custody, upgrade authorization or mainnet execution.
- The supported family is `sputnik-dao-v2` with a `Transfer` proposal. Unsupported families and methods are rejected.
- The export helper does not execute command strings from an untrusted file.

## Repository layout

- `case-triage/sputnik-public-capture/` — frozen-state runner, fixtures, verifier and portable export helper.
- `ui/sputnik/` — local consequence-first interface and job controller.
- `docs/` — supporting notes; the historical refund app is preserved in `docs/legacy-refund-app.md`.

## Test and review commands

```sh
node --check case-triage/sputnik-public-capture/local-three-branch.cjs
node --check case-triage/sputnik-public-capture/verify-local-three.cjs
node case-triage/sputnik-public-capture/export-helper.cjs verify \
  --export /tmp/sputnik-export.json --out /tmp/sputnik-verify
```

For a complete UI run, the page performs the verifier before enabling export. The server preserves completed reports across restart and marks interrupted jobs `inconclusive`.
