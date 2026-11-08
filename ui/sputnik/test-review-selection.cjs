'use strict';
/*
 * Selection and startup races: a slow bundle read must never publish over a
 * newer choice or leave Run bound to the previous candidate, and delayed
 * startup restoration must never replace a reviewer's explicit navigation.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeClassList {
  constructor() { this.values = new Set(); }
  toggle(name, force) {
    if (force === undefined ? !this.values.has(name) : force) this.values.add(name);
    else this.values.delete(name);
  }
  contains(name) { return this.values.has(name); }
}
class FakeElement {
  constructor(id) {
    this.id = id; this.dataset = {}; this.classList = new FakeClassList(); this.attributes = {};
    this.listeners = {}; this.textContent = ''; this.hidden = false; this.className = '';
    this.innerHTML = ''; this.disabled = false; this.children = []; this.files = [];
  }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  focus() { document.activeElement = this; }
  querySelectorAll(selector) { return selector === '[data-run]' ? this.children : []; }
  click() { for (const listener of this.listeners.click || []) listener({currentTarget: this}); }
  set html(value) { this.innerHTML = String(value); }
  get html() { return this.innerHTML; }
}
const elements = new Map();
const get = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement(id));
  return elements.get(id);
};
/* History buttons are re-created from innerHTML, so mirror the DOM nodes the
 * file builds for [data-run]. */
const historyList = get('history-list');
let historyHtml = '';
Object.defineProperty(historyList, 'innerHTML', {
  get: () => historyHtml,
  set: (value) => {
    historyHtml = String(value);
    historyList.children = [];
    for (const match of historyHtml.matchAll(/data-run="([^"]+)"/g)) {
      const child = new FakeElement(`history-${match[1]}`);
      child.dataset.run = match[1];
      historyList.children.push(child);
    }
  },
});

const timers = [];
const document = {activeElement: null, getElementById: get, querySelectorAll: () => []};
const now = new Date().toISOString();
const bundle = (label) => ({
  runId: `run-${label}`, caseId: 'sputnik-238-async-bond',
  source: {commit: label.repeat(40).slice(0, 40), repository: 'x', path: 'y'},
  candidate: {wasm: {sha256: label.repeat(64).slice(0, 64)}},
});
const acceptedRun = {
  id: 'run-2', status: 'accepted', phase: 'accepted', startedAt: now, finishedAt: now, elapsedMs: 2000, mode: 'recorded-wasm',
  bundle: {sha256: 'd'.repeat(64)}, downloadUrl: '/download', inputUrl: '/input', evidenceUrl: '/evidence',
  result: {
    schema: 'near-rehearsal/review-browser-result/v1', createdAt: now,
    bundle: {sha256: 'd'.repeat(64), candidate: {wasmSha256: 'e'.repeat(64)}},
    run: {mode: 'recorded-wasm', modeLabel: 'SELECTION TEST run-2'},
    summary: {
      mode: 'recorded-wasm', modeLabel: 'SELECTION TEST run-2', candidateWasmSha256: 'e'.repeat(64), frozenOldCodeFailure: true,
      firstRecovery: {gross: '1 NEAR', gas: '0.0007 NEAR', proposerNet: '0.9993 NEAR', contractDelta: '-1 NEAR'},
      retry: {gross: '0 NEAR', gas: '0.0006 NEAR', proposerNet: '-0.0006 NEAR'},
      checks: {preservedState: true, preservedPolicy: true, preservedProposal: true, authorityRejected: true, healthyControl: true, pendingHealthy: true, accepted: true},
    },
  },
};
const runningRun = {id: 'run-1', status: 'running', phase: 'replaying', startedAt: now, elapsedMs: 1000, mode: 'recorded-wasm', logs: []};

