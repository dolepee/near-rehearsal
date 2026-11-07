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

Return a unified diff only. Do not claim it compiles or passes; the controller
will apply it, build it, and run independent acceptance.
