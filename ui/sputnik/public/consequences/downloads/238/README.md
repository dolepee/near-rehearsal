# Sputnik #238 consequence evidence

Recorded local review material. These files are not a live run and not a mainnet claim.

- Source: https://github.com/near-daos/sputnik-dao-contract
- Pinned commit: 5434a59dec23ee0c49df8c8c4350c208a7e75b0b
- Runtime: Sandbox 2.14.0, protocol 88
- Policy SHA-256: edd83f24aa9ba52fc0ebb42eed3c24df67a43f8d4f84a9f0c3136e042961f0ca
- Baseline WASM: 5a20ea651da684c9623cbb9b32cab968e4eed3ca22b905decfdb2a4aaaa16578
- Clear-all candidate: 684eabc429fc691f68aef8baf7f2e226f42ae481e3da4a1f41a54598e302d9b6
- Intended candidate: 158f0f0e0a98b3df11fb86828aa72bc0edbe4e992f5db0ab8f86f012eb754f7d

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
