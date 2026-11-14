# F18 refund-only retry — WIP handoff

Status: exploratory contract implementation and compiled artifact. Not accepted source-build proof and not a canonical release change.

- Source commit base: `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`
- Patch: `case-triage/rehearsal-repair/repair.patch`
- Patch SHA-256: `9ae060af97dcb7f4ced31d135ac84b0130f274032f17c2acb1a56e43a6ebf3d0`
- Source file: `case-triage/rehearsal-repair/mixed-candidates/intended-proposals.rs`
- Source SHA-256: `1e1c693fc2cae3c2ce3159a1e0d79699a6e8085148b5c521cb166acddd74464c`
- WASM: `case-triage/rehearsal-repair/mixed-candidates/intended.wasm`
- WASM SHA-256: `3205860e557dbe4852e4022866ab7cc6461483d39a7be3e990ade3287f3c8df4`
- WASM size: `539065` bytes

## Behavior

`Action::Finalize` accepts a refund-only retry only when:

1. the recorded proposal status is `Approved`;
2. the caller is the original `proposal.proposer`;
3. `read_refund_state(id)` is `REFUND_FAILED`.

The branch calls `internal_return_proposal_bond(id, &proposal).detach()` and never re-executes the successful business action. A later `Finalize` after `REFUND_SETTLED` panics with `ERR_PROPOSAL_ALREADY_EXECUTED` before any action execution.

Method/argument names: `act_proposal` with `action: "Finalize"`, `id`, and the recorded `proposal` kind; refund state helpers are `read_refund_state`, `write_refund_state`, `internal_return_proposal_bond`; states are `REFUND_OPEN`, `REFUND_IN_FLIGHT`, `REFUND_FAILED`, `REFUND_SETTLED`.

## Exact exploratory build

From a clean checkout at the source commit after applying `case-triage/rehearsal-repair/repair.patch`:

```bash
cargo build --release --target wasm32-unknown-unknown -p sputnikdao2
```

The resulting `target/wasm32-unknown-unknown/release/sputnikdao2.wasm` was copied to `intended.wasm`. The supported CI build uses the controller command:

```bash
cargo build --target wasm32-unknown-unknown --release --locked -p sputnikdao2
```

## Native evidence

`case-triage/rehearsal-repair/out/audit-intended/successful-action-refund.json` records the local Sandbox 2.14 execution: approved transfer paid exactly 0.1 NEAR once, the bond moved from 1 NEAR locked to 0, the proposer recovered the bond, and a duplicate `Finalize` was denied with `ERR_PROPOSAL_ALREADY_EXECUTED`.

This is exploratory local evidence. It is not a native-Chain acceptance result, not a source-build proof from the confined CI boundary, and must not be used to alter the accepted release before the dependent reports and public handoff are regenerated.
