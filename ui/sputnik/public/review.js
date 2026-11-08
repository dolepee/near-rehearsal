(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = {config: null, selected: null, run: null, runId: null, poll: null, failures: 0, historySignature: null};
  const terminal = new Set(['accepted', 'rejected', 'interrupted']);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const short = (value, n = 14) => value ? `${String(value).slice(0, n)}…${String(value).slice(-6)}` : '—';
  const date = (value) => {
    if (!value) return '—';
    try { return new Date(value).toLocaleString(); } catch { return String(value); }
  };
  const duration = (ms) => {
    const seconds = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const setStatus = (text, kind = 'idle') => {
    const el = $('status');
    el.textContent = text;
    el.className = `status-pill ${kind}`;
  };
  const runIsActive = () => Boolean(state.run && !terminal.has(state.run.status));
  const show = (id) => {
    for (const key of ['empty-state', 'running-state', 'error-state', 'result-state']) $(key).hidden = key !== id;
  };

  function setRunButton(disabled, label = disabled ? 'One review at a time' : 'Run recorded review') {
    const button = $('run-button');
    button.disabled = disabled;
    button.textContent = label;
    button.setAttribute('aria-busy', String(disabled));
  }

  function renderSelection() {
    const selection = $('selection');
    if (!state.selected) {
      selection.className = 'selection';
      selection.textContent = 'No bundle selected.';
      setRunButton(true, 'Select a bundle to run');
      return;
    }
    const {bundle, label} = state.selected;
    selection.className = 'selection ready';
    selection.innerHTML = `<b>${esc(label)}</b><span>Run ${esc(short(bundle.runId))} · ${esc(bundle.source?.commit || 'source commit missing')}</span><span class="mono">candidate ${esc(short(bundle.candidate?.wasm?.sha256 || bundle.candidate?.wasmSha256 || ''))}</span>`;
    setRunButton(runIsActive() || !state.config?.configured, runIsActive() ? 'One review at a time' : 'Run recorded review');
  }

  function renderConfig() {
    const note = $('runtime-note');
    if (!state.config) {
      note.className = 'notice';
      note.textContent = 'Checking the local runtime…';
      setRunButton(true, 'Checking runtime');
      return;
    }
    if (state.config.configured) {
      note.className = 'notice provider-ok';
      note.textContent = 'Sandbox 2.14 directory is configured. This page will not call a model.';
      setRunButton(runIsActive() || !state.selected, runIsActive() ? 'One review at a time' : state.selected ? 'Run recorded review' : 'Select a bundle to run');
    } else {
      note.className = 'notice provider-bad';
      note.textContent = `Recorded replay is not configured: ${state.config.missing?.join(', ') || 'Sandbox directory missing'}. Set the runtime on the server before running.`;
      setRunButton(true, 'Runtime not configured');
    }
  }

  async function loadConfig() {
    try {
      const response = await fetch('/api/review/config', {headers: {'accept': 'application/json'}});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not read the local configuration.');
      state.config = data;
      renderConfig();
    } catch (error) {
      state.config = {configured: false, missing: [error.message]};
      renderConfig();
    }
  }

  async function selectFile(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      setSelectionError('That file is larger than the 8 MB browser limit.');
      return;
    }
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      state.selected = {bundle, sha256, label: file.name};
      renderSelection();
    } catch (error) {
      setSelectionError(`That file is not a readable JSON bundle (${error.message}).`);
    }
  }

  function setSelectionError(message) {
    state.selected = null;
    const selection = $('selection');
    selection.className = 'selection';
    selection.textContent = message;
    setRunButton(true, 'Select a bundle to run');
  }

  async function loadExample() {
    const button = $('example-button');
    button.disabled = true;
    button.textContent = 'Loading example…';
    try {
      const response = await fetch('/api/review/example', {headers: {'accept': 'application/json'}});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load the example bundle.');
      state.selected = {bundle: data.bundle, sha256: data.sha256, label: data.filename};
      renderSelection();
    } catch (error) {
      setSelectionError(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Load the example bundle';
    }
  }

  function renderRunning(run) {
    show('running-state');
    $('run-id').textContent = run.id;
    $('running-title').textContent = 'Replaying the supplied candidate…';
    $('running-copy').textContent = 'The bundle was checked before the replay directory was reserved. The candidate is executed against the local Sandbox; no model is called.';
    $('elapsed').textContent = duration(run.elapsedMs);
    $('phase-current').textContent = run.phase === 'accepting' ? 'Running the declared acceptance checks…' : 'Executing the recorded recovery and retry…';
    for (const item of document.querySelectorAll('#phase-list li')) {
      const phase = item.dataset.phase;
      item.classList.toggle('active', phase === (run.phase === 'accepting' ? 'accepting' : 'replaying'));
      item.classList.toggle('done', run.phase === 'accepted');
      item.classList.toggle('failed', run.phase === 'rejected' || run.phase === 'interrupted');
    }
    $('logs').textContent = (run.logs || []).slice(-120).join('\n') || 'Waiting for runner output…';
    setStatus('Review running', 'active');
    setRunButton(true, 'One review at a time');
  }

  function card(label, value, copy, kind = '') {
    return `<article class="review-card ${kind}"><div class="eyebrow">${esc(label)}</div><strong>${esc(value)}</strong><p>${esc(copy)}</p></article>`;
  }

  function renderResult(run) {
    show('result-state');
    const result = run.result;
    const s = result?.summary || {};
    const checks = s.checks || {};
    const accepted = checks.accepted === true && run.status === 'accepted';
    $('result-banner').className = `result-banner${accepted ? '' : ' bad'}`;
    $('result-banner').textContent = accepted ? 'Review passed — the recorded candidate met the declared checks.' : 'Review did not pass — no accepted result is available.';
    $('result-copy').textContent = accepted
      ? `Bundle ${short(result.bundle?.sha256 || run.bundle?.sha256)} was replayed from its supplied artifact. The result below is the measured outcome, not a cached report.`
      : 'The recorded candidate did not pass acceptance. Inspect the checks and the review output before trying another bundle.';
    const preserved = checks.preservedState === true && checks.preservedPolicy === true && checks.preservedProposal === true;
    const healthy = checks.healthyControl === true && checks.pendingHealthy === true;
    $('review-grid').innerHTML = [
      card('Mode', s.modeLabel || 'Recorded WASM replay', 'Supplied artifact, no source build and no model call.'),
      card('Candidate WASM', short(s.candidateWasmSha256 || result.bundle?.candidate?.wasmSha256), 'Exact artifact exercised by the replay.', 'good'),
      card('First recovery', s.firstRecovery?.gross || '—', `${s.firstRecovery?.gas || '—'} gas · proposer net ${s.firstRecovery?.proposerNet || '—'}`, s.firstRecovery?.gross === '0 NEAR' ? 'bad' : 'good'),
      card('Retry', s.retry?.gross || '—', `${s.retry?.gas || '—'} gas · no additional principal`, s.retry?.gross === '0 NEAR' ? 'good' : 'bad'),
      card('Preserved state', preserved ? 'Yes' : 'No', 'Inherited state, policy and proposal remain present.', preserved ? 'good' : 'bad'),
      card('Authority', checks.authorityRejected ? 'Rejected' : 'Not checked', 'Unauthorized update and finalize attempts stay rejected.', checks.authorityRejected ? 'good' : 'bad'),
      card('Healthy controls', healthy ? 'Both pass' : 'Incomplete', 'Already-paid obligation and inherited pending Transfer.', healthy ? 'good' : 'bad'),
      card('Acceptance', accepted ? 'Pass' : 'Fail', 'Declared persisted-recovery acceptance receipt.', accepted ? 'good' : 'bad'),
    ].join('');
    $('meaning-note').textContent = 'This is a recorded artifact replay. It shows the supplied candidate passed the declared local checks. It does not rebuild source, call a model, publish anything, or prove production safety.';
    const rows = [
      ['Frozen old-code failure reproduced', s.frozenOldCodeFailure === true],
      ['First recovery returns the bond exactly once', s.firstRecovery?.gross !== '0 NEAR' && s.firstRecovery?.contractDelta === '-1 NEAR'],
      ['Retry takes no additional principal', s.retry?.gross === '0 NEAR'],
      ['Inherited state, policy and proposal preserved', preserved],
      ['Unauthorized update and finalize rejected', checks.authorityRejected === true],
      ['Already-paid healthy obligation preserved', checks.healthyControl === true],
      ['Inherited pending Transfer preserved', checks.pendingHealthy === true],
      ['Acceptance receipt is passing', accepted],
    ];
    $('checks-list').innerHTML = rows.map(([label, ok]) => `<li><span class="check-mark${ok ? '' : ' bad'}" aria-hidden="true">${ok ? '✓' : '×'}</span><span>${esc(label)}</span></li>`).join('');
    $('checks-badge').className = `badge ${accepted ? 'good' : 'bad'}`;
    $('checks-badge').textContent = accepted ? 'Accepted' : 'Not accepted';
    const download = $('downloads');
    download.innerHTML = run.downloadUrl
      ? `<a class="download-button" href="${esc(run.downloadUrl)}" download>Download review result</a>`
      : '<span class="download-button disabled" aria-disabled="true">Result download withheld</span>';
    $('result-json').textContent = JSON.stringify(result, null, 2);
    setStatus(accepted ? 'Review accepted' : 'Review not accepted', accepted ? 'accepted' : 'rejected');
    setRunButton(!state.config?.configured || !state.selected, !state.selected ? 'Select a bundle to run' : 'Run another review');
  }

  function renderError(run) {
    show('error-state');
    $('error-title').textContent = run.status === 'interrupted' ? 'The review was interrupted.' : 'The review did not pass.';
    $('error-copy').textContent = run.error || 'No accepted result was produced.';
    $('error-log').textContent = (run.logs || []).slice(-40).join('\n') || 'No runner output was captured.';
    setStatus(run.status === 'interrupted' ? 'Review interrupted' : 'Review not accepted', run.status === 'interrupted' ? 'interrupted' : 'rejected');
    setRunButton(!state.config?.configured || !state.selected, !state.selected ? 'Select a bundle to run' : 'Try another bundle');
  }

  function renderRun(run) {
    state.run = run;
    state.runId = run.id;
    if (run.status === 'accepted') renderResult(run);
    else if (terminal.has(run.status)) renderError(run);
    else renderRunning(run);
    $('elapsed').textContent = duration(run.elapsedMs);
    if (terminal.has(run.status)) refreshHistory();
  }

  function schedulePoll() {
    clearTimeout(state.poll);
    state.poll = setTimeout(poll, 1200);
  }

  async function poll() {
    if (!state.runId) return;
    try {
      const response = await fetch(`/api/review/runs/${state.runId}`, {headers: {'accept': 'application/json'}});
      if (response.status === 404) throw new Error('That review run no longer exists.');
      const run = await response.json();
      if (!response.ok) throw new Error(run.error || 'Could not read the review run.');
      state.failures = 0;
      renderRun(run);
      if (!terminal.has(run.status)) schedulePoll();
    } catch (error) {
      state.failures += 1;
      if (state.failures >= 4) {
        renderError({status: 'interrupted', error: error.message, logs: []});
        return;
      }
      schedulePoll();
    }
  }

  async function startReview() {
    if (!state.selected) return;
    if (!state.config?.configured) {
      state.config = {...state.config, missing: state.config?.missing || ['REPAIR_SANDBOX_DIR']};
      renderConfig();
      return;
    }
    setRunButton(true, 'Starting review');
    try {
      const response = await fetch('/api/review/runs', {
        method: 'POST',
        headers: {'content-type': 'application/json', 'accept': 'application/json'},
        body: JSON.stringify({bundle: state.selected.bundle}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not start the review.');
      state.failures = 0;
      renderRun(data.run);
      schedulePoll();
    } catch (error) {
      show('error-state');
      $('error-title').textContent = 'The review could not start.';
      $('error-copy').textContent = error.message;
      $('error-log').textContent = '';
      setStatus('Review not started', 'rejected');
      setRunButton(!state.config?.configured || !state.selected, !state.selected ? 'Select a bundle to run' : 'Try again');
    }
  }

  function historySignature(runs) {
    return runs.map((run) => `${run.id}:${run.status}:${run.finishedAt || ''}`).join('|');
  }

  async function refreshHistory() {
    try {
      const response = await fetch('/api/review/runs', {headers: {'accept': 'application/json'}});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not read review history.');
      const runs = data.runs || [];
      const signature = historySignature(runs);
      if (signature === state.historySignature) return;
      state.historySignature = signature;
      const list = $('history-list');
      if (!runs.length) {
        list.innerHTML = '<p class="muted small">No previous reviews.</p>';
        return;
      }
      list.innerHTML = runs.map((run) => `<button class="history-item" type="button" data-run="${esc(run.id)}" aria-current="${run.id === state.runId ? 'true' : 'false'}"><b>${esc(run.status === 'accepted' ? 'Accepted' : run.status === 'running' ? 'Running' : 'Not accepted')} · ${esc(short(run.id, 8))}</b><small>${esc(date(run.startedAt))} · ${esc(run.bundle?.source?.commit ? short(run.bundle.source.commit) : 'source unknown')}</small></button>`).join('');
      for (const button of list.querySelectorAll('[data-run]')) {
        button.addEventListener('click', () => openRun(button.dataset.run));
      }
    } catch {
      // History is helpful, not required for the current run.
    }
  }

  async function openRun(id) {
    try {
      const response = await fetch(`/api/review/runs/${id}`, {headers: {'accept': 'application/json'}});
      const run = await response.json();
      if (!response.ok) throw new Error(run.error || 'Could not read that review run.');
      state.runId = id;
      state.failures = 0;
      renderRun(run);
      await refreshHistory();
    } catch (error) {
      show('error-state');
      $('error-title').textContent = 'That review could not be opened.';
      $('error-copy').textContent = error.message;
      $('error-log').textContent = '';
    }
  }

  $('bundle-file').addEventListener('change', (event) => {
    selectFile(event.target.files?.[0]);
  });
  $('example-button').addEventListener('click', loadExample);
  $('run-button').addEventListener('click', startReview);
  $('retry-button').addEventListener('click', () => {
    show('empty-state');
    setStatus('No review run yet', 'idle');
    $('bundle-file').focus();
  });

  loadConfig();
  refreshHistory().then(async () => {
    const response = await fetch('/api/review/runs', {headers: {'accept': 'application/json'}}).catch(() => null);
    if (!response?.ok) return;
    const data = await response.json().catch(() => null);
    const target = data?.active || data?.runs?.[0]?.id;
    if (target) openRun(target);
  });
})();
