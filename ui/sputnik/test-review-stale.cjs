'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class ClassList {
  constructor() { this.values = new Set(); }
  toggle(name, force) { if (force === undefined ? !this.values.has(name) : force) this.values.add(name); else this.values.delete(name); }
  contains(name) { return this.values.has(name); }
}
class Element {
  constructor(id) { this.id = id; this.dataset = {}; this.classList = new ClassList(); this.attributes = {}; this.listeners = {}; this.children = []; this.textContent = ''; this.hidden = false; this.className = ''; this.disabled = false; this._html = ''; }
  set innerHTML(value) {
    this._html = String(value);
    this.children = [];
    for (const match of this._html.matchAll(/data-run="([^"]+)"/g)) {
      const child = new Element(`history-${match[1]}`);
      child.dataset.run = match[1];
      this.children.push(child);
    }
  }
  get innerHTML() { return this._html; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  querySelectorAll(selector) { return selector === '[data-run]' ? this.children : []; }
  click() { for (const listener of this.listeners.click || []) listener({currentTarget: this}); }
  focus() { document.activeElement = this; }
}
const elements = new Map();
const get = (id) => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
const timers = [];
const document = {activeElement: null, getElementById: get, querySelectorAll: () => []};
const now = new Date().toISOString();
const run1 = {id: 'run-1', status: 'running', phase: 'replaying', startedAt: now, elapsedMs: 1000, mode: 'recorded-wasm', logs: []};
const run2 = {
  id: 'run-2', status: 'accepted', phase: 'accepted', startedAt: now, finishedAt: now, elapsedMs: 2000, mode: 'recorded-wasm',
  bundle: {sha256: 'd'.repeat(64)}, downloadUrl: '/download', inputUrl: '/input', evidenceUrl: '/evidence',
  result: {
    schema: 'near-rehearsal/review-browser-result/v1', createdAt: now,
    bundle: {sha256: 'd'.repeat(64), candidate: {wasmSha256: 'e'.repeat(64)}},
    run: {mode: 'recorded-wasm', modeLabel: 'STALE TEST run-2'},
    summary: {
      mode: 'recorded-wasm', modeLabel: 'STALE TEST run-2', candidateWasmSha256: 'e'.repeat(64), frozenOldCodeFailure: true,
      firstRecovery: {gross: '1 NEAR', gas: '0.0007 NEAR', proposerNet: '0.9993 NEAR', contractDelta: '-1 NEAR'},
      retry: {gross: '0 NEAR', gas: '0.0006 NEAR', proposerNet: '-0.0006 NEAR'},
      checks: {preservedState: true, preservedPolicy: true, preservedProposal: true, authorityRejected: true, healthyControl: true, pendingHealthy: true, accepted: true},
    },
  },
};
let delayRun1 = false;
let pendingRun1 = null;
const fetch = async (url) => {
  if (url === '/api/review/config') return {ok: true, json: async () => ({
    configured: true, defaultMode: 'recorded-wasm',
    modes: {'recorded-wasm': {configured: true, missing: []}, 'source-build': {configured: false, missing: ['REPAIR_SOURCE_DIR']}},
  })};
  if (url === '/api/review/runs') return {ok: true, json: async () => ({runs: [{id: 'run-1', status: 'running', mode: 'recorded-wasm'}, {id: 'run-2', status: 'accepted', mode: 'recorded-wasm'}], active: 'run-1'})};
  if (url === '/api/review/runs/run-1') {
    if (delayRun1 && !pendingRun1) return new Promise((resolve) => { pendingRun1 = resolve; });
    return {ok: true, json: async () => run1};
  }
  if (url === '/api/review/runs/run-2') return {ok: true, json: async () => run2};
  return {ok: false, json: async () => ({error: 'unexpected'})};
};
const context = {
  console, document, fetch,
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  clearTimeout: () => {},
  TextEncoder, crypto: {subtle: {digest: async () => new ArrayBuffer(32)}},
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public/review.js'), 'utf8'), context, {filename: 'review.js'});
const tick = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  await tick(); await tick(); await tick();
  assert.ok(timers.length > 0, 'refresh restores polling');
  delayRun1 = true;
  timers.shift()();
  await tick();
  const run2Button = get('history-list').children.find((child) => child.dataset.run === 'run-2');
  assert.ok(run2Button, 'second history item is addressable');
  run2Button.click();
  await tick(); await tick(); await tick();
  assert.equal(get('result-state').hidden, false, 'selected accepted result is rendered');
  assert.match(get('result-json').textContent, /run-2/, 'selected result is run-2');
  pendingRun1({ok: true, json: async () => run1});
  await tick(); await tick();
  assert.equal(get('result-state').hidden, false, 'late run-1 response did not replace run-2');
  assert.match(get('result-json').textContent, /run-2/, 'late run-1 response stayed inert');
  console.log('review-stale: a late response from the previous run cannot replace the selected result');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