let runsCalls = 0;
let pendingRestore = null;
let pendingExample = null;
const fetch = async (url) => {
  if (url === '/api/review/config') {
    return {ok: true, json: async () => ({
      configured: true, defaultMode: 'recorded-wasm',
      modes: {'recorded-wasm': {configured: true, missing: []}, 'source-build': {configured: false, missing: ['REPAIR_SOURCE_DIR']}},
    })};
  }
  if (url === '/api/review/runs') {
    runsCalls += 1;
    // Call 1 is the initial history render; call 2 is the delayed startup
    // restoration of the previously latest run.
    if (runsCalls === 2) return new Promise((resolve) => { pendingRestore = resolve; });
    return {ok: true, json: async () => ({
      runs: [{id: 'run-1', status: 'running', mode: 'recorded-wasm'}, {id: 'run-2', status: 'accepted', mode: 'recorded-wasm'}],
      active: 'run-1',
    })};
  }
  if (url === '/api/review/runs/run-1') return {ok: true, json: async () => runningRun};
  if (url === '/api/review/runs/run-2') return {ok: true, json: async () => acceptedRun};
  if (url === '/api/review/example') {
    return new Promise((resolve) => {
      pendingExample = () => resolve({ok: true, json: async () => ({bundle: bundle('q'), sha256: 'f'.repeat(64), filename: 'example.json'})});
    });
  }
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
const settle = async (n = 6) => { for (let i = 0; i < n; i += 1) await tick(); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return {promise, resolve}; };

const selectFile = (file) => {
  const input = get('bundle-file');
  for (const listener of input.listeners.change || []) listener({target: {files: [file]}});
};

(async () => {
  await settle();

  // 1. A pending read clears the old bundle and disables Run immediately.
  const slow = deferred();
  selectFile({name: 'slow-a.json', size: 100, text: () => slow.promise});
  assert.equal(get('run-button').disabled, true, 'Run is disabled while a new bundle is being read');
  assert.match(get('selection').textContent, /Reading slow-a\.json/, 'the pending selection is shown, not the old one');

  // 2. A newer selection wins; the earlier read must not publish over it.
  const fast = deferred();
  selectFile({name: 'fast-b.json', size: 100, text: () => fast.promise});
  assert.match(get('selection').textContent, /Reading fast-b\.json/, 'the newest selection is the pending one');
  fast.resolve(JSON.stringify(bundle('b')));
  await settle();
  assert.match(get('selection').innerHTML, /fast-b\.json/, 'the newer selection is displayed');
  slow.resolve(JSON.stringify(bundle('a')));
  await settle();
  assert.match(get('selection').innerHTML, /fast-b\.json/, 'the late read of the earlier file did not replace it');

  // 3. A late example response must not overwrite a newer file selection.
  for (const listener of get('example-button').listeners.click || []) listener();
  await settle(3);
  const later = deferred();
  selectFile({name: 'later-c.json', size: 100, text: () => later.promise});
  later.resolve(JSON.stringify(bundle('c')));
  await settle();
  assert.match(get('selection').innerHTML, /later-c\.json/, 'the file selection is displayed before the example resolves');
  pendingExample();
  await settle();
  assert.match(get('selection').innerHTML, /later-c\.json/, 'the late example response did not replace the file selection');

  // 4. Startup restoration must not replace an explicit history choice.
  assert.ok(pendingRestore, 'startup restoration is waiting on the delayed history response');
  const run2Button = historyList.children.find((child) => child.dataset.run === 'run-2');
  assert.ok(run2Button, 'accepted run is addressable from history');
  run2Button.click();
  await settle();
  assert.equal(get('result-state').hidden, false, 'the explicit choice is rendered');
  assert.match(get('result-json').textContent, /run-2/, 'the explicit choice is run-2');

  pendingRestore({ok: true, json: async () => ({active: 'run-1', runs: [{id: 'run-1', status: 'running'}]})});
  await settle();
  assert.equal(get('result-state').hidden, false, 'delayed restoration did not replace the explicit choice');
  assert.match(get('result-json').textContent, /run-2/, 'the delayed latest-run response stayed inert');

  console.log('review-selection: stale reads and delayed restoration cannot replace the current choice');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
