(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = {case: null, config: null, run: null, poll: null, clock: null, failures: 0};
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const short = (value, n = 12) => value ? `${String(value).slice(0, n)}…${String(value).slice(-6)}` : '—';
  const near = (value) => {
    if (value === null || value === undefined) return '—';
    const n = BigInt(value); const unit = 10n ** 24n;
    const whole = n / unit; const fraction = (n % unit).toString().padStart(24, '0').slice(0, 6).replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''}`;
  };
  const signed = (value) => `${BigInt(value) >= 0n ? '+' : ''}${near(value)}`;
  const phaseOrder = ['reproducing', 'generating', 'compiling', 'replaying'];
  const terminal = new Set(['accepted', 'rejected', 'inconclusive', 'interrupted']);
  const statusLabel = (status) => ({accepted: 'Accepted', rejected: 'Rejected', inconclusive: 'Inconclusive', interrupted: 'Interrupted'}[status] || status);
  const setStatus = (text, kind = 'idle') => { const el = $('status'); el.textContent = text; el.className = `status-pill ${kind}`; };
  const setButton = (disabled) => { $('run-button').disabled = disabled; $('run-button').textContent = disabled ? 'Repair already running' : 'Run fresh repair'; $('run-button').setAttribute('aria-busy', String(disabled)); };
  const show = (id) => { for (const key of ['empty-state', 'running-state', 'error-state', 'result-state']) $(key).hidden = key !== id; };

  function elapsed(run) {
    if (!run?.startedAt) return '00:00';
    const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
    const ms = Math.max(0, end - Date.parse(run.startedAt));
    const seconds = Math.floor(ms / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function renderContext() {
    if (!state.case) return;
    const c = state.case;
    const source = c.source;
    const o = c.obligation;
    $('source-context').innerHTML = `
      <div><span>Source</span><b>${esc(source.repository)}</b></div>
      <div><span>Revision</span><b class="mono">${esc(source.commit)}</b></div>
      <div><span>File</span><b class="mono">${esc(source.path)}</b></div>`;
    $('obligation-context').innerHTML = `
      <div class="row"><span>Failed obligation</span><b>${esc(o.failedAction)} · proposal ${esc(o.failedProposalId)}</b></div>
      <div class="row"><span>Bond at risk</span><b class="amount">${esc(o.bondNear)} NEAR</b></div>
      <div class="row"><span>Healthy Transfer</span><b>${esc(o.transferNear)} NEAR → ${esc(o.recipient)}</b></div>
      <div class="row"><span>Proposer</span><b class="mono">${esc(o.proposer)}</b></div>`;
    $('boundary-copy').textContent = c.boundary;
    $('case-meta').className = 'meta ready';
    $('case-meta').textContent = `${c.label}. ${c.description}`;
    const provider = $('provider-note');
    if (state.config?.providerConfigured && state.config?.configured) {
      provider.className = 'notice provider-ok';
      provider.textContent = 'Server-side model, source and Sandbox configuration are present. The browser sends only the supported case ID.';
    } else {
      provider.className = 'notice provider-bad';
      const missing = state.config?.missing?.length ? state.config.missing.join(', ') : 'local provider configuration';
      provider.textContent = `This server is not fully configured (${missing}). A run will show the unavailable-provider path; no credentials are entered in the browser.`;
    }
  }

  async function loadCase() {
    const response = await fetch('/api/repair/case', {cache: 'no-store'});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load the supported repair case.');
    state.case = data.case; state.config = data;
    renderContext(); setButton(false);
  }

  async function loadHistory() {
    try {
      const response = await fetch('/api/repair/runs', {cache: 'no-store'});
      const data = await response.json();
      if (!response.ok) return;
      const list = $('history-list');
      if (!data.runs?.length) { list.innerHTML = '<p class="muted small">No previous repair runs.</p>'; return; }
      list.innerHTML = data.runs.map((run) => `<button class="history-item" type="button" data-run-id="${esc(run.id)}" role="listitem"><b>${esc(statusLabel(run.status))} · ${esc(run.phase)}</b><small>${esc(new Date(run.startedAt).toLocaleString())} · ${esc(run.id)}</small></button>`).join('');
      for (const button of list.querySelectorAll('[data-run-id]')) button.addEventListener('click', () => openRun(button.dataset.runId));
      if (data.active && !state.run) openRun(data.active);
    } catch { /* history is supplementary */ }
  }

  function renderPhases(run) {
    const current = phaseOrder.indexOf(run.phase);
    for (const item of $('phase-list').querySelectorAll('[data-phase]')) {
      const phase = item.dataset.phase;
      const at = phaseOrder.indexOf(phase);
      item.classList.toggle('active', run.status === 'running' && phase === run.phase);
      item.classList.toggle('done', run.status === 'accepted' ? true : (terminal.has(run.status) ? at < current : at < current));
      item.classList.toggle('failed', terminal.has(run.status) && run.status !== 'accepted' && phase === run.phase);
    }
  }

  function renderRunning(run) {
    show('running-state');
    $('running-title').textContent = `Repairing ${run.caseId}`;
    $('running-copy').textContent = 'Fresh baseline, one model attempt, build and local replay are running. The phase below is the actual current step.';
    $('phase-current').textContent = `${run.phase[0].toUpperCase() + run.phase.slice(1)} — ${run.status === 'running' ? 'in progress' : statusLabel(run.status)}`;
    $('elapsed').textContent = elapsed(run);
    $('run-id').textContent = short(run.id, 8);
    $('logs').textContent = (run.logs || []).slice(-30).join('\n') || 'Waiting for the step…';
    $('logs').scrollTop = $('logs').scrollHeight;
    renderPhases(run);
    setStatus(`${run.status === 'running' ? run.phase : statusLabel(run.status)} / local repair`, run.status === 'running' ? 'running' : 'error');
    setButton(true);
  }

  function check(label, ok, detail = '') {
    return `<li><span class="check-mark ${ok ? '' : 'bad'}" aria-hidden="true">${ok ? '✓' : '✕'}</span><span><b>${esc(label)}</b>${detail ? `<br><small>${esc(detail)}</small>` : ''}</span></li>`;
  }

  function renderResult(run) {
    show('result-state');
    const accepted = run.status === 'accepted';
    $('result-banner').className = `result-banner ${accepted ? 'ok' : 'bad'}`;
    $('result-banner').textContent = accepted
      ? 'Accepted reproduction: the declared repair checks passed.'
      : `${statusLabel(run.status)}: this run is not accepted evidence.`;
    $('result-copy').textContent = accepted
      ? 'The failed async proposal no longer strands the bond. The authorized retry returns no second refund, and the healthy Transfer payout is unchanged. Gas is reported separately from returned principal.'
      : (run.error || 'The run stopped before all declared checks passed.');
    const c = run.consequence || {};
    const baseline = c.baseline || {}; const candidate = c.candidate || {};
    const retryGas = candidate.retryGas ? near(candidate.retryGas) : '—';
    $('consequence-grid').innerHTML = `
      <article class="consequence-card ${baseline.bondRetained ? 'bad' : ''}"><div class="eyebrow">Baseline</div><strong>${signed(baseline.failedContract || 0)} NEAR</strong><p>Contract balance after the failed proposal. The 1 NEAR bond stayed in the contract; the recipient received nothing.</p></article>
      <article class="consequence-card ${candidate.bondReturned ? 'good' : 'bad'}"><div class="eyebrow">Generated candidate</div><strong>${signed(candidate.failedContract || 0)} NEAR</strong><p>Contract balance after the same failure. The bond is no longer retained; the failed recipient still receives nothing.</p></article>
      <article class="consequence-card ${candidate.retryNoSecondRefund ? 'good' : 'bad'}"><div class="eyebrow">Authorized retry</div><strong>${candidate.retryNoSecondRefund ? 'No second refund' : 'Retry not clean'}</strong><p>${candidate.retryNoSecondRefund ? 'FINAL receipt; contract and recipient deltas are zero. Gas is separate.' : 'The retry check did not prove exactly-once behavior.'}</p></article>
      <article class="consequence-card ${candidate.healthyPayoutUnchanged ? 'good' : 'bad'}"><div class="eyebrow">Healthy payout</div><strong>${signed(candidate.healthyRecipient || 0)} NEAR</strong><p>The healthy Transfer still pays the declared 0.1 NEAR recipient; this is the control obligation.</p></article>`;
    $('money-note').innerHTML = `
      <div><b>Principal:</b> 1 NEAR bond at risk; 0.1 NEAR healthy Transfer.</div>
      <div><b>Gas on retry:</b> ${esc(retryGas)} NEAR, separate from returned principal.</div>`;
    const checks = run.checks || {};
    $('checks-list').innerHTML = [
      check('Baseline bond retained', checks.baselineBondRetained, `baseline contract ${signed(baseline.failedContract || 0)} NEAR`),
      check('Candidate bond returned', checks.candidateBondReturned, `candidate contract ${signed(candidate.failedContract || 0)} NEAR`),
      check('Authorized retry: no second refund', checks.authorizedRetryNoSecondRefund, 'FINAL receipt; zero contract and recipient delta'),
      check('Healthy payout unchanged', checks.healthyPayoutUnchanged, `${signed(candidate.healthyRecipient || 0)} NEAR recipient`),
      check('Same frozen starting state', checks.baseAndCandidateStartSameState, 'baseline and candidate healthy before-state'),
    ].join('');
    $('acceptance-boundary').textContent = accepted
      ? 'Accepted means this supported local reproduction passed the declared checks. It is not a production approval, an audit, or a claim about a live DAO.'
      : 'No accepted bundle is offered for this run. The patch and diagnostics remain available only if a canonical patch was generated.';
    const patch = run.patch;
    $('source-diff').textContent = patch?.text || 'No generated patch is available for this run.';
    $('patch-meta').textContent = patch ? `${esc(short(patch.sha256, 12))} · ${esc(patch.bytes)} bytes` : 'No patch';
    const downloads = [];
    if (run.patchUrl) downloads.push(`<a class="download-button" href="${esc(run.patchUrl)}" download>Download generated patch</a>`);
    if (run.bundleUrl) downloads.push(`<a class="download-button secondary-download" href="${esc(run.bundleUrl)}" download>Download review bundle</a>`);
    if (!accepted) downloads.push('<span class="muted small">Review bundle is withheld until an accepted run.</span>');
    $('downloads').innerHTML = downloads.join('');
    $('evidence-json').textContent = JSON.stringify(run.evidence || {message: 'No replay evidence for this run.'}, null, 2);
    $('evidence-label').textContent = accepted ? 'Accepted' : statusLabel(run.status);
    $('running-state').hidden = true;
    setStatus(statusLabel(run.status), accepted ? 'accepted' : (run.status === 'rejected' ? 'rejected' : 'inconclusive'));
    setButton(false);
  }

  function renderError(run) {
    show('error-state');
    $('error-title').textContent = `${statusLabel(run.status)} — no accepted result`;
    $('error-copy').textContent = run.error || 'The repair did not produce an accepted result.';
    $('error-log').textContent = (run.logs || []).slice(-40).join('\n') || 'No runner output was captured.';
    setStatus(statusLabel(run.status), run.status === 'rejected' ? 'rejected' : 'inconclusive');
    setButton(false);
  }

  function renderRun(run) {
    state.run = run;
    if (run.status === 'running') { renderRunning(run); return; }
    if (run.status === 'accepted' || run.status === 'rejected' || run.consequence || run.patch) { renderResult(run); return; }
    renderError(run);
  }

  function startPoll() {
    clearInterval(state.poll); clearInterval(state.clock);
    state.poll = setInterval(poll, 1000);
    state.clock = setInterval(() => { if (state.run?.status === 'running') $('elapsed').textContent = elapsed(state.run); }, 1000);
  }

  async function poll() {
    if (!state.run?.id) return;
    try {
      const response = await fetch(`/api/repair/runs/${state.run.id}`, {cache: 'no-store'});
      if (!response.ok) {
        state.failures += 1;
        if (state.failures >= 3) throw new Error('Run state is unavailable; the server may have restarted. This run is interrupted, not accepted.');
        return;
      }
      state.failures = 0;
      const run = await response.json();
      state.run = run;
      if (run.status === 'running') { renderRunning(run); loadHistory(); return; }
      clearInterval(state.poll); clearInterval(state.clock);
      renderRun(run); loadHistory();
    } catch (error) {
      clearInterval(state.poll); clearInterval(state.clock);
      state.run = {...state.run, status: 'interrupted', error: error.message};
      renderError(state.run);
    }
  }

  async function openRun(id) {
    try {
      const response = await fetch(`/api/repair/runs/${id}`, {cache: 'no-store'});
      const run = await response.json();
      if (!response.ok) throw new Error(run.error || 'Repair run not found.');
      state.run = run; state.failures = 0;
      if (run.status === 'running') { renderRunning(run); startPoll(); }
      else renderRun(run);
    } catch (error) {
      $('error-title').textContent = 'Could not load that run';
      $('error-copy').textContent = error.message;
      show('error-state'); setStatus('Run unavailable', 'error');
    }
  }

  async function startRun() {
    if (!state.case || state.run?.status === 'running') return;
    setButton(true); setStatus('Starting / fresh run', 'running');
    try {
      const response = await fetch('/api/repair/run', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({caseId: state.case.id})});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not start repair.');
      state.run = data.run; state.failures = 0;
      $('logs').textContent = 'Waiting for the run to report its first phase…';
      renderRunning(state.run); startPoll(); loadHistory();
    } catch (error) {
      setButton(false);
      $('error-title').textContent = 'Could not start the repair';
      $('error-copy').textContent = error.message;
      show('error-state'); setStatus('Run rejected', 'error');
    }
  }

  $('run-button').addEventListener('click', startRun);
  $('retry-button').addEventListener('click', () => { show('empty-state'); state.run = null; setStatus('No repair run yet'); loadHistory(); });
  $('case-choice').addEventListener('change', () => { state.run = null; show('empty-state'); });
  (async () => {
    try {
      await loadCase();
      await loadHistory();
    } catch (error) {
      $('case-meta').className = 'meta bad';
      $('case-meta').textContent = error.message;
      $('error-title').textContent = 'Supported case unavailable';
      $('error-copy').textContent = error.message;
      show('error-state');
    }
  })();
})();
