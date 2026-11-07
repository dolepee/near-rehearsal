# Rehearsal Repair checkpoint

Status: **source-built issue #238 reproduction and repaired control complete on local Sandbox 2.14.0; model-generated repair not claimed.**

## Pinned source

- Repository: `https://github.com/near-daos/sputnik-dao-contract`
- Commit: `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`
- Toolchain: Rust `1.86.0`, target `wasm32-unknown-unknown`
- Build used for the recorded artifacts:

```sh
cargo build --target wasm32-unknown-unknown --release --locked -p sputnikdao2
```

The repository's `build.sh` uses `cargo near build reproducible-wasm`. That
entry was **not run** here because `cargo-near` is not installed in this
environment; do not treat the recorded artifact as a reproducible-build result.

- Built artifact: `target/wasm32-unknown-unknown/release/sputnikdao2.wasm`
- Artifact SHA-256: `5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578`

## Reproduction result

The pinned source build was run on near-sandbox `2.14.0`. Both branches executed
from separately initialized local state:

- Healthy control: proposal `Approved`; contract `-0.1 NEAR`; recipient `+0.1 NEAR`; proposer `-0.0008306712120212 NEAR`.
- Failed async FunctionCall: proposal `Failed`; contract `+1 NEAR`; recipient `0`; proposer `-1.0008510133192634 NEAR`.

The failed branch shows the inherited proposal bond staying in the contract
while the proposer bears the bond plus gas. Raw receipts and deltas are in
`out/issue238-local.json`.

The earlier `FunctionCallError: CompilationError: PrepareError: Deserialization`
failures were specific to the older sandbox runtimes tested (`2.6.2`, `2.10.0`,
`2.11.0`); the same artifact initializes on `2.14.0`. The runner now finalizes
`new` and waits for the first view before creating a proposal.

## Repaired control

The authored source patch in `repair.patch` returns the proposal bond from
`internal_callback_proposal_fail` before the `Failed` state is persisted. It was
compiled with the same pinned toolchain and source revision.

- Repaired artifact SHA-256: `41001450691f372c38f8841795dcd7c3a113c62fc750bfd9a7b5e280fd3ecdf5`
- Repaired failed async: proposal `Failed`; contract delta `0`; recipient `0`; proposer `-0.0009088584569685 NEAR` (gas only).
- Repaired healthy control: proposal `Approved`; contract `-0.1 NEAR`; recipient `+0.1 NEAR`; proposer `-0.0008307086304614 NEAR`.

The base failed branch had contract `+1 NEAR` and proposer `-1.0008510133192634 NEAR`; the repair removes the stranded bond while preserving the healthy payout. Raw reports are in `out/issue238-local.json` and `out/issue238-repaired.json`.

A deliberately partial source variant returned the bond only for `Transfer` failures. Its artifact SHA-256 is `3a1a8fb7929efd8fb1f0882c60844338ebea4c4505413080b2e9539013eec896`; its report is `out/issue238-partial.json`. The acceptance test rejects it because the `FunctionCall` branch still leaves the contract delta at `+1 NEAR`.

Each branch runs in its own local worker with the same fixed account IDs and funding. The base and repaired runs share the same frozen `state`/`policy`; the contract balance differs only because the two artifacts have different code storage. Acceptance checks the state/policy equality across the two artifacts and the healthy/failed before-state equality within each run.

## Independent acceptance

```sh
node case-triage/rehearsal-repair/acceptance.cjs
node case-triage/rehearsal-repair/acceptance-tests.cjs
```

The first checks base/repaired artifact identity, healthy payout and beneficiary/amount, failed status, base stranded bond, repaired zero contract delta and gas-only proposer delta, rejected unauthorized callback, and identical starting state within each run. The second is the positive control plus eight targeted rejections: hidden base bond, double refund, missing payout, false failed status, changed artifact identity, accepted unauthorized callback, changed beneficiary, and the partial source repair.

This is an authored deterministic patch, not a model-generated patch. The model
provenance gate remains separate and blocked at authentication.

## Controller allowlist

`repair-controller.cjs` validates every patch section, not only `diff --git`
headers: only `sputnikdao2/src/proposals.rs` is allowed; tests, acceptance
files, Cargo configuration and build scripts are forbidden, as are absolute or
escaping paths, mixed header paths, repeated targets, renames/copies and
identity-changing sections. It can also apply the patch in a fresh copy of the
pinned source and enumerate the paths that actually changed before any build.
`controller-tests.cjs` covers the authored positive control, the mixed-format
forbidden-file regression, and apply-enumeration positive and negative cases.

```sh
node case-triage/rehearsal-repair/repair-controller.cjs case-triage/rehearsal-repair/repair.patch
REPAIR_SOURCE_DIR=/workspace/near-rehearsal/rebuild-base \
  node case-triage/rehearsal-repair/repair-controller.cjs case-triage/rehearsal-repair/repair.patch \
  case-triage/rehearsal-repair/controller-manifest.json /workspace/near-rehearsal/rebuild-base
node case-triage/rehearsal-repair/controller-tests.cjs
```

## Model loop preparation

`model-prompt.md` and `controller-manifest.json` define the source-only repair
input: one allowlisted file, no tests or build scripts, and controller-owned
acceptance. `model-input.cjs` builds the model input from the task plus only
the pinned allowlisted source file; it has no path for tests, the authored
patch or the rest of the tree. `model-producer.cjs` runs an authorized coding
CLI from `MODEL_PRODUCER_CMD`, requires a unified git diff, applies the
controller allowlist, and verifies the actual changed paths in a fresh source
tree before writing a candidate. It does not build, accept or publish anything.
Its preflight requires a fresh nonce, not merely a zero exit status.

```sh
MODEL_PRODUCER_CMD='["<coding-cli>","-p","{prompt}"]' \
  node case-triage/rehearsal-repair/model-producer.cjs --preflight

MODEL_PRODUCER_CMD='["<coding-cli>","-p","{prompt}"]' \
  node case-triage/rehearsal-repair/model-producer.cjs \
  --source /workspace/near-rehearsal/rebuild-base
```

Current free preflight: the CLI is authenticated, but a one-line inference
request exits `1` with `Failed to authenticate. API Error: 403 This agent's
plan does not include this model. Continue with its configured model.` No
model call completed, no patch was produced, and no paid fallback was used.
The authored patch remains controller evidence only, not a model-generated
repair.

```sh
node case-triage/rehearsal-repair/model-producer-tests.cjs
node case-triage/rehearsal-repair/controller-tests.cjs
```

## Next bounded step

Run the repair from the same frozen state as the retained branches and add the
independent acceptance predicates (exactly-once bond, immutable beneficiary and
amount, unauthorized callback rejection). Do not treat this checkpoint as a
general audit or a release claim.
