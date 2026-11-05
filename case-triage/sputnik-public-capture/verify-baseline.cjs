'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashContract } = require('near-workspaces');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const capture = JSON.parse(fs.readFileSync(path.join(OUT, 'capture.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(OUT, 'baseline.json'), 'utf8'));
const fail = (m) => { throw new Error(m); };

if (!baseline.verdict || baseline.verdict !== 'capture-baseline-verified') fail('baseline verdict is not verified');
if (!baseline.import?.matches) fail('import did not match capture code/state');
if (hashContract(Buffer.from(capture.code.base64, 'base64')) !== capture.code.hash) fail('capture code hash mismatch');
if (sha256(Buffer.from(capture.code.base64, 'base64')) !== capture.code.sha256) fail('capture code sha256 mismatch');
const stateHash = sha256(JSON.stringify(capture.state.items.map(({ key, value }) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key))));
if (stateHash !== capture.state.hash) fail('capture state hash mismatch');
if (baseline.import.codeHash !== capture.code.hash || baseline.import.stateHash !== capture.state.hash) fail('import identity mismatch');
if (baseline.import.balance !== capture.account.amount) fail('exact contract balance was not preserved');
if (baseline.execution?.runtime?.version !== '2.6.2') fail('sandbox runtime is not 2.6.2');
for (const [k, v] of Object.entries(baseline.checks || {})) if (v !== true) fail(`check failed: ${k}`);
if (baseline.baseline?.proposalAfter?.status !== 'Expired') fail('proposal did not resolve as Expired');
if (baseline.baseline?.payout?.recipient !== capture.proposal.proposer) fail('payout recipient mismatch');
if (baseline.baseline?.payout?.declaredBond !== capture.policy.proposal_bond) fail('declared bond mismatch');
if (BigInt(baseline.baseline.payout.contractDeltaYocto) >= 0n) fail('contract funds did not decrease');
if (BigInt(baseline.baseline.payout.actorDeltaYocto) <= 0n) fail('actor funds did not increase');
if (baseline.retry?.stateUnchanged !== true) fail('retry mutated state');
if (baseline.unauthorized?.stateUnchanged !== true) fail('unauthorized operation mutated state');

const verdict = {
  schema: 'near-rehearsal/public-capture-verdict/v1',
  verdict: baseline.verdict,
  source: capture.sourceAccount,
  network: capture.network,
  capturedBlock: capture.block,
  code: { hash: capture.code.hash, sha256: capture.code.sha256, bytes: capture.code.bytes },
  state: { hash: capture.state.hash, bytes: capture.state.bytes, count: capture.state.count },
  contractBalanceYocto: capture.account.amount,
  proposal: { id: capture.proposal.id, proposer: capture.proposal.proposer, status: capture.proposal.status, kind: capture.proposal.kind },
  policy: { proposalBondYocto: capture.policy.proposal_bond, proposalPeriodNs: capture.policy.proposal_period },
  localRuntime: baseline.execution.runtime,
  localBlock: baseline.execution.localBlock,
  capturedBlockContext: baseline.execution.capturedBlock,
  import: baseline.import,
  actor: baseline.actor,
  operation: baseline.baseline.operation,
  payout: baseline.baseline.payout,
  retry: { failed: baseline.retry.failed, stateUnchanged: baseline.retry.stateUnchanged, failure: baseline.retry.failure },
  unauthorized: { failed: baseline.unauthorized.failed, stateUnchanged: baseline.unauthorized.stateUnchanged, failure: baseline.unauthorized.failure },
  checks: baseline.checks,
  limitations: [
    'Local Sandbox execution only; no public write, no production key, no production recovery.',
    'The contract account ID, code, raw state and contract balance were preserved; the local actor balance was synthetic and is not claimed as the captured actor balance.',
    'Local Sandbox starts at block 0 with a later wall-clock timestamp than the captured block; this is recorded, not treated as the production context.',
    'The proposal is an existing expired proposal on public testnet; the bond amount is declared by policy. The observed actor delta is net of gas/fees, not a claim of the exact gross transfer receipt.',
    'This proves capture/import/baseline feasibility for one old-layout child DAO. It does not prove candidate migration, correction, arbitrary contracts, or public recovery.',
  ],
  commands: [
    'node case-triage/sputnik-public-capture/capture.cjs',
    'node case-triage/sputnik-public-capture/run-baseline.cjs',
    'node case-triage/sputnik-public-capture/verify-baseline.cjs',
  ],
};
fs.writeFileSync(path.join(OUT, 'verdict.json'), json(verdict));
console.log(json(verdict));
