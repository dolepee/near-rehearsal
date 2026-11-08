'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname);
const html = fs.readFileSync(path.join(root, 'public', 'review.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'review.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.cjs'), 'utf8');

for (const id of ['bundle-file', 'example-button', 'run-button', 'history-list', 'result-state', 'downloads', 'status']) {
  assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
}
assert.match(html, /Recorded WASM replay/);
assert.match(html, /Local evidence only/);
assert.match(js, /\/api\/review\/runs/);
assert.match(js, /downloadUrl/);
assert.match(js, /No bundle selected/);
assert.match(server, /\/api\/review\/example/);
assert.match(server, /\/api\/review\/runs/);
assert.match(server, /\/download/);
assert.match(server, /input/);
assert.match(server, /evidence/);
assert.match(js, /esc\(/);
assert.match(js, /textContent/);
console.log('review-ui: surface, route and download controls present');
