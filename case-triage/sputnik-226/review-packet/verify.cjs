'use strict';
/*
 * Offline consistency verifier for the Sputnik #226 review packet.
 *
 * It checks the recorded evidence against the checksum manifest and semantic
 * invariants. It does NOT prove that execution happened: a rerun is the
 * execution check. It does reject missing/mismatched artifacts, inconsistent
 * finality, unexpected success/failure outcomes, wrong payment deltas, and
 * falsely successful retry receipts.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');

const here = __dirname;
const args = process.argv.slice(2);
const root = path.resolve(args.find((arg) => arg.startsWith('--root='))?.split('=')[1] || here);
const evidence = path.join(root, 'evidence');
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
const read = (name) => fs.readFileSync(path.join(evidence, name));
const json = (name) => JSON.parse(read(name).toString('utf8'));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const isSuccess = (tx) => tx?.status?.SuccessValue !== undefined;
const isFailure = (tx) => tx?.status?.Failure !== undefined;
const errorText = (tx) => JSON.stringify(tx?.status?.Failure || {});
const address = (value) => BigInt(value || 0);

function verifyChecksums() {
  const manifest = read('SHA256SUMS').toString('utf8').trim().split('\n').filter(Boolean);
  const seen = new Set();
  for (const line of manifest) {
    const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/);
    expect(match, `malformed SHA256SUMS line: ${line}`);
    const [, expected, name] = match;
    const file = path.join(evidence, name);
    expect(fs.existsSync(file), `missing evidence artifact: ${name}`);
    expect(sha(fs.readFileSync(file)) === expected, `checksum mismatch: ${name}`);
    seen.add(name);
  }
  for (const name of ['base.wasm', 'candidate.wasm', 'node-evidence.json', 'provenance.json', 'rust-result.txt', 'rust-evidence.jsonl', 'authority-probe.json', 'wrong-hash-probe.json', 'artifacts.json']) {
    expect(seen.has(name), `SHA256SUMS is missing ${name}`);
    expect(fs.existsSync(path.join(evidence, name)), `missing evidence file: ${name}`);
  }
}

function verifySemantics() {
  const artifacts = json('artifacts.json');
  const node = json('node-evidence.json');
  const provenance = json('provenance.json');
  const authority = json('authority-probe.json');
  const wrongHash = json('wrong-hash-probe.json');
  const rustResult = read('rust-result.txt').toString('utf8');
  const rust = read('rust-evidence.jsonl').toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

  expect(sha(read('base.wasm')) === artifacts.base.sha256, 'base WASM hash does not match artifacts.json');
  expect(sha(read('candidate.wasm')) === artifacts.candidate.sha256, 'candidate WASM hash does not match artifacts.json');
  expect(artifacts.base.bytes === read('base.wasm').length, 'base WASM byte count mismatch');
  expect(artifacts.candidate.bytes === read('candidate.wasm').length, 'candidate WASM byte count mismatch');
  expect(node.inputs?.baseSha256 === artifacts.base.sha256, 'Node base input hash mismatch');
  expect(node.inputs?.candidateSha256 === artifacts.candidate.sha256, 'Node candidate input hash mismatch');
  expect(node.codeSha256 === artifacts.candidate.sha256, 'deployed code hash does not equal candidate hash');

  expect(node.status === 'passed' && node.stage === 'complete', 'Node evidence is not a complete pass');
  expect(node.mode === 'local-configured-factory-update', 'unexpected execution mode');
  expect(node.governanceUpgradeSelf === false && node.callbackFlow === false, 'governance/callback boundary is not false');
  expect(provenance.mode === 'local-configured-factory-update', 'provenance mode mismatch');
  expect(provenance.harnessCommit === '3898440e5caa2d0351720ed990eee9f6678664b2', 'unexpected harness commit');
  expect(provenance.state?.includes('locally constructed'), 'state is not labelled locally constructed');
  expect(/1 passed; 0 failed/.test(rustResult), 'native result does not report 1 passed, 0 failed');

  const successStages = ['deploy', 'init', 'addProposal', 'update', 'approve'];
  const failureStages = ['replay', 'finalizeRetry'];
  for (const name of successStages) {
    const tx = node.transactions?.[name];
    expect(tx, `missing required-success transaction: ${name}`);
    expect(isSuccess(tx), `unexpected failure on required-success stage: ${name}`);
  }
  for (const name of failureStages) {
    const tx = node.transactions?.[name];
    expect(tx, `missing expected-failure transaction: ${name}`);
    expect(isFailure(tx), `falsely successful replay stage: ${name}`);
    expect(/ERR_[A-Z_]+/.test(errorText(tx)), `retry failure for ${name} lacks a contract error`);
  }
  expect(/ERR_PROPOSAL_NOT_READY_FOR_VOTE/.test(errorText(node.transactions.replay)), 'duplicate approval did not fail at the expected policy check');
  expect(/ERR_PROPOSAL_NOT_IN_PROGRESS/.test(errorText(node.transactions.finalizeRetry)), 'Finalize retry did not fail at the expected policy check');

  const finality = node.finality || {};
  for (const name of [...successStages, 'replay', 'finalizeRetry']) {
    const key = name === 'addProposal' ? 'add-proposal' : name === 'finalizeRetry' ? 'finalize-retry' : name;
    const entry = finality[key];
    expect(entry, `missing finality barrier: ${key}`);
    expect(Number.isFinite(entry.target) && Number.isFinite(entry.finalized), `invalid finality values: ${key}`);
    expect(entry.finalized >= entry.target, `inconsistent finality: ${key} finalized ${entry.finalized} < target ${entry.target}`);
  }

  expect(JSON.stringify(node.configBefore) === JSON.stringify(node.configAfter), 'DAO config changed across upgrade');
  expect(node.proposalBefore?.status === 'InProgress', 'pre-upgrade proposal is not InProgress');
  expect(node.proposalAfterUpgrade?.status === 'InProgress', 'proposal did not survive migration as InProgress');
  expect(node.proposalAfter?.status === 'Approved', 'proposal is not Approved after first approval');
  expect(node.proposalAfterReplay?.status === 'Approved', 'duplicate approval changed proposal status');
  expect(node.proposalAfterFinalizeRetry?.status === 'Approved', 'Finalize retry changed proposal status');
  expect(node.proposalAfter?.votes?.['test.near'] === 'Approve', 'root vote did not persist');
  expect(node.proposalAfterReplay?.votes?.['test.near'] === 'Approve', 'duplicate approval changed root vote');
  expect(node.proposalAfterFinalizeRetry?.votes?.['test.near'] === 'Approve', 'Finalize retry changed root vote');

  const oneNear = 1000000000000000000000000n;
  const recipient = node.recipient || {};
  expect(address(recipient.delta) === oneNear, 'first payment delta is not exactly 1 NEAR');
  expect(address(recipient.after) - address(recipient.before) === oneNear, 'recipient after-first balance does not prove exactly 1 NEAR');
  expect(address(recipient.afterReplay) === address(recipient.after), 'duplicate approval caused a second transfer');
  expect(address(recipient.afterFinalizeRetry) === address(recipient.after), 'Finalize retry caused a second transfer');
  expect(address(recipient.deltaTotal) === oneNear, 'total recipient delta is not exactly 1 NEAR');
  expect(node.replay?.duplicateApproval?.transactionFailed === true && node.replay?.duplicateApproval?.transactionSucceeded === false, 'duplicate approval evidence is not a rejected transaction');
  expect(node.replay?.duplicateApproval?.secondTransfer === false, 'duplicate approval evidence claims a second transfer');
  expect(node.replay?.finalizeRetry?.transactionFailed === true && node.replay?.finalizeRetry?.transactionSucceeded === false, 'Finalize retry evidence is not a rejected transaction');
  expect(node.replay?.finalizeRetry?.secondTransfer === false, 'Finalize retry evidence claims a second transfer');

  const rustStages = new Map(rust.map((row) => [row.stage, row.execution || '']));
  for (const name of ['deploy', 'init', 'add_proposal', 'update', 'approve']) {
    expect(rustStages.has(name), `native evidence missing ${name}`);
    expect(!/status: Failure/.test(rustStages.get(name)), `unexpected native failure at ${name}`);
  }
  expect(rustStages.has('replay') && /status: Failure/.test(rustStages.get('replay')), 'native duplicate approval was not rejected');
  expect(rustStages.has('finalize_retry') && /status: Failure/.test(rustStages.get('finalize_retry')), 'native Finalize retry was not rejected');
  expect(rustStages.has('complete'), 'native evidence has no complete stage');

  expect(authority.status === 'passed', 'authority negative control did not pass');
  expect(/ERR_MUST_BE_SELF_OR_FACTORY/.test(errorText(authority.denial)), 'authority negative control lacks denial error');
  expect(wrongHash.status === 'failed' && wrongHash.stage === 'inputs', 'wrong-hash control did not fail before inputs');
  expect(Object.keys(wrongHash.transactions || {}).length === 0, 'wrong-hash control unexpectedly executed transactions');
}

function selfTest() {
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sputnik-packet-'));
  try {
    fs.cpSync(root, temp, {recursive: true});
    const nodePath = path.join(temp, 'evidence', 'node-evidence.json');
    const tampered = JSON.parse(fs.readFileSync(nodePath, 'utf8'));
    tampered.recipient.deltaTotal = '2000000000000000000000000';
    fs.writeFileSync(nodePath, JSON.stringify(tampered, null, 2));
    const sumsPath = path.join(temp, 'evidence', 'SHA256SUMS');
    const lines = fs.readFileSync(sumsPath, 'utf8').trim().split('\n').map((line) => {
      const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/);
      if (match && match[2] === 'node-evidence.json') return `${sha(fs.readFileSync(nodePath))}  node-evidence.json`;
      return line;
    });
    fs.writeFileSync(sumsPath, lines.join('\n') + '\n');
    let rejected = false;
    try {
      execFileSync(process.execPath, [__filename, `--root=${temp}`], {stdio: 'pipe'});
    } catch (error) {
      rejected = true;
      const output = `${error.stdout || ''}${error.stderr || ''}`;
      expect(/total recipient delta|recipient/i.test(output), `tamper failed for an unexpected reason: ${output.slice(0, 500)}`);
    }
    expect(rejected, 'tampered evidence was accepted');
    console.log('PASS tamper self-test: changed total delta and updated checksums was rejected');
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
}

if (args.includes('--self-test')) {
  selfTest();
} else {
  try {
    verifyChecksums();
    verifySemantics();
    console.log('PASS offline consistency: checksums, artifacts, finality, required outcomes, payment delta and retry rejection');
    console.log('NOTE this verifies recorded JSON consistency, not cryptographic proof of execution; rerun the harness for execution evidence.');
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}
