'use strict';
/*
 * Submission lock: while the start POST is in flight the page must keep Run
 * locked (a new selection must not re-enable it, and a second click must not
 * launch a competing start), and a submission failure that belongs to a
 * navigation the reviewer has already left must not replace the run on screen.
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

const now = new Date().toISOString();
const bundle = (label) => ({
  runId: `run-${label}`, caseId: 'sputnik-238-async-bond',
  source: {commit: label.repeat(40).slice(0, 40), repository: 'x', path: 'y'},
  candidate: {wasm: {sha256: label.repeat(64).slice(0, 64)}},
});
const runningRun = {id: 'new-run', status: 'running', phase: 'replaying', startedAt: now, elapsedMs: 10, mode: 'recorded-wasm', logs: []};
const acceptedRun = {
  id: 'run-2', status: 'accepted', phase: 'accepted', startedAt: now, finishedAt: now, elapsedMs: 2000, mode: 'recorded-wasm',
  bundle: {sha256: 'd'.repeat(64)}, downloadUrl: '/download', inputUrl: '/input', evidenceUrl: '/evidence',
  result: {
    schema: 'near-rehearsal/review-browser-result/v1', createdAt: now,
    bundle: {sha256: 'd'.repeat(64), candidate: {wasmSha256: 'e'.repeat(64)}},
    run: {mode: 'recorded-wasm', modeLabel: 'SUBMIT LOCK run-2'},
    summary: {
      mode: 'recorded-wasm', modeLabel: 'SUBMIT LOCK run-2', candidateWasmSha256: 'e'.repeat(64), frozenOldCodeFailure: true,
      firstRecovery: {gross: '1 NEAR', gas: '0.0007 NEAR', proposerNet: '0.9993 NEAR', contractDelta: '-1 NEAR'},
      retry: {gross: '0 NEAR', gas: '0.0006 NEAR', proposerNet: '-0.0006 NEAR'},
      checks: {preservedState: true, preservedPolicy: true, preservedProposal: true, authorityRejected: true, healthyControl: true, pendingHealthy: true, accepted: true},
    },
  },
};

/* Each scenario gets a fresh page instance so its openEpoch, timers and
 * button state start from zero. */
