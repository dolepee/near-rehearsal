'use strict';
/*
 * Browser-logic regression for the upload picker. It evaluates the real app.js
 * against a small DOM shim and verifies that a cancelled, invalid or in-flight
 * upload never leaves the previous artifact selectable.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

class Element {
  constructor(id) {
    this.id = id;
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.files = [];
    this.textContent = '';
    this.innerHTML = '';
    this.className = '';
    this.dataset = {};
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
  click() { this.clicked = true; }
  scrollTo() {}
}
const ids = [
  'candidate-choice', 'candidate-file', 'candidate-meta',
  'correction-choice', 'correction-file', 'correction-meta',
  'run-button', 'rerun-button', 'export-button', 'status',
  'empty-state', 'running-state', 'error-state', 'result-state',
  'error-copy', 'error-log', 'family-label', 'run-id', 'elapsed', 'logs',
  'running-title', 'running-copy', 'result-banner', 'frozen-summary',
  'obligation-strip', 'branch-grid', 'detail-label', 'detail-panel',
];
const elements = Object.fromEntries(ids.map((id) => [id, new Element(id)]));
const document = {
  getElementById: (id) => elements[id] || new Element(id),
  querySelectorAll: () => [],
};
const supported = {
  family: 'sputnik-dao-v2', label: 'test family',
  artifacts: {
    candidate: { sha256: 'a'.repeat(64), label: 'candidate', roles: ['candidate'] },
    corrected: { sha256: 'b'.repeat(64), label: 'correction', roles: ['correction'] },
  },
};
const context = {
  document,
  window: {},
  location: { search: '' },
  URLSearchParams,
  fetch: async () => ({ ok: true, json: async () => supported }),
  crypto: require('node:crypto').webcrypto,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8'), context, { filename: 'app.js' });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await tick();
  assert.equal(elements['run-button'].disabled, false, 'manifest selections should enable Run');
  assert.match(elements['candidate-meta'].innerHTML, /candidate/);

  // Opening the upload picker clears the prior selection immediately.
  elements['candidate-choice'].value = 'upload';
  elements['candidate-choice'].dispatch('change', { target: elements['candidate-choice'] });
  assert.equal(elements['run-button'].disabled, true, 'Run must be disabled while upload is unverified');
  assert.match(elements['candidate-meta'].textContent, /Choose a candidate WASM file/);
  assert.equal(elements['candidate-file'].hidden, false);

  // A cancelled picker leaves the cleared state.
  elements['candidate-file'].dispatch('change', { target: { files: [] } });
  await tick();
  assert.equal(elements['run-button'].disabled, true, 'cancelled upload must not restore old artifact');
  assert.match(elements['candidate-meta'].textContent, /No candidate file selected/);

  // A valid file re-enables submission after hashing.
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  elements['candidate-file'].files = [{ name: 'candidate.wasm', arrayBuffer: async () => bytes.buffer }];
  elements['candidate-file'].dispatch('change', { target: elements['candidate-file'] });
  await tick();
  assert.equal(elements['run-button'].disabled, false, 'valid hashed upload should enable Run');
  assert.match(elements['candidate-meta'].innerHTML, /candidate\.wasm/);

  // Invalid replacement clears the valid selection.
  elements['candidate-choice'].value = 'upload';
  elements['candidate-choice'].dispatch('change', { target: elements['candidate-choice'] });
  elements['candidate-file'].files = [{ name: 'empty.wasm', arrayBuffer: async () => new ArrayBuffer(0) }];
  elements['candidate-file'].dispatch('change', { target: elements['candidate-file'] });
  await tick();
  assert.equal(elements['run-button'].disabled, true, 'invalid upload must not leave a usable artifact');
  assert.match(elements['candidate-meta'].textContent, /between 1 byte and 2 MB/);

  console.log(JSON.stringify({
    schema: 'near-rehearsal/sputnik-ui-upload-regression/v1',
    cases: ['initial-manifest', 'picker-clears-selection', 'cancel-keeps-cleared', 'valid-hash-enables-run', 'invalid-file-clears-selection'],
    passed: true,
  }, null, 2));
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
