# Rehearsal Repair evidence bundle

Local Sandbox evidence for the authored issue #238 repair. This is not a
model-generated patch, a public-chain capture, a production upgrade
authorization, or a release claim.

## Contents

- `repair.patch` — authored source-only repair
- `artifacts/base.wasm` — pinned source build
- `artifacts/repaired.wasm` — repaired source build
- `artifacts/partial.wasm` — deliberately partial control
- `reports/` — raw issue #238 reports
- `acceptance.json` — controller acceptance result
- `acceptance-tests.json` — positive control plus eight rejections
- `controller.json` — source-only patch allowlist result
- `controller-tests.json` — allowlist positive and negative controls
- `manifest.json` / `SHA256SUMS`

## Verify

```sh
node case-triage/rehearsal-repair/acceptance.cjs
node case-triage/rehearsal-repair/acceptance-tests.cjs
node case-triage/rehearsal-repair/repair-controller.cjs case-triage/rehearsal-repair/repair.patch
node case-triage/rehearsal-repair/controller-tests.cjs
```
