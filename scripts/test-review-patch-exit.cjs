'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {exitCodeForStatus} = require('./review-patch.cjs');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-exit-'));
try {
  const cli = path.join(__dirname, 'review-patch.cjs');
  const help = spawnSync(process.execPath, [cli, '--help'], {encoding:'utf8'});
  assert.equal(help.status, 0);
  const bad = spawnSync(process.execPath, [cli, '--patch', path.join(root,'test-fixtures/review-patch/no-fix.patch'), '--source', path.join(temp,'missing-source'), '--out', path.join(temp,'result')], {encoding:'utf8', timeout:30000});
  assert.equal(bad.status, 3, bad.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp,'result/review-status.json'))).status, 'INPUT_ERROR');
  assert(fs.existsSync(path.join(temp,'result/review-report.md')), 'failed review evidence retained');
  const args = spawnSync(process.execPath, [cli, '--not-an-option'], {encoding:'utf8'});
  assert.equal(args.status, 1);
  for (const [status, code] of Object.entries({ACCEPTED:0,REJECTED:2,INPUT_ERROR:3,BUILD_ERROR:4,INCONCLUSIVE:5})) assert.equal(exitCodeForStatus(status), code);
  assert.equal(exitCodeForStatus('unknown'),1);
  console.log('review CLI: INPUT_ERROR exits nonzero and retains reports; help and status mapping checked');
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
