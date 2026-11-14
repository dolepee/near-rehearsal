# Sputnik #238 consequence evidence

Recorded local review material. These files are not a live run and not a mainnet claim.

- Source: https://github.com/near-daos/sputnik-dao-contract
- Pinned commit: 5434a59dec23ee0c49df8c8c4350c208a7e75b0b
- Runtime: Sandbox 2.14.0, protocol 88
- Policy SHA-256: 84398252f458aa7f0197a75430ea4f4d19d18500ca7b25d65e173451fdf03011
- Baseline WASM: 5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578
- Clear-all candidate: 684eabc429fc691f68aef8baf7f2e226f42ae481e3da4a1f41a54598e302d9b6
- Intended candidate: 133c60cfb711d285c613c386d6b745ef6525438f5290b1d9feeffbd44f58d09d

## Reproduce with the supported source-review command

```sh
git clone https://github.com/dolepee/near-rehearsal.git
cd near-rehearsal
npm run setup
# Check out a clean pinned source tree at 5434a59dec23ee0c49df8c8c4350c208a7e75b0b,
# install Sandbox 2.14.0, then:
npm run review:patch -- --patch <downloaded>/clear-all.patch --source <clean-pinned-checkout> --out <new-directory> --sandbox-dir <sandbox-2.14-directory>
```

The recorded report and the candidate/patch hashes are included here. The command
builds the patch from source and exercises the persisted recovery and same-DAO
policy; it does not execute a public chain transaction. Full source-build
prerequisites, compiler-boundary provisioning, and dependency-cache setup are in
[the canonical local repair setup](https://github.com/dolepee/near-rehearsal/blob/main/docs/local-repair-setup.md#source-and-compiler).

## Reviewer handoff

The accepted **Intended repair** has a direct [reviewer handoff JSON](repair-bundle-intended.json)
(SHA-256 `4973b6fccf4a9f2824ed396107cd44fe4dc3724f185846fda868ba0bb8948063`). It is the existing repair-review bundle,
not a second format; its producer is `null` and the recorded execution remains
the displayed evidence. Download it, then run the local reviewer. On macOS
select **Recorded WASM replay**; on Linux use the confined **Source build**. The
reviewer exports fresh evidence after its own run.

```sh
npm run repair:review -- --bundle repair-bundle-intended.json --out <new-directory> --mode recorded-wasm --sandbox-dir <sandbox-2.14-directory>
```

Use `--mode source-build --source <clean-pinned-checkout>` on a supported Linux
host. The rejected Clear-all candidate intentionally has no handoff.

## Files

- `clear-all.patch` / `clear-all.wasm`: rejected candidate.
- `intended.patch` / `intended.wasm`: accepted candidate.
- `intended.proposals.rs` / `intended-identity.json`: applied source and controller identity for that candidate.
- `old.wasm`: pinned baseline code.
- `mixed-obligation-clear-all.json`: recorded bad result.
- `mixed-obligation-intended.json`: recorded good result.
- `mixed-obligation-old.json`: baseline recording.
- `issue238-local.json`: controller-owned fixture used for expected bond/transfer amounts.
- `manifest.json`: candidate source/build identity.
- `LICENSE`, `THIRD_PARTY_NOTICES.md` and `LICENSES/sputnik-dao-contract-MIT.txt`: project license and upstream attribution for this detached packet.