function load(handler) {
  const elements = new Map();
  const document = {activeElement: null, getElementById: (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  }, querySelectorAll: () => []};
  const historyList = document.getElementById('history-list');
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
  const context = {
    console, document, fetch: handler,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    TextEncoder, crypto: {subtle: {digest: async () => new ArrayBuffer(32)}},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public/review.js'), 'utf8'), context, {filename: 'review.js'});
  return {get: document.getElementById, historyList, timers};
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (n = 6) => { for (let i = 0; i < n; i += 1) await tick(); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return {promise, resolve}; };
const config = {
  configured: true, defaultMode: 'recorded-wasm',
  modes: {'recorded-wasm': {configured: true, missing: []}, 'source-build': {configured: false, missing: ['REPAIR_SOURCE_DIR']}},
};

async function scenarioPendingSubmission() {
  let postCalls = 0;
  const pending = deferred();
  const {get, timers} = load(async (url, options = {}) => {
    if (url === '/api/review/config') return {ok: true, json: async () => config};
    if (url === '/api/review/runs' && options.method === 'POST') {
      postCalls += 1;
      return pending.promise;
    }
    if (url === '/api/review/runs') return {ok: true, json: async () => ({runs: [], active: null})};
    if (url === '/api/review/runs/new-run') return {ok: true, json: async () => runningRun};
    return {ok: false, json: async () => ({error: 'unexpected'})};
  });
  await settle();

  const selectFile = (file) => {
    for (const listener of get('bundle-file').listeners.change || []) listener({target: {files: [file]}});
  };
  selectFile({name: 'first.json', size: 100, text: async () => JSON.stringify(bundle('a'))});
  await settle();
  assert.equal(get('run-button').disabled, false, 'Run is enabled for the selected bundle');

  get('run-button').click();
  await settle();
  assert.equal(postCalls, 1, 'the Run click started exactly one POST');
  assert.equal(get('run-button').disabled, true, 'Run stays locked while the start request is pending');
  assert.match(get('run-button').textContent, /Starting review/, 'the pending start is reported');

  // Choosing another bundle finishes with a ready selection; that must not
  // re-enable Run while the first POST is still in flight.
  selectFile({name: 'second.json', size: 100, text: async () => JSON.stringify(bundle('b'))});
  await settle();
  assert.match(get('selection').innerHTML, /second\.json/, 'the newer selection is displayed');
  assert.equal(get('run-button').disabled, true, 'a new selection cannot unlock Run during a pending start');
  assert.match(get('run-button').textContent, /Starting review/, 'the pending start is still reported');

  get('run-button').click();
  await settle();
  assert.equal(postCalls, 1, 'a second click during the pending start sends no competing POST');

  pending.resolve({ok: true, json: async () => ({run: runningRun})});
  await settle();
  assert.equal(get('running-state').hidden, false, 'the started review is shown as running');
  assert.equal(get('run-id').textContent, 'new-run', 'the started review is selected');
  assert.equal(get('run-button').disabled, true, 'Run stays disabled while the review is active');
  assert.ok(timers.length, 'a poll was scheduled for the started review');
  return 'pending';
}

async function scenarioStaleSubmissionError() {
  let postCalls = 0;
  const pending = deferred();
  const {get} = load(async (url, options = {}) => {
    if (url === '/api/review/config') return {ok: true, json: async () => config};
    if (url === '/api/review/runs' && options.method === 'POST') {
      postCalls += 1;
      if (postCalls === 1) return pending.promise;
      return {ok: false, json: async () => ({error: 'A review is already running.'})};
    }
    if (url === '/api/review/runs') return {ok: true, json: async () => ({runs: [acceptedRun], active: 'run-2'})};
    if (url === '/api/review/runs/run-2') return {ok: true, json: async () => acceptedRun};
    return {ok: false, json: async () => ({error: 'unexpected'})};
  });
  await settle();
  assert.equal(get('result-state').hidden, false, 'the restored accepted run is displayed');

  for (const listener of get('bundle-file').listeners.change || []) listener({target: {files: [{
    name: 'candidate.json', size: 100, text: async () => JSON.stringify(bundle('c')),
  }]}});
  await settle();
  get('run-button').click();
  await settle();
  assert.equal(postCalls, 1, 'starting the review sent one POST');
  assert.match(get('run-button').textContent, /Starting review/, 'the start request is pending');

  // The reviewer gives up on that start and opens the accepted history entry.
  const run2Button = get('history-list').children.find((child) => child.dataset.run === 'run-2');
  assert.ok(run2Button, 'the accepted run is addressable from history');
  run2Button.click();
  await settle();
  assert.equal(get('result-state').hidden, false, 'the explicit history choice is displayed');
  assert.match(get('result-json').textContent, /run-2/, 'the explicit history choice is run-2');

  // The abandoned POST now fails while its body is being decoded.
  pending.resolve({ok: true, json: async () => { throw new Error('Unexpected end of JSON input'); }});
  await settle();
  assert.equal(get('error-state').hidden, true, 'a stale submission failure does not replace the chosen run');
  assert.equal(get('result-state').hidden, false, 'the chosen run stays on screen');
  assert.match(get('result-json').textContent, /run-2/, 'the chosen run is still run-2');

  // A failure that belongs to the current navigation must still be reported.
  get('run-button').click();
  await settle();
  assert.equal(postCalls, 2, 'the reviewer can start again after the stale failure');
  assert.equal(get('error-state').hidden, false, 'a current submission failure is still reported');
  assert.match(get('error-copy').textContent, /already running/, 'the current failure explains itself');
  return 'stale';
}

(async () => {
  const first = await scenarioPendingSubmission();
  const second = await scenarioStaleSubmissionError();
  console.log(`review-submit-lock: ${first} start is exclusive and ${second} failures stay with their navigation`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
