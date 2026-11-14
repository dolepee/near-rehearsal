'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {buildReviewBundle} = require('./review-bundle.cjs');

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[index + 1]]);
  return pairs;
}, []));
for (const key of ['review-dir', 'patch', 'out']) if (!args[key]) throw new Error(`--${key} is required`);
const root = path.resolve(args['review-dir']);
const pick = (...parts) => path.join(root, ...parts);
const bundle = buildReviewBundle({
  runId: args['run-id'] || `primary-${Date.now()}`,
  patchPath: path.resolve(args.patch),
  wasmPath: pick('pipeline', 'applied', 'target', 'wasm32-unknown-unknown', 'release', 'sputnikdao2.wasm'),
  candidateIdentityPath: pick('pipeline', 'candidate-identity.json'),
  baseReportPath: path.resolve('case-triage/rehearsal-repair/out/issue238-local.json'),
  candidateReportPath: pick('pipeline', 'replay', 'issue238-local.json'),
  recoveryPath: pick('persisted', 'persisted-recovery.json'),
  acceptancePath: pick('persisted', 'persisted-recovery-acceptance.json'),
  mixedPath: pick('evidence', 'mixed-obligation.json'),
  settlementPath: pick('evidence', 'settlement-refund.json'),
  policy: JSON.parse(fs.readFileSync(pick('review-status.json'), 'utf8')).policy || null,
});
fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(bundle, null, 2)}\n`);
console.log(args.out);
