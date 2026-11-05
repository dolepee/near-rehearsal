# Verified refund rehearsal export

This is a local-Sandbox, authored seeded-migration export. It is not a public-chain capture, production upgrade authorization, or custody claim.

## Verify the bundle

```sh
node scripts/verify-refund-export.cjs out/exports/refund-v1-bb7018d7163e
```

## Rerun and verify independently

```sh
node scripts/replay-refund-export.cjs out/exports/refund-v1-bb7018d7163e
```

The rerun starts from the capture in this bundle and executes baseline, seeded bad, and corrected branches against a fresh local Sandbox. It writes a fresh report and verifies it; it does not trust the bundled evidence as a result.

Runtime pin: `2.6.2` / protocol `77` / commit `2f9ddb711ebd94a306eaec06030d87ef8dfc51fa`.

Source commit at export: `3c5c978d8430298b9802cf49479b8c1e64c47ae9`.
