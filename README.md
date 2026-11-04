# NEAR Rehearsal — refund maintainer app

A local, authored-state release rehearsal for one small NEAR refund contract family. The app runs the existing funded-refund case; it is not the earlier counter CLI.

The current supported journey is:

- a local Sandbox contract funded with `1.00` NEAR and one stored `0.10` NEAR refund entitlement;
- a baseline `claim_refund()` that pays the captured beneficiary;
- a supplied candidate WASM with a declared `migrate({})` migration and the same `claim_refund()` operation;
- a corrected reference migration for comparison;
- a consequence-first local page that shows the candidate outcome before provenance, with receipt and raw-report detail behind the result.

A paid result now requires all of: the contract’s `SuccessReceiptId` links to a beneficiary `SuccessValue` receipt, the linked transfer action is for the captured beneficiary, and the actual `Transfer.deposit` equals the inherited `0.10` NEAR entitlement. A linked receipt or positive balance alone is not enough.

## Supported host and versions

The clean-checkout path below is supported on **Linux x86_64 with glibc**. The repository has also been exercised on Linux arm64 through an emulation wrapper, but that is a host workaround, not a supported portable setup. macOS and Windows are unverified for this checkpoint.

- Node.js: **24.22.1** is the tested and documented version (`.nvmrc`). `near-workspaces@5.0.0` declares `node >=20.15.0`, but this checkpoint is only exercised on 24.22.1.
- NEAR Sandbox runtime: **2.6.2**, protocol **77**, commit **`2f9ddb711ebd94a306eaec06030d87ef8dfc51fa`**.
- The runner refuses non-local execution RPCs and starts its own local Sandbox branches.
- `ulimit -n 65535` is required on the tested host to avoid file-descriptor exhaustion.

## Clean checkout setup

```sh
git clone https://github.com/dolepee/near-rehearsal.git
cd near-rehearsal
git switch feat/maintainer-release-journey
git rev-parse HEAD
npm ci --ignore-scripts
node scripts/patch-near-sandbox.cjs
npm run compile
npm run test:guards
```

`npm ci --ignore-scripts` deliberately skips the `near-sandbox` postinstall download. `scripts/patch-near-sandbox.cjs` makes an explicitly supplied `NEAR_SANDBOX_BIN_PATH` take precedence over the package’s platform lookup; it does not change the NEAR runtime bytes.

The checked-in `out/refund-report.json`, `out/refund-half-report.json` and `out/exports/` are evidence from this branch, not a substitute for a fresh run.

## Official runtime acquisition

Run these steps on the supported Linux x86_64 host. The archive is the official NEAR 2.6.2 Sandbox release:

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
```

The archive is `28,469,491` bytes and extracts `Linux-x86_64/near-sandbox`. Its SHA-256 is the value checked above. The runtime pin is recorded independently in every report and is rechecked against the captured and actual runtime.

Do not use a host-specific wrapper path. On a non-x86_64 host, use `scripts/sandbox-wrapper.sh` only as an explicitly unverified emulation workaround, with `NEAR_SANDBOX_REAL_BIN`, `NEAR_SANDBOX_QEMU` and `NEAR_SANDBOX_QEMU_LD_PREFIX` set to local paths.

## Launch the app

With the runtime environment from above active:

```sh
PORT=4173 npm run ui
```

Open `http://127.0.0.1:4173`. The server binds to `127.0.0.1` by default and is intentionally local-only; this repository provides no tunnel, public deployment or hosted reviewer service.

The page starts the actual runner; it does not display a precomputed report as a new result.

## Bad and corrected user path

1. Start the app as above.
2. Select `contracts/refund-v2-bad.wasm` as the candidate.
3. Keep the declared input family `migrate({})` and operation `claim_refund({})` (view `get_refundable()`).
4. Rehearse. The seeded bad migration removes the stored entitlement, so the same beneficiary claim produces a structured `NO_REFUND`; the contract still holds the funds.
5. Rehearse again with `contracts/refund-v2-fixed.wasm`. The corrected migration preserves the `0.10` NEAR entitlement, and the claim pays the captured beneficiary.
6. In the result panel, inspect the candidate outcome first, then the linked receipt and raw report tabs. Export is enabled only after a complete, verifier-backed run.

The bad branch is an authored comparison case, not a claim of a live vulnerability or lost funds.

## Verify, export and replay

```sh
npm run rehearse:refund
npm run verify:refund
npm run export:refund
node scripts/verify-refund-export.cjs out/exports/<bundle>
node scripts/replay-refund-export.cjs out/exports/<bundle>
```

`npm run rehearse:refund` writes `out/refund-report.json`. `npm run export:refund` refuses anything other than a complete report that passes the verifier, then writes a bundle with the exact inputs, hashes and commands. Replay executes a fresh three-way run from the bundled capture and verifies the new report; it does not trust the bundled result.

### Half-payout regression

The same family has a half-payout review fixture. It keeps the stored `0.10` entitlement but transfers only `0.05` NEAR:

```sh
npm run rehearse:refund -- \
  --case cases/refund-v1/half-case.json \
  --report out/refund-half-report.json
node scripts/verify-refund-report.cjs \
  out/refund-half-report.json \
  cases/refund-v1/half-case.json
npm run test:amount
```

The half run is reported as `amount-regression`, is incomplete, and cannot be exported. `npm run test:amount` also checks that the full `0.10` baseline and corrected transfers match exactly, and that a missing transfer amount is rejected rather than treated as preservation.

## Claim boundaries

- This is a local authored-state example: a `1.00` NEAR Sandbox contract and one stored `0.10` NEAR entitlement. It is not a public-chain capture, production upgrade authorization, custody claim or audit.
- The bad migration is deliberately seeded. The contract still holds funds in that branch; nothing was stolen or lost.
- The runner supports only the `refund-v1` family and the declared `migrate({})` / `claim_refund({})` / `get_refundable()` operation. It rejects unsupported fields, methods, families and hash edits.
- A successful claim is not enough: the linked transfer amount must equal the inherited obligation. Missing amount evidence is inconclusive; a known different amount is an amount regression and is not exportable.
- The earlier counter/public slice is historical material and remains in [docs/legacy-counter-slice.md](docs/legacy-counter-slice.md). It is not the current app path.
