# Model candidate 2 — issue #238 repair

Status: **compiled and accepted by the PR #3 locked healthy/failed acceptance path on local Sandbox 2.14.0**. Not merged, published, deployed or treated as a release candidate.

This bundle records a real model-generated candidate. The model supplied only a
patch; the controller generated the applied source, build, replay report,
identity and acceptance result. Candidate 1 is superseded and preserved outside
this bundle as failed provenance; its input did not match the pinned source.

## Input and normalization

- Pinned source: `sputnikdao2/src/proposals.rs`, 27,199 bytes
- Pinned source SHA-256: `40ff45770a444fe3581d55eea9c968fc58954633d0c96df09232f078c0ab68c4`
- Source commit: `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`
- Raw model patch SHA-256: `a01fc7f4fd0345dafcb376c4420ef28379626b415b1cfc9a5066644b4c35cac4`
- Canonical patch SHA-256: `edf16b966f0f49f26d73b2ac0fde980b3f8c4f638fcbbcc7c6a6bcb4fd25cf21`
- Applied source SHA-256: `6abe3d476d448f971213f69820e9f94c708baa51cd87b912605fd8d86594f28c`
- Built WASM SHA-256: `3990e08889171522989f3d47490d87b2a85e00594cea145f62344f771577fb4b`

Raw output required hunk-count/zero-context handling in a disposable
single-file tree. The raw model output is preserved unchanged in `raw.patch`;
Git regenerated `canonical.patch`. There were no manual source edits.

## Runtime path

The controller pipeline:

1. parsed every patch section with the hardened guard;
2. applied the canonical patch in a fresh exact-pinned tree and enumerated
   `sputnikdao2/src/proposals.rs` as the only changed path;
3. built with the pinned Rust 1.86.0 toolchain;
4. replayed a new healthy/failed report on local Sandbox 2.14.0;
5. generated the controller-owned candidate identity from the canonical patch,
   applied source and built WASM;
6. ran acceptance with the authored base report and the new candidate report,
   re-hashing the actual candidate files.

The authored repaired hash remains the default when no candidate identity is
supplied. It was not overwritten.

## Result

- Healthy branch: `Approved`; recipient `+0.1 NEAR`; contract `-0.1 NEAR`.
- Failed branch: `Failed`; contract delta `0`; recipient delta `0`; proposer
  delta is gas-only (`-933328001216500000000` yoctoNEAR).
- Unauthorized callback: rejected on both branches with
  `Method on_proposal_callback is private`.
- Base report: authored `out/issue238-local.json` (unchanged).
- Candidate report: this bundle's `issue238-local.json` (separate file).
- Acceptance: `ok: true`, candidate identity matched, all locked behavioral
  predicates passed, changed-artifact control rejected.

PR #3's locked acceptance path in this checkpoint has healthy/failed and
unauthorized-callback predicates. It does not contain a separate retry
predicate; no retry claim is made here and no locked test was changed.

## Changes

- `candidate-identity.cjs`: controller-owned patch/source/WASM identity.
- `acceptance.cjs`: optional candidate identity, authored defaults preserved,
  actual-file re-hashing and changed-artifact rejection.
- `repair-pipeline.cjs`: production path for clean apply, build, replay,
  identity and acceptance; resolves the declared 2.14.0 runtime.
- `repair-controller.cjs`: section-aware parser plus fresh-tree changed-path
  enumeration.
- `acceptance-tests.cjs`: independent-hash positive and changed-report/WASM
  rejection controls.
