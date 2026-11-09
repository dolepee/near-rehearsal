'use strict';
/*
 * A delayed startup restoration must not displace a review that is already
 * being started. The POST is held open while the old "latest run" response
 * arrives; the new review must stay selected and begin polling.
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
const bundle = {
  runId: 'new-run', caseId: 'sputnik-238-async-bond',
  source: {commit: 'a'.repeat(40), repository: 'x', path: 'y'},
  candidate: {wasm: {sha256: 'b'.repeat(64)}},
};
const runningRun = {
  id: 'new-run', status: 'running', phase: 'replaying', startedAt: now, elapsedMs: 10,
  mode: 'recorded-wasm', logs: [],
};
const oldRun = {
  id: 'old-run', status: 'accepted', phase: 'accepted', startedAt: now, finishedAt: now,
  elapsedMs: 20, mode: 'recorded-wasm', bundle: {sha256: 'c'.repeat(64)},
  result: {
    bundle: {sha256: 'c'.repeat(64)},
    run: {mode: 'recorded-wasm', modeLabel: 'old result'},
    summary: {mode: 'recorded-wasm', modeLabel: 'old result', checks: {accepted: true}},
  },
};

let runsCalls = 0;
let postCalls = 0;
let pendingRestore;
let pendingStart;
const fetch = async (url, options = {}) => {
  if (url === '/api/review/config') {
    return {ok: true, json: async () => ({
      configured: true, defaultMode: 'recorded-wasm',
      modes: {'recorded-wasm': {configured: true, missing: []}, 'source-build': {configured: false, missing: ['REPAIR_SOURCE_DIR']}},
    })};
  }
  if (url === '/api/review/runs' && options.method === 'POST') {
    postCalls += 1;
    return new Promise((resolve) => { pendingStart = resolve; });
  }
  if (url === '/api/review/runs') {
    runsCalls += 1;
    if (runsCalls === 2) return new Promise((resolve) => { pendingRestore = resolve; });
    return {ok: true, json: async () => ({runs: [], active: null})};
  }
  if (url === '/api/review/runs/new-run') return {ok: true, json: async () => runningRun};
  if (url === '/api/review/runs/old-run') return {ok: true, json: async () => oldRun};
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

(async () => {
  await settle();
  for (const id of ['empty-state', 'running-state', 'error-state', 'result-state']) get(id).hidden = true;
  const input = get('bundle-file');
  for (const listener of input.listeners.change || []) listener({target: {files: [{
    name: 'new.json', size: 100, text: async () => JSON.stringify(bundle),
  }]}});
  await settle();
  assert.match(get('selection').innerHTML, /new\.json/, 'file selection is ready');
  assert.equal(get('run-button').disabled, false, 'Run is enabled for the selected bundle');

  get('run-button').click();
  await settle();
  assert.equal(postCalls, 1, 'the Run click started exactly one POST');
  assert.match(get('run-button').textContent, /Starting review/, 'the new review is in its start state');
  assert.ok(pendingRestore, 'startup restoration is still pending');

  pendingRestore({ok: true, json: async () => ({active: 'old-run', runs: [{id: 'old-run', status: 'accepted'}]})});
  await settle();
  assert.equal(get('result-state').hidden, true, 'the delayed old run did not replace the pending start');

  pendingStart({ok: true, json: async () => ({run: runningRun})});
  await settle();
  assert.equal(get('running-state').hidden, false, 'the new review is selected and shown as running');
  assert.equal(get('run-id').textContent, 'new-run', 'the new review ID is selected');
  assert.match(get('status').textContent, /Review running/, 'the new review is polling state');

  // The scheduled poll must fetch the new run, not the old restored candidate.
  const poll = timers.at(-1);
  assert.ok(poll, 'a poll was scheduled for the new review');
  poll();
  await settle();
  assert.equal(get('run-id').textContent, 'new-run', 'polling stays on the new review');

  console.log('review-start-race: delayed restoration cannot replace a review being started');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
