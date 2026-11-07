'use strict';
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
    this.id = id;
    this.dataset = {};
    this.classList = new FakeClassList();
    this.attributes = {};
    this.listeners = {};
    this.children = [];
    this.textContent = '';
    this.hidden = false;
    this.className = '';
    this.style = {};
    this._innerHTML = '';
    this.renderCount = 0;
  }
  set innerHTML(value) {
    this._innerHTML = String(value);
    this.renderCount += 1;
    this.children = [];
    for (const match of this._innerHTML.matchAll(/<button[^>]*data-run-id="([^"]+)"[^>]*>/g)) {
      const button = new FakeElement(`history-${match[1]}`);
      button.dataset.runId = match[1];
      button.classList.values.add('history-item');
      this.children.push(button);
    }
  }
  get innerHTML() { return this._innerHTML; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  dispatch(type) { for (const listener of this.listeners[type] || []) listener({currentTarget: this}); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  focus() { this.focused = true; context.document.activeElement = this; }
  querySelectorAll(selector) { return selector === '[data-run-id]' ? this.children : []; }
  contains(node) { return node === this || this.children.includes(node); }
}

const elements = new Map();
const getElement = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement(id));
  return elements.get(id);
};
const context = {
  console,
  document: {activeElement: null, getElementById: getElement},
  fetch: null,
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
};
context.document.activeElement = new FakeElement('body');

const caseData = {
  providerConfigured: false,
  configured: false,
  missing: ['model'],
  case: {
    id: 'sputnik-238-async-bond',
    label: 'Sputnik #238',
    description: 'Local test case',
    source: {repository: 'https://example.test/repo', commit: 'a'.repeat(40), path: 'sputnikdao2/src/proposals.rs'},
    obligation: {failedAction: 'FunctionCall', failedProposalId: 0, bondNear: '1', transferNear: '0.1', recipient: 'recipient.test.near', proposer: 'proposer.test.near'},
    boundary: 'Local reproduction only.',
  },
};
const historyRun = {id: 'run-1', status: 'running', phase: 'generating', startedAt: '2026-11-07T18:00:00.000Z'};
const rejectedRun = {
  id: 'run-rejected', status: 'rejected', phase: 'rejected', startedAt: '2026-11-07T18:01:00.000Z',
  error: 'The repair ran but did not pass the declared checks.', logs: [], evidence: {},
  consequence: {
    baseline: {bondRetained: true, failedContract: '1000000000000000000000000'},
    candidate: {bondReturned: true, failedContract: '-100000000000000000000000', retryNoSecondRefund: true, retryFinal: null, retryGas: '1', healthyPayoutUnchanged: true, healthyRecipient: '100000000000000000000000'},
  },
  checks: {baselineBondRetained: true, candidateBondReturned: true, authorizedRetryNoSecondRefund: false, healthyPayoutUnchanged: true, baseAndCandidateStartSameState: true},
};
let historyRenders = 0;
let runRequests = 0;
context.fetch = async (url) => {
  if (url === '/api/repair/case') return {ok: true, json: async () => caseData};
  if (url === '/api/repair/runs') {
    historyRenders += 1;
    return {ok: true, json: async () => ({runs: [historyRun, rejectedRun], active: null})};
  }
  if (url === '/api/repair/run') {
    runRequests += 1;
    return {ok: true, json: async () => ({run: {...historyRun, caseId: caseData.case.id}})};
  }
  if (url === '/api/repair/runs/run-rejected') return {ok: true, json: async () => rejectedRun};
  if (url.startsWith('/api/repair/runs/')) return {ok: true, json: async () => historyRun};
  return {ok: false, json: async () => ({error: 'unexpected'})};
};

vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public/repair.js'), 'utf8'), context, {filename: 'repair.js'});
const wait = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  await wait(); await wait();
  const list = getElement('history-list');
  const first = list.children[0];
  assert.ok(first, 'history item rendered');
  first.focus();
  assert.equal(context.document.activeElement, first);
  const beforeRenders = list.renderCount;

  // Starting a run triggers another history load with the same item. The DOM
  // node (and therefore focus) must survive that unchanged poll.
  getElement('run-button').dispatch('click');
  await wait(); await wait();
  assert.equal(runRequests, 1);
  assert.equal(list.renderCount, beforeRenders, 'unchanged history poll does not replace the list');
  assert.equal(context.document.activeElement, first, 'focus remains on the history item');
  assert.equal(first.getAttribute('aria-current'), 'true', 'the active run is exposed as the current history item');
  assert.equal(first.classList.contains('selected'), true);

  // A rejected result must format negative deltas with one sign and must not
  // turn a zero-delta, non-FINAL retry into a green success card.
  const rejectedButton = list.children.find((button) => button.dataset.runId === 'run-rejected');
  assert.ok(rejectedButton, 'rejected history item rendered');
  rejectedButton.dispatch('click');
  await wait(); await wait();
  const cards = getElement('consequence-grid').innerHTML;
  assert.match(cards, /-0\.1 NEAR/, 'negative fractional contract delta keeps one sign');
  assert.doesNotMatch(cards, /0\.-1/, 'negative fractional delta does not leave a sign after the decimal');
  assert.match(cards, /Retry not clean/, 'retry card uses the authoritative receipt-backed check');
  assert.doesNotMatch(cards, /No second refund/, 'non-FINAL retry is not presented as clean');

  console.log(JSON.stringify({
    schema: 'near-rehearsal/repair-browser-history-focus-tests/v1',
    passed: true,
    checks: ['unchanged-history-node-preserved', 'focus-preserved', 'active-run-aria-current', 'active-run-selection', 'negative-delta-format', 'retry-requires-final-receipt'],
  }, null, 2));
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
