# Review a maintainer patch

`scripts/review-patch.cjs` is the model-free entry point for a source patch
against the supported pinned Sputnik revision. It does **not** need a
Rehearsal-produced bundle and it does not call a model.

## Command

```sh
npm run review:patch -- \
  --patch /path/to/maintainer.diff \
  --source /path/to/clean/sputnik-dao-contract \
  --out /tmp/review-patch-run \
  --repo near-daos/sputnik-dao-contract \
  --base 5434a59dec23ee0c49df8c8c4350c208a7e75b0b \
  --head <PR-head-or-candidate-label> \
  --sandbox-dir /path/to/directory-containing-near-sandbox
```

The source checkout must be at the pinned revision declared by the checker
manifest and must be clean. The Sandbox directory is the directory containing
the executable `near-sandbox`; on this host the pinned compatibility wrapper is
`/workspace/tools/near-sandbox-2.14-wrapper`.

The output directory must be new or empty. Existing evidence is never
overwritten.

## What runs

The command reuses the existing engine:

1. Validate the patch and its changed paths.
2. Apply it to a fresh exact-pinned source tree.
3. Build `sputnikdao2.wasm` with the pinned Rust toolchain.
4. Run the fresh-state replay.
5. Run the persisted old-code failure and candidate upgrade without `new()`.
6. Run the independent persisted-recovery acceptance.
7. Write the status, report and evidence.

It does not trust a submitted verdict. It does not accept caller labels as
provenance. It never upgrades a live account.

## Statuses

- **ACCEPTED** — the defined source, build, replay, recovery and preservation
  checks passed. This is not a universal-safety claim, an audit, a deployment
  or live-DAO recovery.
- **REJECTED** — the candidate was valid and executable, but failed a defined
  recovery or preservation check. The patch and logs are preserved; no accepted
  replay bundle is written.
- **INPUT_ERROR** — the patch, source checkout or caller input could not form a
  valid candidate. No economic result is produced.
- **BUILD_ERROR** — the candidate was valid input but did not compile. No
  economic result is produced.
- **INCONCLUSIVE** — a missing runtime or interrupted execution prevented a
  judgment. Missing results are never converted into success.

## What is supplied versus verified

`--repo`, `--base` and `--head` are caller labels. They are recorded under
`supplied` and are not treated as verified provenance.

The report separately records what was actually checked:

- source commit read from the checkout;
- patch SHA-256;
- applied source SHA-256;
- built WASM SHA-256;
- checker policy SHA-256, covering the controller manifest, build manifest,
  pipeline, persisted-recovery engine, base report, base WASM and acceptance
  scripts;
- the actual checks that ran.

The report is evidence, not a signature and not a GitHub-enforced merge
restriction.

A candidate is rejected only from a completed pipeline verdict with a defined
acceptance error. A `replay.log` file by itself is not a rejection: Sandbox
startup, RPC and dependency interruptions also leave that log, and those remain
inconclusive. An executed authority probe that did not fail is preserved as
structured evidence and rejected; a transport failure with no executed
transaction remains inconclusive.

## Outputs

- `review-status.json` — machine-readable status, supplied labels, verified
  identities, policy identity, checks and limitations.
- `review-report.md` — human-readable report with the status meaning first.
- `evidence/` — patch, logs, pipeline result, candidate identity, persisted
  recovery report and acceptance result.
- `recovery-packet.json` — only for an ACCEPTED result.
- `rejected-evidence.json` — for a REJECTED, INPUT_ERROR or BUILD_ERROR result.
- `review-evidence.json` — for a non-accepted result.
- `SHA256SUMS` — hashes of the report and evidence files.

## Trust boundaries

- **Source build** means the submitted patch was applied and compiled by this
  checkout. The resulting WASM is bound to the actual build artifact.
- **Recorded-WASM replay** is a separate path, `npm run repair:review`, for an
  already-produced artifact or bundle. It executes supplied bytes and does not
  claim that a source build produces them.
- This command is source-build only.
- The supported case is local Sandbox 2.14 and the pinned Sputnik #238
  failed-async-FunctionCall obligation. It is not an arbitrary-contract engine,
  a DAO governance route or a live recovery service.

## Tests

```sh
npm run test:review-patch
```

The unit tests cover argument validation, the status vocabulary, policy
identity and report-language boundaries. The acceptance examples require real
candidate builds; a result is never inferred from an edited JSON report.

## Independent replay

A reviewer can rerun the same command against the same patch and source
checkout. The report records the exact patch and built-artifact hashes so a
different result is visible rather than silently accepted. The reviewer should
compare the source commit, patch hash and built WASM hash, not the caller labels.
