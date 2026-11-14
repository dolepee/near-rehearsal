'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {compareMixed} = require('../../scripts/repair-review.cjs');

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
    this.innerHTML = ''; this.disabled = false; this.files = [];
  }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  focus() { document.activeElement = this; }
  querySelectorAll() { return []; }
  click() { for (const listener of this.listeners.click || []) listener({currentTarget: this}); }
}
const elements = new Map();
const get = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement(id));
  return elements.get(id);
};
const timers = [];
const document = {activeElement: null, getElementById: get, querySelectorAll: () => []};
let runReads = 0;
let readFailures = 0;
let postCalls = 0;
const running = {id: 'run-1', status: 'running', phase: 'replaying', startedAt: new Date().toISOString(), elapsedMs: 1000, mode: 'recorded-wasm', logs: []};
const accepted = {
  id: 'run-1', status: 'accepted', phase: 'accepted', startedAt: new Date(Date.now() - 5000).toISOString(), finishedAt: new Date().toISOString(), elapsedMs: 5000, mode: 'recorded-wasm',
  bundle: {sha256: 'a'.repeat(64), source: {commit: 'b'.repeat(40)}}, downloadUrl: '/download', inputUrl: '/input', evidenceUrl: '/evidence',
  result: {
    schema: 'near-rehearsal/review-browser-result/v1', createdAt: new Date().toISOString(),
    bundle: {sha256: 'a'.repeat(64), candidate: {wasmSha256: 'c'.repeat(64)}},
    run: {mode: 'recorded-wasm', modeLabel: 'recorded WASM replay (supplied artifact; no source build)'},
    summary: {
      mode: 'recorded-wasm', modeLabel: 'recorded WASM replay (supplied artifact; no source build)',
      candidateWasmSha256: 'c'.repeat(64), frozenOldCodeFailure: true,
      firstRecovery: {gross: '1 NEAR', gas: '0.0007 NEAR', proposerNet: '0.9993 NEAR', contractDelta: '-1 NEAR'},
      retry: {gross: '0 NEAR', gas: '0.0006 NEAR', proposerNet: '-0.0006 NEAR'},
      checks: {preservedState: true, preservedPolicy: true, preservedProposal: true, authorityRejected: true, healthyControl: true, pendingHealthy: true, accepted: true},
    },
  },
};
let runResponse = running;
const fetch = async (url, options = {}) => {
  if (options.method === 'POST') { postCalls += 1; throw new Error('Unexpected duplicate start'); }
  if (url === '/api/review/config') return {ok: true, json: async () => ({
    configured: true, defaultMode: 'recorded-wasm',
    modes: {'recorded-wasm': {configured: true, missing: []}, 'source-build': {configured: false, missing: ['REPAIR_SOURCE_DIR']}},
  })};
  if (url === '/api/review/runs') return {ok: true, json: async () => ({runs: [{id: 'run-1', status: runResponse.status, mode: 'recorded-wasm'}], active: 'run-1'})};
  if (url === '/api/review/runs/run-1') {
    runReads += 1;
    if (readFailures > 0) { readFailures -= 1; throw new Error('Network unavailable'); }
    return {ok: true, json: async () => runResponse};
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

(async () => {
  await tick(); await tick(); await tick();
  assert.ok(timers.length > 0, 'restoring an active run schedules a poll');
  const first = timers.shift();
  first();
  await tick(); await tick();
  assert.ok(runReads >= 1, 'the restored run is polled after refresh');
  assert.ok(timers.length > 0, 'a running response schedules the next poll');
  const exhaustPolls = async () => {
    readFailures = 4;
    for (let i = 0; i < 4; i += 1) {
      assert.ok(timers.length, 'a retry is available before polling is exhausted');
      timers.shift()();
      await tick(); await tick(); await tick();
    }
    assert.equal(timers.length, 0, 'polling stops after the bounded failures');
    assert.match(get('status').textContent, /unknown/, 'transport failure does not claim the job stopped');
    assert.equal(get('retry-button').textContent, 'Reconnect to review', 'same-run recovery is available');
  };
  await exhaustPolls();
  get('retry-button').click();
  await tick(); await tick(); await tick();
  assert.equal(get('running-state').hidden, false, 'reconnecting resumes the existing running review');
  assert.equal(get('run-id').textContent, 'run-1', 'reconnection keeps the same run');
  assert.ok(timers.length, 'reconnection schedules polling again');
  assert.equal(postCalls, 0, 'reconnection does not submit a new review');
  await exhaustPolls();
  const legacyOutcomes = {alicePaid: true, bobLiabilityAfterAlice: true, bobTransferPaid: true, bobPaidExactlyOnce: true};
  accepted.result.mixed = {
    policy: {sha256: 'd'.repeat(64)},
    reviewer: {ok: true, outcomes: legacyOutcomes},
    comparison: compareMixed(null, {ok: true, outcomes: legacyOutcomes}, 'c'.repeat(64), 'c'.repeat(64)),
  };
  runResponse = accepted; // The server finished while polling was unavailable.
  get('retry-button').click();
  await tick(); await tick(); await tick();
  assert.equal(get('result-state').hidden, false, 'terminal poll renders the result instead of freezing on Running');
  assert.match(get('status').textContent, /accepted/, 'accepted status is rendered');
  assert.equal(postCalls, 0, 'terminal reconnection does not submit a new review');
  assert.equal(timers.length, 0, 'terminal reconnection stops polling');
  assert.match(get('same-dao-copy').textContent, /Legacy bundle/);
  assert.match(get('same-dao-list').innerHTML, /reviewer <b>yes/);
  assert.doesNotMatch(get('same-dao-list').innerHTML, /not recorded/, 'fresh legacy outcomes must not disappear behind the comparison wrapper');

  // Saved results created before normalization still carry the old wrapper.
  const flatComparison = accepted.result.mixed.comparison;
  accepted.result.mixed.comparison = {...flatComparison, reviewer: {ok: true, outcomes: legacyOutcomes}};
  elements.clear();
  timers.length = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public/review.js'), 'utf8'), context, {filename: 'review.js'});
  await tick(); await tick(); await tick(); await tick();
  assert.equal(get('result-state').hidden, false, 'older saved results still open');
  assert.match(get('same-dao-list').innerHTML, /reviewer <b>yes/);
  assert.doesNotMatch(get('same-dao-list').innerHTML, /not recorded/, 'older nested outcomes remain readable');
  assert.equal(timers.length, 0, 'opening saved results does not restart polling');
  accepted.result.mixed.comparison = flatComparison;

  // A coverage-only reviewer result is terminal but not accepted.
  elements.clear();
  timers.length = 0;
  runResponse = {...accepted, status: 'inconclusive', phase: 'inconclusive',
    error: 'The review was inconclusive: required coverage evidence was not proven; it is not accepted.',
    downloadUrl: null, evidenceUrl: null,
    result: {...accepted.result, status: 'INCONCLUSIVE', accepted: false, acceptancePolicy: {status: 'INCONCLUSIVE'}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public/review.js'), 'utf8'), context, {filename: 'review.js'});
  await tick(); await tick(); await tick(); await tick();
  assert.equal(get('error-state').hidden, false, 'inconclusive results render a terminal state');
  assert.match(get('error-copy').textContent, /coverage evidence was not proven/);
  assert.match(get('status').textContent, /inconclusive/i);
  assert.equal(timers.length, 0, 'inconclusive history stops polling');

  // Restore a historical result whose evidence disappeared while the server
  // was stopped. It must release the UI rather than pretend to keep running.
  elements.clear();
  timers.length = 0;
  runResponse = {...accepted, status: 'unavailable', phase: 'unavailable', result: null,
    error: 'The supporting evidence files are unavailable.', downloadUrl: null, evidenceUrl: null};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public/review.js'), 'utf8'), context, {filename: 'review.js'});
  await tick(); await tick(); await tick(); await tick();
  assert.equal(get('error-state').hidden, false, 'missing historical evidence renders an error');
  assert.match(get('error-copy').textContent, /supporting evidence files are unavailable/);
  assert.equal(timers.length, 0, 'an unavailable historical result does not poll forever');
  assert.equal(postCalls, 0, 'opening unavailable history does not launch a replacement job');
  const replacement = {name: 'replacement.json', size: 2, text: async () => JSON.stringify({runId: 'replacement'})};
  for (const listener of get('bundle-file').listeners.change || []) listener({target: {files: [replacement]}});
  await tick(); await tick(); await tick();
  assert.equal(get('run-button').disabled, false, 'a newly selected bundle can run after unavailable history');
  assert.equal(get('run-button').textContent, 'Run recorded review');
  console.log('review-polling: refresh and bounded-failure reconnect preserve the run and recover its terminal result');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
