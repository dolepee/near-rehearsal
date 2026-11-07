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

The pinned source build was run on near-sandbox `2.14.0`. The runner reads the
actual `near-sandbox --version` output before creating a worker, requires
`release 2.14.0`, commit `bc4e9e8cfb03d9e82f027883055624e18576993e` and protocol
`88`, and records that runtime in each report. It no longer falls back to a
`2.6.2` label. Both branches executed from separately initialized local state:

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

The authored source patch in `repair.patch` records the proposal bond and
consumes it through a zero sentinel before the `Failed` state is persisted. The
zero sentinel is deliberate: writing an empty value can be read as an absent
key and would allow a second refund. It was compiled with the same pinned
toolchain and source revision.

- Repaired artifact SHA-256: `539f1bb88d00dc8cc7153a7d6d00a3cbeab1579fd1fdfc2931d36e85adc710ff`
- Repaired failed async: proposal `Failed`; contract delta `0`; recipient `0`; proposer `-0.0009333866610499 NEAR` (gas only).
- Failed-proposal `Finalize` retry: no second bond; contract `0`; recipient `0`; proposer pays gas only. The base control also strands the bond and its retry returns nothing.
- Repaired healthy control: proposal `Approved`; contract `-0.1 NEAR`; recipient `+0.1 NEAR`.

The base failed branch had contract `+1 NEAR`; the repair removes the stranded bond while preserving the healthy payout. Raw reports are in `out/issue238-local.json` and `out/issue238-repaired.json`. The acceptance path requires the failed-proposal retry evidence, including an immediate post-failure anchor, and rejects any positive proposer delta on retry.

A deliberately partial source variant returned the bond only for `Transfer` failures. Its artifact SHA-256 is `3a1a8fb7929efd8fb1f0882c60844338ebea4c4505413080b2e9539013eec896`; its report is `out/issue238-partial.json`. The acceptance test rejects it because the `FunctionCall` branch still leaves the contract delta at `+1 NEAR`.

Each branch runs in its own local worker with the same fixed account IDs and funding. The base and repaired runs share the same frozen `state`/`policy`; the contract balance differs only because the two artifacts have different code storage. Acceptance checks the state/policy equality across the two artifacts and the healthy/failed before-state equality within each run.

## Independent acceptance

```sh
node case-triage/rehearsal-repair/acceptance.cjs
node case-triage/rehearsal-repair/acceptance-tests.cjs
node case-triage/rehearsal-repair/pipeline-guards-tests.cjs
```

The first checks base/repaired artifact identity, healthy payout and beneficiary/amount, failed status, base stranded bond, repaired zero contract delta and gas-only proposer delta, rejected unauthorized callback, identical starting state within each run, actual Sandbox 2.14.0/commit/protocol and binary hash, and exactly-once failed-proposal retry (anchored after the first failure and unauthorized callback). The guard test covers the real rustup home, actual cargo/rustc 1.86.0, wrong-toolchain rejection, Sandbox 2.14.0 acceptance and wrong/missing-runtime rejection. The second is the positive control plus targeted rejections: hidden base bond, double refund, missing payout, false failed status, changed artifact identity, accepted unauthorized callback, changed beneficiary, partial source repair, and changed candidate identity/report/wasm controls.

This is an authored deterministic patch, not a model-generated patch. The model
provenance gate remains separate and blocked at authentication.

For a real model candidate, acceptance accepts a controller-owned identity:
`candidate-identity.cjs` hashes the patch, the cleanly applied allowlisted
source and the actual built WASM after the build. Acceptance re-hashes those
same files, compares the replay report's WASM hash to the identity, and still
runs every behavioral predicate. With no identity, the authored repaired hash
remains the default; the expected hash is never overwritten.

## Controller pipeline

`repair-pipeline.cjs` performs the real candidate path: patch guard, clean
apply in a fresh pinned tree, toolchain verification, build, Sandbox binary
verification, new Sandbox replay report, candidate identity and acceptance with
changed-artifact rejection. It resolves the real Rust 1.86.0 toolchain and sets
`RUSTUP_HOME` to that rustup root instead of deriving it from a PATH shim; it
runs `cargo --version` and `rustc --version` and fails unless both report
1.86.0. Before replay it runs the actual `near-sandbox --version`, requires
`release 2.14.0`, and records the binary path, version output and SHA-256. A
wrong runtime fails before replay instead of being reported as a model failure.
It writes a separate candidate report under `--out`; it never treats the
authored repaired report as the model report.

