# Retry evidence separation

This directory preserves the older authored-control failure so it is not
confused with candidate 2.

- `authored-410-retry-failure.json`: authored repaired control
  `41001450691f372c38f8841795dcd7c3a113c62fc750bfd9a7b5e280fd3ecdf5`.
  First failure returned the bond once; a later authorized `Finalize` retry
  returned it again (`contract -1 NEAR`, `proposer +0.999327... NEAR`).
  This was the old authored control, not candidate 2.
- Candidate 2 is bound separately to patch `edf16b96...`, applied source
  `6abe3d47...` and the actual host-built WASM. In both the local `3990e088...`
  run and the independent `9425384b...` run, no retry refund occurred.

The authored control was subsequently fixed with a zero sentinel and is
identified by artifact `539f1bb8...`; the old report above is retained as raw
failure evidence and is not used for acceptance.
