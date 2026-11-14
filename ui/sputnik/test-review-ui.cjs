'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname);
const html = fs.readFileSync(path.join(root, 'public', 'review.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'review.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.cjs'), 'utf8');

for (const id of ['bundle-file', 'example-button', 'run-button', 'history-list', 'result-state', 'downloads', 'status', 'mode-source', 'mode-recorded', 'mode-source-status', 'mode-recorded-status', 'same-dao-panel', 'same-dao-badge', 'same-dao-copy', 'same-dao-list']) {
  assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
}
assert.match(html, /Source build/);
assert.match(html, /Recorded WASM replay/);
assert.match(html, /accepted handoff/);
assert.match(html, /Local evidence only/);
assert.match(html, /id="money-grid"/);
assert.match(html, /id="identity-details"/);
assert.match(html, /Technical identity and mode/);
assert.match(js, /\/api\/review\/runs/);
assert.match(js, /downloadUrl/);
assert.match(js, /No bundle selected/);
assert.match(js, /Frozen bond/);
assert.match(js, /verifiedHealthy\.settledTransfer/);
assert.match(js, /Measured settled Transfer/);
assert.doesNotMatch(js, /obligation\.transferNear/, 'the money card never trusts supplied case metadata');
assert.match(js, /extra principal/);
assert.match(js, /Source revision/);
assert.match(js, /Candidate patch/);
assert.match(js, /schedulePoll/);
assert.match(js, /Fresh replay completed/);
assert.match(js, /Recorded evidence opened/);
assert.match(js, /same-dao/);
assert.match(js, /producer/);
assert.match(html, /Compiler boundary/);
assert.doesNotMatch(html, /can read host files and credentials/);
assert.match(server, /\/api\/review\/example/);
assert.match(server, /\/api\/review\/runs/);
assert.match(server, /\/download/);
assert.match(server, /input/);
assert.match(server, /evidence/);
assert.match(js, /esc\(/);
assert.match(js, /textContent/);
console.log('review-ui: surface, route and download controls present');
