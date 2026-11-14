'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {buildReviewBundle} = require('./review-bundle.cjs');
const {checkBundle} = require('../../scripts/repair-review.cjs');

const here = __dirname;
const source = {
  patchPath: path.join(here, 'generated/e8262f5a/repair.patch'),
  wasmPath: path.join(here, 'generated/e8262f5a/candidate.wasm'),
  candidateIdentityPath: path.join(here, 'generated/e8262f5a/candidate-identity.json'),
  baseReportPath: path.join(here, 'out/issue238-local.json'),
  candidateReportPath: path.join(here, 'out/issue238-repaired.json'),
  recoveryPath: path.join(here, 'out/persisted-recovery.json'),
  acceptancePath: path.join(here, 'out/persisted-recovery-acceptance.json'),
};
const historicalIdentity = JSON.parse(fs.readFileSync(source.candidateIdentityPath, 'utf8'));
assert.throws(() => buildReviewBundle({runId: 'historical-crossed', ...source}), /fresh report bound to a different candidate/);
const matchingReport = path.join('/tmp', `matching-fresh-${process.pid}.json`);
const matching = JSON.parse(fs.readFileSync(source.candidateReportPath, 'utf8'));
matching.source.wasmSha256 = historicalIdentity.wasm.sha256;
fs.writeFileSync(matchingReport, JSON.stringify(matching));
const bundle = buildReviewBundle({runId: 'fixture-review-bridge', ...source, candidateReportPath: matchingReport});
fs.rmSync(matchingReport, {force: true});
checkBundle(bundle);
assert.equal(bundle.schema, 'near-rehearsal/repair-review-bundle/v1');
assert.equal(bundle.candidate.identityText, fs.readFileSync(source.candidateIdentityPath, 'utf8'));

const crossedReport = path.join('/tmp', `crossed-fresh-${process.pid}.json`);
const crossed = JSON.parse(fs.readFileSync(source.candidateReportPath, 'utf8'));
crossed.source.wasmSha256 = '0'.repeat(64);
fs.writeFileSync(crossedReport, JSON.stringify(crossed));
assert.throws(() => buildReviewBundle({runId: 'crossed', ...source, candidateReportPath: crossedReport}), /fresh report bound to a different candidate/);
fs.rmSync(crossedReport, {force: true});

const badAcceptance = path.join('/tmp', `bad-acceptance-${process.pid}.json`);
fs.writeFileSync(badAcceptance, JSON.stringify({ok: false}));
assert.throws(() => buildReviewBundle({runId: 'bad', ...source, acceptancePath: badAcceptance}), /without passing persisted acceptance/);
fs.rmSync(badAcceptance, {force: true});

const tampered = JSON.parse(JSON.stringify(bundle));
tampered.candidate.wasm.sha256 = '0'.repeat(64);
assert.throws(() => checkBundle(tampered), /WASM hash/);
console.log('review-bundle: patch/report/identity bridge validates against the existing reviewer schema');
