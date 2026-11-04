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

The server starts `scripts/refund-three-way.cjs` for each Rehearse click. Rehearsing writes a fresh `out/refund-report.json`; the UI only displays the report produced by that run. Export remains disabled until verifier integration.

## Current WIP boundaries

- Local Sandbox only; no deployment or public URL.
- Candidate focus changes the featured consequence; both candidates always run for the comparison.
- Corrected rerun is a fresh three-way run from the frozen capture, not a cached result.
- The page has been exercised for startup, health, running, and report response states through the local API. A visual browser pass remains for the first browser checkpoint.
