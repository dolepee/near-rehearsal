(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = {config: null, selected: null, selectionEpoch: 0, selectionPending: null, mode: null, run: null, runId: null, openEpoch: 0, poll: null, failures: 0, historySignature: null, submitting: false, submitMode: null};
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
  const modeValue = () => state.mode || state.config?.defaultMode || 'recorded-wasm';
  const modeInfo = () => state.config?.modes?.[modeValue()] || null;
  const modeReady = () => modeInfo()?.configured === true;
  const show = (id) => {
    for (const key of ['empty-state', 'running-state', 'error-state', 'result-state']) $(key).hidden = key !== id;
  };

  function setRunButton(disabled, label = disabled ? 'One review at a time' : 'Run recorded review') {
    const button = $('run-button');
    button.disabled = disabled;
    button.textContent = label;
    button.setAttribute('aria-busy', String(disabled));
  }

  // The Run button is derived, never toggled ad hoc: a start request that is
  // still in flight locks it regardless of a newer selection or a config
  // re-render, so two competing starts can never be posted for one click each.
  const submitPending = () => state.submitting === true;
  const submitLabel = () => state.submitMode === 'source-build' ? 'Starting source build' : 'Starting review';

  function paintRunButton() {
    if (submitPending()) return setRunButton(true, submitLabel());
    if (!state.config) return setRunButton(true, 'Checking runtime');
    if (!modeReady()) return setRunButton(true, 'Mode not ready');
    if (runIsActive()) return setRunButton(true, 'One review at a time');
    if (state.selectionPending) return setRunButton(true, 'Reading bundle');
    if (!state.selected) return setRunButton(true, 'Select a bundle to run');
    return setRunButton(false, modeValue() === 'source-build' ? 'Run source build' : 'Run recorded review');
  }

  function renderSelection() {
    const selection = $('selection');
    if (!state.selected) {
      selection.className = 'selection';
      selection.textContent = state.selectionPending ? `Reading ${state.selectionPending}…` : 'No bundle selected.';
      paintRunButton();
      return;
    }
    const {bundle, label} = state.selected;
    selection.className = 'selection ready';
    selection.innerHTML = `<b>${esc(label)}</b><span>Run ${esc(short(bundle.runId))} · ${esc(bundle.source?.commit || 'source commit missing')}</span><span class="mono">candidate ${esc(short(bundle.candidate?.wasm?.sha256 || bundle.candidate?.wasmSha256 || ''))}</span>`;
    paintRunButton();
  }

  function renderConfig() {
    const note = $('runtime-note');
    if (!state.config) {
      note.className = 'notice';
      note.textContent = 'Checking the local runtime…';
      paintRunButton();
      return;
    }
    const modes = state.config.modes || {};
    state.mode = modes[state.mode] ? state.mode : (modes[state.config.defaultMode] ? state.config.defaultMode : 'recorded-wasm');
    for (const mode of ['source-build', 'recorded-wasm']) {
      const input = $(mode === 'source-build' ? 'mode-source' : 'mode-recorded');
      const status = $(mode === 'source-build' ? 'mode-source-status' : 'mode-recorded-status');
      const info = modes[mode];
      if (input) { input.checked = mode === state.mode; input.disabled = !info?.configured; }
      if (status) {
        status.className = `mode-option-status${info?.configured ? ' ready' : ''}`;
        status.textContent = info?.configured ? 'Ready: local prerequisites present.' : `Not available: ${info?.missing?.join(', ') || 'prerequisites missing'}.`;
      }
    }
    if (modeReady()) {
      note.className = 'notice provider-ok';
      note.textContent = modeValue() === 'source-build'
        ? 'Pinned source, Rust 1.86 and the local Sandbox are configured. This page will not call a model.'
        : 'Sandbox 2.14 directory is configured. This page will not call a model.';
      paintRunButton();
    } else {
      note.className = 'notice provider-bad';
      note.textContent = `${modeValue() === 'source-build' ? 'Source build' : 'Recorded replay'} is not configured: ${modeInfo()?.missing?.join(', ') || 'prerequisites missing'}. Choose the available mode or configure the server.`;
      paintRunButton();
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

  // Selecting a bundle is asynchronous (read, parse, hash). Every selection
  // takes a generation token and clears the current bundle first, so a slow
  // earlier read can neither publish over a newer choice nor leave the Run
  // button pointing at the previous candidate while the read is pending.
  function beginSelection(label) {
    const epoch = ++state.selectionEpoch;
    state.selected = null;
    state.selectionPending = label;
    renderSelection();
    return epoch;
  }

  async function selectFile(file) {
    if (!file) return;
    const epoch = beginSelection(file.name);
    if (file.size > 8 * 1024 * 1024) {
      setSelectionError('That file is larger than the 8 MB browser limit.', epoch);
      return;
    }
    try {
      const text = await file.text();
      if (epoch !== state.selectionEpoch) return;
      const bundle = JSON.parse(text);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      if (epoch !== state.selectionEpoch) return;
      const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      state.selectionPending = null;
      state.selected = {bundle, sha256, label: file.name, example: false};
      renderSelection();
    } catch (error) {
      if (epoch !== state.selectionEpoch) return;
      setSelectionError(`That file is not a readable JSON bundle (${error.message}).`, epoch);
    }
  }

  function setSelectionError(message, epoch = state.selectionEpoch) {
    if (epoch !== state.selectionEpoch) return;
    state.selected = null;
    state.selectionPending = null;
    const selection = $('selection');
    selection.className = 'selection';
    selection.textContent = message;
    setRunButton(true, 'Select a bundle to run');
  }

  async function loadExample() {
    const button = $('example-button');
    const epoch = beginSelection('the example bundle');
    button.disabled = true;
    button.textContent = 'Loading example…';
    try {
      const response = await fetch('/api/review/example', {headers: {'accept': 'application/json'}});
      const data = await response.json();
      if (epoch !== state.selectionEpoch) return;
      if (!response.ok) throw new Error(data.error || 'Could not load the example bundle.');
      state.selectionPending = null;
      state.selected = {bundle: data.bundle, sha256: data.sha256, label: data.label || data.filename, example: true};
      renderSelection();
    } catch (error) {
      if (epoch !== state.selectionEpoch) return;
      setSelectionError(error.message, epoch);
    } finally {
      button.disabled = false;
      button.textContent = 'Load example (recorded candidate)';
    }
  }

  function renderRunning(run) {
    show('running-state');
    const sourceBuild = (run.mode || modeValue()) === 'source-build';
    $('run-id').textContent = run.id;
    $('running-title').textContent = sourceBuild ? 'Building and replaying the supplied patch…' : 'Replaying the supplied candidate…';
    $('running-copy').textContent = sourceBuild
      ? 'The bundle was checked before the output directory was reserved. The patch is applied to pinned source, built with Rust 1.86, then replayed in the local Sandbox; no model is called.'
      : 'The bundle was checked before the replay directory was reserved. The candidate is executed against the local Sandbox; no model is called.';
    $('elapsed').textContent = duration(run.elapsedMs);
    $('phase-current').textContent = run.phase === 'accepting' ? 'Running the declared acceptance checks…' : sourceBuild ? 'Building the patch, then executing the recovery and retry…' : 'Executing the recorded recovery and retry…';
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
    const sourceBuild = (result?.run?.mode || s.mode || run.mode) === 'source-build';
    $('result-banner').className = `result-banner${accepted ? '' : ' bad'}`;
    $('result-banner').textContent = accepted
      ? (sourceBuild ? 'Review passed — the supplied patch built and met the declared checks.' : 'Review passed — the recorded candidate met the declared checks.')
      : 'Review did not pass — no accepted result is available.';
    $('result-copy').textContent = accepted
      ? (sourceBuild
        ? `Bundle file ${short(result.bundle?.sha256 || run.bundle?.sha256)} was built from its supplied patch and replayed. The result below is the measured outcome, not a cached report.`
        : `Bundle file ${short(result.bundle?.sha256 || run.bundle?.sha256)} was replayed from its supplied artifact. The result below is the measured outcome, not a cached report.`)
      : 'The candidate did not pass acceptance. Inspect the checks and the review output before trying another bundle.';
    const preserved = checks.preservedState === true && checks.preservedPolicy === true && checks.preservedProposal === true;
    const healthy = checks.healthyControl === true && checks.pendingHealthy === true;
    $('review-grid').innerHTML = [
      card('Mode', s.modeLabel || (sourceBuild ? 'Source build' : 'Recorded WASM replay'), sourceBuild ? 'Fresh build from the supplied patch, then local Sandbox replay.' : 'Supplied artifact, no source build and no model call.'),
      card(sourceBuild ? 'Built WASM' : 'Recorded artifact', short(s.candidateWasmSha256 || result.bundle?.candidate?.wasmSha256), sourceBuild ? 'Artifact produced by the build and exercised by the replay.' : 'Exact artifact exercised by the replay.', 'good'),
      card('First recovery', s.firstRecovery?.gross || '—', `${s.firstRecovery?.gas || '—'} gas · proposer net ${s.firstRecovery?.proposerNet || '—'}`, s.firstRecovery?.gross === '0 NEAR' ? 'bad' : 'good'),
      card('Retry', s.retry?.gross || '—', `${s.retry?.gas || '—'} gas · no additional principal`, s.retry?.gross === '0 NEAR' ? 'good' : 'bad'),
      card('Preserved state', preserved ? 'Yes' : 'No', 'Inherited state, policy and proposal remain present.', preserved ? 'good' : 'bad'),
      card('Authority', checks.authorityRejected ? 'Rejected' : 'Not checked', 'Unauthorized update and finalize attempts stay rejected.', checks.authorityRejected ? 'good' : 'bad'),
      card('Healthy controls', healthy ? 'Both pass' : 'Incomplete', 'Already-paid obligation and inherited pending Transfer.', healthy ? 'good' : 'bad'),
      card('Acceptance', accepted ? 'Pass' : 'Fail', 'Declared persisted-recovery acceptance receipt.', accepted ? 'good' : 'bad'),
    ].join('');
    $('meaning-note').textContent = sourceBuild
      ? 'This is a fresh source build from the supplied patch followed by a local Sandbox replay. It does not call a model, publish anything, or prove production safety.'
      : 'This is a recorded artifact replay. It shows the supplied candidate passed the declared local checks. It does not rebuild source, call a model, publish anything, or prove production safety.';
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
      ? `<a class="download-button" href="${esc(run.downloadUrl)}" download>Download result</a>${run.inputUrl ? `<a class="download-button secondary-download" href="${esc(run.inputUrl)}" download>Download input bundle</a>` : ''}${run.evidenceUrl ? `<a class="download-button secondary-download" href="${esc(run.evidenceUrl)}" download>Download evidence</a>` : ''}`
      : '<span class="download-button disabled" aria-disabled="true">Result download withheld</span>';
    $('result-json').textContent = JSON.stringify(result, null, 2);
    setStatus(accepted ? 'Review accepted' : 'Review not accepted', accepted ? 'accepted' : 'rejected');
    setRunButton(!modeReady() || !state.selected, !state.selected ? 'Select a bundle to run' : modeValue() === 'source-build' ? 'Run another source build' : 'Run another review');
  }

  function renderError(run) {
    show('error-state');
    $('error-title').textContent = run.status === 'interrupted' ? 'The review was interrupted.' : 'The review did not pass.';
    $('error-copy').textContent = run.error || 'No accepted result was produced.';
    $('error-log').textContent = (run.logs || []).slice(-40).join('\n') || 'No runner output was captured.';
    setStatus(run.status === 'interrupted' ? 'Review interrupted' : 'Review not accepted', run.status === 'interrupted' ? 'interrupted' : 'rejected');
    setRunButton(!modeReady() || !state.selected, !state.selected ? 'Select a bundle to run' : 'Try another bundle');
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
    const id = state.runId;
    const epoch = state.openEpoch;
    try {
      const response = await fetch(`/api/review/runs/${id}`, {headers: {'accept': 'application/json'}});
      if (epoch !== state.openEpoch || state.runId !== id) return;
      if (response.status === 404) throw new Error('That review run no longer exists.');
      const run = await response.json();
      if (epoch !== state.openEpoch || state.runId !== id) return;
      if (!response.ok) throw new Error(run.error || 'Could not read the review run.');
      state.failures = 0;
      renderRun(run);
      if (!terminal.has(run.status)) schedulePoll();
    } catch (error) {
      if (epoch !== state.openEpoch || state.runId !== id) return;
      state.failures += 1;
      if (state.failures >= 4) {
        renderError({status: 'interrupted', error: error.message, logs: []});
        return;
      }
      schedulePoll();
    }
  }

  async function startReview() {
    // One start at a time: the manager runs one review, so a second POST would
    // only be rejected while the first response is discarded as stale.
    if (state.submitting || runIsActive()) return;
    if (!state.selected) return;
    if (!modeReady()) {
      renderConfig();
      return;
    }
    const {bundle} = state.selected;
    const mode = modeValue();
    state.submitting = true;
    state.submitMode = mode;
    const epoch = ++state.openEpoch;
    paintRunButton();
    try {
      const response = await fetch('/api/review/runs', {
        method: 'POST',
        headers: {'content-type': 'application/json', 'accept': 'application/json'},
        body: JSON.stringify({bundle, mode}),
      });
      const data = await response.json();
      if (epoch !== state.openEpoch) return;
      if (!response.ok) throw new Error(data.error || 'Could not start the review.');
      state.failures = 0;
      renderRun(data.run);
      schedulePoll();
    } catch (error) {
      // A failure belongs to the navigation that issued it: if the reviewer
      // has since opened another run, this one must not replace it.
      if (epoch !== state.openEpoch) return;
      show('error-state');
      $('error-title').textContent = 'The review could not start.';
      $('error-copy').textContent = error.message;
      $('error-log').textContent = '';
      setStatus('Review not started', 'rejected');
    } finally {
      state.submitting = false;
      state.submitMode = null;
      paintRunButton();
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
    const epoch = ++state.openEpoch;
    try {
      const response = await fetch(`/api/review/runs/${id}`, {headers: {'accept': 'application/json'}});
      if (epoch !== state.openEpoch) return;
      const run = await response.json();
      if (epoch !== state.openEpoch) return;
      if (!response.ok) throw new Error(run.error || 'Could not read that review run.');
      state.runId = id;
      state.failures = 0;
      if (run.mode && state.config?.modes?.[run.mode]) {
        state.mode = run.mode;
        renderConfig();
      }
      renderRun(run);
      if (!terminal.has(run.status)) schedulePoll();
      await refreshHistory();
    } catch (error) {
      if (epoch !== state.openEpoch) return;
      show('error-state');
      $('error-title').textContent = 'That review could not be opened.';
      $('error-copy').textContent = error.message;
      $('error-log').textContent = '';
    }
  }

  for (const input of document.querySelectorAll('input[name="review-mode"]')) {
    input.addEventListener('change', () => {
      state.mode = input.value;
      renderConfig();
      renderSelection();
    });
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
  // Startup restoration is best-effort and must never override a reviewer's
  // explicit choice: any history open or new review bumps openEpoch, and the
  // delayed history response is then abandoned.
  const startupEpoch = state.openEpoch;
  refreshHistory().then(async () => {
    if (state.openEpoch !== startupEpoch) return;
    const response = await fetch('/api/review/runs', {headers: {'accept': 'application/json'}}).catch(() => null);
    if (state.openEpoch !== startupEpoch) return;
    if (!response?.ok) return;
    const data = await response.json().catch(() => null);
    if (state.openEpoch !== startupEpoch) return;
    const target = data?.active || data?.runs?.[0]?.id;
    if (target) openRun(target);
  });
})();
