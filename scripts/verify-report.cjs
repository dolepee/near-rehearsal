'use strict';
const fs = require('node:fs');
const path = require('node:path');
const report = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out', 'report.json'), 'utf8'));
const checks = {
  sameStartingState: report.result.sameStartingState === true,
  regressionObserved: report.result.regressionObserved === true,
  correctionObserved: report.result.correctionObserved === true,
  baselineMatchesExpected: report.branches.baseline.operation.value === report.result.expectedAfterOneMore,
  fixedMatchesExpected: report.branches.fixed.operation.value === report.result.expectedAfterOneMore,
  buggyFailed: report.branches.buggy.operation.succeeded === false && report.branches.buggy.operation.structuredFailure === true && report.branches.buggy.operation.inconclusive !== true,
  seededLabelPresent: report.branches.buggy.seeded === true && /SEEDED/i.test(report.branches.buggy.label),
};
console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((v) => !v)) process.exit(1);
