# Source-only repair prompt

You are repairing the pinned Sputnik DAO v2 source at commit
`5434a59dec23ee0c49df8c8c4350c208a7e75b0b`.

Allowed edit: `sputnikdao2/src/proposals.rs` only.

Your input includes the pinned contents of that one file. Use only that
source; do not request or read tests, acceptance predicates, the authored
patch, or any other file.

Defect: when a proposal execution callback fails, the proposal is marked
`Failed` but its proposal bond remains in the contract. A failed async action
must return the bond to the proposer exactly once and must not create a payout
or change the beneficiary/amount.

Fresh proposals must record their actually attached deposit as the original
per-proposal principal. For inherited proposals that predate that record, the
repair must expose this exact DAO-private interface in `proposals.rs`:

```rust
#[private]
pub fn seed_legacy_proposal_bond(
    proposal_id: u64,
    proposer: AccountId,
    amount: U128,
    funding_tx_hash: String,
)
```

Contract:
- Callable only by the DAO itself.
- Reject an unknown proposal, a proposer that does not match the stored
  proposal, a non-positive amount, a malformed funding transaction hash, or
  any existing bond/refund record.
- Record the positive amount and the funding transaction hash as provenance.
- Do not change locked debt or governance.
- Recovery must refuse to pay when no trusted amount is recorded. The current
  policy amount is not a historical principal and must never be used as a
  fallback.
```

The controller supplies the measured funding transaction and deposit; the
repair must not guess them or infer them from the current policy. This prompt
is a specification only: the supplied authored patch remains separate from
any model-generated candidate, and no generation run is claimed here.

Return a unified diff only. Do not claim it compiles or passes; the controller
will apply it, build it, and run independent acceptance.
