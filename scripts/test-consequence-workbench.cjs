'use strict';
/*
 * Data-integrity checks for the static #238/#226 consequence workbench.
 * These assertions bind the visible decision to the reviewed reports and
 * copied artifacts; they do not mirror the HTML.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {assertCaseFiles, bindReportIdentity, OUT, shaFile} = require('./build-consequence-workbench.cjs');
const {verifyPacket} = require('../case-triage/sputnik-226/review-packet/packet-model.cjs');
const {validateRepairCandidate, validateUpgrade, bindCandidateSwitch} = require('../ui/sputnik/public/consequences/model.js');

const SHA = (value) => crypto.createHash('sha256').update(value).digest('hex');
const data = JSON.parse(fs.readFileSync(path.join(OUT, 'cases.json'), 'utf8'));
const page = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
assert.match(page, /Run locally \/ setup/);
assert.doesNotMatch(page, />Back to local Rehearsal</);
assert.match(page, /<base href="\/consequences\/">/);
const repair = data.cases['238'];
const upgrade = data.cases['226'];

assert.equal(data.schema, 'near-rehearsal/consequence-workbench/v1');
assert.equal(data.label, 'Recorded execution');
assert.deepEqual(repair.candidates.map((candidate) => candidate.id), ['clear-all', 'intended']);
assert.equal(repair.candidates[0].status, 'REJECTED');
assert.equal(repair.candidates[1].status, 'ACCEPTED');
assert.ok(repair.candidates[0].errors.length > 0, 'bad repair must carry the actual policy errors');

const locked = (candidate) => candidate.stages.map((stage) => stage.locked);
assert.deepEqual(locked(repair.candidates[0]), [
  '2000000000000000000000000',
  '2000000000000000000000000',
  '0',
  '0',
  '0',
  '0',
  '0',
]);
assert.deepEqual(locked(repair.candidates[1]), [
  '2000000000000000000000000',
  '2000000000000000000000000',
  '1000000000000000000000000',
  '1000000000000000000000000',
  '0',
  '0',
  '0',
]);
assert.equal(repair.baseline.stages[0].locked, '2000000000000000000000000');

for (const candidate of repair.candidates) {
  assert.equal(candidate.cash.bobTransfer, '100000000000000000000000', `${candidate.id} Bob transfer`);
  assert.equal(candidate.cash.bobBondReturned, '1000000000000000000000000', `${candidate.id} Bob bond`);
  assert.equal(candidate.cash.aliceContractDelta, '-1000000000000000000000000', `${candidate.id} Alice contract debit`);
}
assert.equal(repair.candidates[0].cash.aliceContractDelta, repair.candidates[1].cash.aliceContractDelta);
assert.equal(repair.candidates[0].outcomes.bobPaidExactlyOnce, false);
assert.equal(repair.candidates[1].outcomes.bobPaidExactlyOnce, true);
for (const candidate of repair.candidates) assert.equal(validateRepairCandidate(candidate).ok, true, `${candidate.id} integrity`);
const unknownStatus = JSON.parse(JSON.stringify(repair.candidates[0]));
unknownStatus.status = 'INCONCLUSIVE';
assert.equal(validateRepairCandidate(unknownStatus).ok, false, 'unknown status must fail closed');
const missingStatus = JSON.parse(JSON.stringify(repair.candidates[0]));
delete missingStatus.status;
assert.equal(validateRepairCandidate(missingStatus).ok, false, 'missing status must fail closed');
const contradictoryAccepted = JSON.parse(JSON.stringify(repair.candidates[1]));
contradictoryAccepted.errors.push('tampered');
assert.equal(validateRepairCandidate(contradictoryAccepted).ok, false, 'accepted status with errors must fail closed');
const badLedger = JSON.parse(JSON.stringify(repair.candidates[1]));
badLedger.stages[2].locked = '0';
assert.equal(validateRepairCandidate(badLedger).ok, false, 'accepted status with a rejected ledger must fail closed');
const badCash = JSON.parse(JSON.stringify(repair.candidates[1]));
badCash.cash.aliceBondGross = '0';
badCash.cash.aliceGas = '-100';
badCash.cash.aliceBondNet = '3000000000000000000000000';
assert.equal(validateRepairCandidate(badCash).ok, false, 'inconsistent gross/net/gas must fail closed');
assert.equal(validateUpgrade(upgrade).ok, true, '#226 integrity');
const badUpgrade = JSON.parse(JSON.stringify(upgrade));
badUpgrade.status = 'INCONCLUSIVE';
assert.equal(validateUpgrade(badUpgrade).ok, false, 'unknown #226 status must fail closed');
const missingUpgradeStage = JSON.parse(JSON.stringify(upgrade));
missingUpgradeStage.stages.pop();
assert.equal(validateUpgrade(missingUpgradeStage).ok, false, 'missing #226 stage must fail closed');
const badUpgradeResult = JSON.parse(JSON.stringify(upgrade));
badUpgradeResult.stages[5].result = 'success';
assert.equal(validateUpgrade(badUpgradeResult).ok, false, 'successful retry must fail closed');
const missingUpgradeResult = JSON.parse(JSON.stringify(upgrade));
delete missingUpgradeResult.stages[4].result;
assert.equal(validateUpgrade(missingUpgradeResult).ok, false, 'missing prerequisite result must fail closed');

const fakeRoot = {
  handlers: [],
  addEventListener(type, handler) { this.handlers.push({type, handler}); },
  contains() { return true; },
};
let toggled;
assert.equal(bindCandidateSwitch(fakeRoot, (id) => { toggled = id; }), true);
assert.equal(bindCandidateSwitch(fakeRoot, () => { throw new Error('duplicate binding'); }), true);
assert.equal(fakeRoot.handlers.length, 1, 'candidate switch binds once');
const intendedButton = {dataset: {candidate: 'intended'}};
const clearButton = {dataset: {candidate: 'clear-all'}};
fakeRoot.handlers[0].handler({target: {closest: () => intendedButton}});
assert.equal(toggled, 'intended');
fakeRoot.handlers[0].handler({target: {closest: () => clearButton}});
assert.equal(toggled, 'clear-all', 'repeated candidate selection after a re-render');

assert.equal(upgrade.runtime.version, '2.6.2');
assert.equal(upgrade.source.pr, 226);
assert.equal(upgrade.source.baseCommit, 'a9a9ed1019d517b519ca214592388e7fdbf13ea5');
assert.equal(upgrade.source.candidateCommit, '8112278fc2874a3abc12fb056b2d4c97ff796431');
assert.equal(upgrade.result.firstPaymentNear, '1');
assert.equal(upgrade.result.totalDeltaNear, '1');
assert.equal(upgrade.result.retries.length, 2);
assert.equal(upgrade.result.retries[0].status, 'rejected');
assert.equal(upgrade.result.retries[1].status, 'rejected');
assert.ok(upgrade.checks.nodePassed && upgrade.checks.nativePassed);
assert.equal(upgrade.stages.length, 7);

for (const candidate of repair.candidates) {
  assert.equal(shaFile(path.resolve(OUT, candidate.candidate.wasm.path)), candidate.candidate.wasm.sha256);
  assert.equal(candidate.cash.aliceBondGross, '1000000000000000000000000');
  assert.ok(candidate.cash.aliceGas !== '0', `${candidate.id} gas is measured`);
  assert.equal(BigInt(candidate.cash.aliceBondGross) - BigInt(candidate.cash.aliceGas), BigInt(candidate.cash.aliceBondNet));
  if (candidate.candidate.patch) assert.equal(shaFile(path.resolve(OUT, candidate.candidate.patch.path)), candidate.candidate.patch.sha256);
}
assert.doesNotMatch(JSON.stringify(data), /\/workspace\/|\/Users\/|C:\\/);

const candidateManifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../case-triage/rehearsal-repair/mixed-candidates/manifest.json'), 'utf8'));
const intendedReport = JSON.parse(fs.readFileSync(path.join(__dirname, '../case-triage/rehearsal-repair/out/mixed-obligation-intended.json'), 'utf8'));
assert.doesNotThrow(() => bindReportIdentity(intendedReport, candidateManifest, 'intended', repair.candidates[1].candidate.wasm, repair.candidates[1].candidate.patch));
const zeroCandidate = JSON.parse(JSON.stringify(intendedReport));
zeroCandidate.candidate.wasmSha256 = '0'.repeat(64);
assert.throws(() => bindReportIdentity(zeroCandidate, candidateManifest, 'intended', repair.candidates[1].candidate.wasm, repair.candidates[1].candidate.patch), /report WASM|identity/);
const swappedCandidate = JSON.parse(JSON.stringify(intendedReport));
swappedCandidate.candidate.wasmSha256 = candidateManifest.candidates['clear-all'].wasmSha256;
assert.throws(() => bindReportIdentity(swappedCandidate, candidateManifest, 'intended', repair.candidates[1].candidate.wasm, repair.candidates[1].candidate.patch), /does not match the manifest/);
const swappedBase = JSON.parse(JSON.stringify(intendedReport));
swappedBase.source.baseWasmSha256 = candidateManifest.candidates['clear-all'].wasmSha256;
assert.throws(() => bindReportIdentity(swappedBase, candidateManifest, 'intended', repair.candidates[1].candidate.wasm, repair.candidates[1].candidate.patch), /base WASM/);

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../case-triage/sputnik-226/manifest.json'), 'utf8'));
assert.match(manifest.status, /verified-local-recorded-case/);
assert.equal(manifest.recordedVerification.nativePassed, true);
assert.equal(manifest.recordedVerification.firstPaymentNear, '1');
assert.equal(manifest.artifacts.base.sha256, 'd1269a7be654211172cde60bccfa05a76996a3163b55abaeb58737f8661aaebf');
assert.equal(manifest.artifacts.candidate.sha256, '088c69b79aaf6c7b2d8196348c65f66f44a773f05e1f350120a78579f594daf3');
assert.ok(Array.isArray(manifest.historicalBlockers) && manifest.historicalBlockers.length > 0, 'historical blockers preserved');
assert.doesNotMatch(manifest.status, /rerun-pending/);
const readme226 = fs.readFileSync(path.join(__dirname, '../case-triage/sputnik-226/README.md'), 'utf8');
assert.match(readme226, /Local listener prerequisite/);
assert.doesNotMatch(readme226, /execution is being re-run/);

const copiedPacket = path.join(OUT, 'downloads/226');
verifyPacket(copiedPacket);
for (const entry of fs.readdirSync(path.join(copiedPacket, 'evidence'))) {
  if (entry === 'SHA256SUMS') continue;
  assert.ok(fs.existsSync(path.join(copiedPacket, 'evidence', entry)), `copied packet file ${entry}`);
}

const zipList = spawnSync('unzip', ['-Z1', path.join(OUT, repair.downloads.evidence.path)], {encoding: 'utf8'});
assert.equal(zipList.status, 0, zipList.stderr);
for (const required of ['238/README.md', '238/clear-all.patch', '238/clear-all.wasm', '238/intended.patch', '238/intended.wasm', '238/mixed-obligation-clear-all.json', '238/mixed-obligation-intended.json']) {
  assert.match(zipList.stdout, new RegExp(`(^|\\n)${required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\n|$)`), `zip contains ${required}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'consequence-integrity-'));
try {
  fs.mkdirSync(path.join(tmp, 'downloads/238'), {recursive: true});
  fs.copyFileSync(path.join(OUT, 'downloads/238/clear-all.patch'), path.join(tmp, 'downloads/238/clear-all.patch'));
  fs.writeFileSync(path.join(tmp, 'downloads/238/clear-all.patch'), 'tampered\n');
  assert.throws(() => assertCaseFiles(data, tmp), /hash mismatch|missing/, 'tampered evidence must fail closed');
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}

console.log('consequence-workbench: decisions, ledger, hashes, packet and downloads verified');
