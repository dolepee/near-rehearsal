'use strict';
/*
 * Offline consistency verifier for the Sputnik #226 review packet.
 *
 * Checks the recorded evidence against its checksum manifest, receipt graph,
 * actor/contract context, finality order, payment invariant, and a canonical
 * derivation of every displayed packet fact. It does not prove execution; a
 * rerun is the execution check.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const {verifyPacket} = require('./packet-model.cjs');

const here = __dirname;
const args = process.argv.slice(2);
const rootArg = args.find((arg) => arg.startsWith('--root='));
const root = path.resolve(rootArg ? rootArg.split('=')[1] : here);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const expect = (condition, message) => { if (!condition) throw new Error(message); };

function updateNodeChecksum(temp) {
  const sumsPath = path.join(temp, 'evidence', 'SHA256SUMS');
  const nodePath = path.join(temp, 'evidence', 'node-evidence.json');
  const lines = fs.readFileSync(sumsPath, 'utf8').trim().split('\n').map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/);
    if (match && match[2] === 'node-evidence.json') return `${sha(fs.readFileSync(nodePath))}  node-evidence.json`;
    return line;
  });
  fs.writeFileSync(sumsPath, lines.join('\n') + '\n');
}

function runTamper(name, mutate, pattern, {packet = false} = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sputnik-packet-'));
  try {
    fs.cpSync(root, temp, {recursive: true});
    if (packet) {
      const packetPath = path.join(temp, 'data', 'packet.json');
      const value = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
      mutate(value);
      fs.writeFileSync(packetPath, JSON.stringify(value, null, 2));
    } else {
      const nodePath = path.join(temp, 'evidence', 'node-evidence.json');
      const value = JSON.parse(fs.readFileSync(nodePath, 'utf8'));
      mutate(value);
      fs.writeFileSync(nodePath, JSON.stringify(value, null, 2));
      updateNodeChecksum(temp);
    }
    let rejected = false;
    try {
      execFileSync(process.execPath, [__filename, `--root=${temp}`], {stdio: 'pipe'});
    } catch (error) {
      rejected = true;
      const output = `${error.stdout || ''}${error.stderr || ''}`;
      expect(pattern.test(output), `${name} was rejected for an unexpected reason: ${output.slice(0, 500)}`);
    }
    expect(rejected, `${name} was accepted`);
    console.log(`PASS tamper: ${name}`);
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
}

function selfTest() {
  runTamper('required-success child receipt changed to failure', (node) => {
    const receipt = node.transactions.approve.receipts_outcome[0];
    receipt.outcome.status = {Failure: {ActionError: {index: 0, kind: {FunctionCallError: {ExecutionError: 'tampered'}}}}};
  }, /child receipt|required-success/i);

  runTamper('recipient account unbound from proposal receiver', (node) => {
    node.recipient.accountId = 'unrelated.test.near';
  }, /recipient|beneficiary|proposal receiver|executor/i);

  runTamper('all finality targets zeroed', (node) => {
    for (const entry of Object.values(node.finality)) {
      entry.target = 0;
      entry.finalized = 0;
    }
  }, /finality target|finalized height|finality/i);

  runTamper('displayed NEAR amount altered in packet JSON', (packet) => {
    packet.result.recipientAfterFirst = '999';
  }, /displayed packet facts|canonical evidence/i, {packet: true});

  runTamper('recorded total delta altered', (node) => {
    node.recipient.deltaTotal = '2000000000000000000000000';
  }, /total recipient delta|delta/i);
}

if (args.includes('--self-test')) {
  selfTest();
} else {
  try {
    verifyPacket(root);
    console.log('PASS offline consistency: checksums, receipt graph/actors, finality, required outcomes, payment delta, retry rejection, and canonical display');
    console.log('NOTE this verifies recorded JSON consistency, not cryptographic proof of execution; rerun the harness for execution evidence.');
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}