```sh
node case-triage/rehearsal-repair/repair-pipeline.cjs \
  --patch <model.diff> \
  --source /workspace/near-rehearsal/rebuild-base \
  --out out/model-candidate
```

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
Its preflight requires a fresh nonce, not merely a zero exit status. Repair
generation requires `MODEL_PRODUCER_SANDBOX_CMD` and fails closed without it;
the producer receives only a small environment allowlist (or names listed in
`MODEL_PRODUCER_ENV`), never the broad parent environment.

Repair generation is fail-closed: a prompt alone does not confine the CLI, so
`MODEL_PRODUCER_SANDBOX_CMD` is required. It is a JSON argv prefix containing
`{workspace}`; the adapter creates a disposable directory outside the
repository, substitutes that path, appends the producer command, and proves the
confinement before use: the authored patch must be unreadable, controller-owned
files must not be writable, and `{workspace}` must be writable. Without a
passing probe the run is blocked and no patch is captured. Controller-owned
file hashes are re-checked after the producer exits, and a captured candidate
is never overwritten by a later run in the same output directory.

```sh
MODEL_PRODUCER_CMD='["<coding-cli>","-p","{prompt}"]' \
MODEL_PRODUCER_SANDBOX_CMD='["bwrap","--ro-bind","/","/","--tmpfs","<repo>","--bind","{workspace}","{workspace}","--"]' \
  node case-triage/rehearsal-repair/model-producer.cjs \
  --source /workspace/near-rehearsal/rebuild-base --out out/model-candidate
```

The preflight runs in the same disposable workspace but needs no sandbox: it
has no repository-derived input and captures no patch.

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

## Tool-free local producer driver

`codex-producer.cjs` is the one-command local path for a genuine Codex run. It
uses a private provider-runtime directory and a transient read-only symlink to
the existing local `auth.json`; token values are never copied or logged, the
original auth/config directory is never made writable, and the runtime is
removed in `finally`. The model has no tools: shell, unified execution, apps,
plugins, browser, computer and code-mode host features are disabled. The model
returns only a unified diff as text. The controller then applies that diff in a
separate disposable single-file tree with `git apply --recount
--unidiff-zero`, enumerates the real changed paths, rejects anything outside
`sputnikdao2/src/proposals.rs`, regenerates a canonical contextual Git diff,
and runs the verified build/replay/acceptance pipeline with a controller-bound
candidate identity. Raw mode/type changes, renames, copies, binary sections and
`/dev/null` create/delete markers are rejected before apply; the allowlisted
path and every parent are `lstat`-checked and must remain a regular non-symlink
file before the controller reads it.

```sh
MODEL_PRODUCER_SANDBOX_CMD='["<outer-policy-wrapper>","--permission-profile","<verified-codex-permission-profile>","{workspace}","--"]' \
  node case-triage/rehearsal-repair/codex-producer.cjs \
  --source /workspace/near-rehearsal/rebuild-base \
  --out out/model-candidate-tool-free \
  --profile <verified-codex-permission-profile> \
  --private-runtime /tmp/repair-provider-runtime \
  --auth-source "$HOME/.codex/auth.json" \
  --codex-bin "$(command -v codex)" \
  --base-report out/issue238-local.json \
  --sandbox-dir <verified-sandbox-wrapper>

The prompt is sent on stdin (`-`); the provider-owned last-message file is
written inside `{workspace}` and copied controller-side after exit. The outer
`HOME` is preserved; only `CODEX_HOME` points at the private runtime, and the
temporary auth symlink is removed in `finally`. The outer
policy must permit minimal system reads, writes to `{workspace}` and
the private runtime, reads of the Codex release directory, and read-only access
to the original `auth.json`; it must deny controller/source reads other than
the allowlisted file and deny writes to the original `~/.codex`. The driver
runs the existing confinement probes before generation. `--no-daemon`,
`--ephemeral` and `--ignore-user-config` are passed to the official CLI; if the
local CLI build rejects `--no-daemon`, set `CODEX_NO_DAEMON=0` and record that
explicitly.

Fake-CLI protocol tests (no credentials, no model call, no build):

```sh
node case-triage/rehearsal-repair/codex-producer-tests.cjs
```

They cover tool-free argv construction, the private-runtime auth symlink and
cleanup, fenced/malformed diff extraction, exact stdin prompt capture,
`--recount --unidiff-zero` canonicalization, unexpected changed-path rejection,
raw symlink/type-change rejection with a harmless external sentinel, raw
transcript preservation and the complete one-command adapter through a fake
tool-free CLI.

Do not treat this checkpoint as a general audit or a release claim.
