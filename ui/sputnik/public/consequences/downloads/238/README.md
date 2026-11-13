# Sputnik #238 consequence evidence

Recorded local review material. These files are not a live run and not a mainnet claim.

- Source: https://github.com/near-daos/sputnik-dao-contract
- Pinned commit: 5434a59dec23ee0c49df8c8c4350c208a7e75b0b
- Runtime: Sandbox 2.14.0, protocol 88
- Policy SHA-256: 0ba1409ced552aa04d46f40267197fc57226ca9fcbd55e317404e2709784f826
- Baseline WASM: 5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578
- Clear-all candidate: 684eabc429fc691f68aef8baf7f2e226f42ae481e3da4a1f41a54598e302d9b6
- Intended candidate: fe4401bcc33aedb7992ffa5163570355fc1757e123bd588aa4f9a84302967a0c

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
policy; it does not execute a public chain transaction.

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
