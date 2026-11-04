# Local rehearsal page

Consequence-first interface for the supported `refund-v1` case. It is backed by the actual three-way runner; the page does not load the committed report as a result.

## Run it

From the repository root:

```sh
PORT=4173 npm run ui
```

Open `http://127.0.0.1:4173`.

On the arm64 development host, set the sandbox wrapper before launch if it is not already in the shell:

```sh
export NEAR_SANDBOX_BIN_PATH=/workspace/tools/near-sandbox-wrapper
export NEAR_SANDBOX_BINARY_PATH=/workspace/tools/near-sandbox-wrapper
PORT=4173 npm run ui
```

The server starts `scripts/refund-three-way.cjs` for each Rehearse click. Rehearsing writes a fresh `out/refund-report.json`; the UI only displays the report produced by that run. After a validated complete run, **Export verified replay** writes a hashed bundle under `out/exports/` through the verifier-backed export script.

## Verifier-backed export

```sh
node scripts/export-refund-replay.cjs
node scripts/verify-refund-export.cjs out/exports/<bundle>
node scripts/replay-refund-export.cjs out/exports/<bundle>
```

The export script refuses anything other than a complete report that passes the verifier. The bundle pins the case, capture, runtime, report hash, input hashes, and the exact rerun/verify commands. Replay does not trust the bundled report; it executes the runner again against the bundled capture and verifies the new report.

## Supported input path

- Select a candidate WASM or load one of the two local fixture files.
- The browser computes its SHA-256; the server revalidates the bytes and hash.
- Declared migration and operation are parsed and checked against the supported refund family: `migrate({})`, `claim_refund({})`, `get_refundable`.
- Candidate focus only changes the featured outcome; the exact uploaded bytes are executed in the candidate branch. Unsupported exports, fields, methods or hashes reject before a run.
- The candidate is classified from its own receipts and entitlement: beneficiary paid, structured NO_REFUND, or inconclusive. Corrections are not forced to reproduce the seeded bug.
- After a complete run, the export button produces a verifier-backed bundle containing the exact candidate and declared inputs.

## Current WIP boundaries

- Local Sandbox only; no deployment or public URL.
- Candidate focus changes the featured consequence; both candidates always run for the comparison.
- Corrected rerun is a fresh three-way run from the frozen capture, not a cached result.
- The page has been exercised for startup, health, running, and report response states through the local API. A visual browser pass remains for the first browser checkpoint.
