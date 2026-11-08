# Applied candidate source

`proposals.rs` here is the result of applying the bound `repair.patch` to upstream
`sputnikdao2/src/proposals.rs` at commit
`5434a59dec23ee0c49df8c8c4350c208a7e75b0b` in a clean checkout.

Reproduction:

```bash
tmp=$(mktemp -d)
git -C /path/to/sputnik-dao-contract worktree add --detach "$tmp" 5434a59dec23ee0c49df8c8c4350c208a7e75b0b
git -C "$tmp" apply /path/to/case-triage/rehearsal-repair/generated/e8262f5a/repair.patch
sha256sum "$tmp/sputnikdao2/src/proposals.rs"
```

Hashes:

- unpatched upstream `proposals.rs`: `40ff45770a444fe3581d55eea9c968fc58954633d0c96df09232f078c0ab68c4`
- patch-applied `proposals.rs`: `82efc4225e307b97068cd7bd984da78f9a83ecf51e1b21749de344f45aa53b22`
- bound candidate identity expects the latter.

The earlier baseline report compared the unpatched file with the identity, hence its
`sourceHashMatches: false`. The corrected run points at this applied file and additionally
records the upstream hash when `NEAR_UPSTREAM_SOURCE` is supplied.
