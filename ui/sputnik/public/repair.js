(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = {case: null, config: null, run: null, poll: null, clock: null, failures: 0, historySignature: null, selectionVersion: 0, pollEpoch: 0, pollRequest: 0, pollLatest: 0};
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const short = (value, n = 12) => value ? `${String(value).slice(0, n)}…${String(value).slice(-6)}` : '—';
  const near = (value) => {
    if (value === null || value === undefined) return '—';
    const valueBig = BigInt(value); const negative = valueBig < 0n; const n = negative ? -valueBig : valueBig;
    const unit = 10n ** 24n;
    const whole = n / unit; const fraction = (n % unit).toString().padStart(24, '0').slice(0, 6).replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
  };
  const signed = (value) => `${BigInt(value) >= 0n ? '+' : ''}${near(value)}`;
  const phaseOrder = ['reproducing', 'generating', 'compiling', 'replaying', 'recovering'];
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

  function updateHistorySelection(list = $('history-list')) {
    for (const button of list.querySelectorAll('[data-run-id]')) {
      const selected = button.dataset.runId === state.run?.id;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-current', selected ? 'true' : 'false');
    }
  }

  async function loadHistory() {
    try {
      const response = await fetch('/api/repair/runs', {cache: 'no-store'});
      const data = await response.json();
      if (!response.ok) return;
      const list = $('history-list');
      const runs = data.runs || [];
      if (!runs.length) {
        if (state.historySignature !== '[]') list.innerHTML = '<p class="muted small">No previous repair runs.</p>';
        state.historySignature = '[]';
        return;
      }
      const signature = JSON.stringify(runs.map((run) => [run.id, run.status, run.phase, run.startedAt]));
      if (signature !== state.historySignature) {
        // A changed list is the only case that needs replacement. Preserve focus
        // on the same run when that item still exists after the update.
        const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.runId : null;
        list.innerHTML = runs.map((run) => `<button class="history-item" type="button" data-run-id="${esc(run.id)}" role="listitem"><b>${esc(statusLabel(run.status))} · ${esc(run.phase)}</b><small>${esc(new Date(run.startedAt).toLocaleString())} · ${esc(run.id)}</small></button>`).join('');
        for (const button of list.querySelectorAll('[data-run-id]')) button.addEventListener('click', () => openRun(button.dataset.runId));
        state.historySignature = signature;
        updateHistorySelection(list);
        if (focusedId) {
          const sameRun = [...list.querySelectorAll('[data-run-id]')].find((button) => button.dataset.runId === focusedId);
          if (sameRun) sameRun.focus({preventScroll: true});
        }
      } else {
        updateHistorySelection(list);
      }
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
    $('running-copy').textContent = 'Fresh baseline, one model attempt, build, local replay and a persisted-failure recovery exercise are running. The phase below is the actual current step.';
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
    const c = run.consequence || {};
    const baseline = c.baseline || {}; const candidate = c.candidate || {};
    const checks = run.checks || {};
    const recovery = run.recovery || null;
    const recoverySummary = recovery?.summary || {};
    const acceptedMoney = accepted && recovery?.ok === true;
    const frozenBond = recoverySummary.frozenLockedAmount || c.bond || run.obligation?.bond || '0';
    const firstGross = recoverySummary.firstGrossRecoveryYocto || '0';
    const firstGas = recoverySummary.firstGasYocto || '0';
    const firstNet = recoverySummary.firstProposerNetYocto || (BigInt(firstGross) - BigInt(firstGas)).toString();
    const secondGross = recoverySummary.secondGrossRecoveryYocto || '0';
    const secondGas = recoverySummary.secondGasYocto || '0';
    const healthyTransfer = c.transfer || run.obligation?.transfer || '0';
    const healthyPreserved = candidate.healthyPayoutUnchanged === true
      && recoverySummary.healthyControl === true
      && recoverySummary.pendingHealthy === true;
    $('result-copy').textContent = accepted
      ? 'The accepted result is measured on this run. The original proposal remains Failed while its bond debt is recovered; this is not a re-execution of the failed payment. Gas is reported separately from returned principal.'
      : (run.error || 'The run stopped before all declared checks passed.');
    if (acceptedMoney) {
      $('consequence-grid').innerHTML = `
        <article class="consequence-card good"><div class="eyebrow">Frozen bond</div><strong>${near(frozenBond)} NEAR</strong><p>Locked against the failed proposal, which remains Failed. The debt is recovered; the failed payment is not replayed.</p></article>
        <article class="consequence-card good"><div class="eyebrow">First recovery</div><strong>${signed(firstGross)} NEAR gross</strong><p>${near(firstGas)} NEAR gas · ${signed(firstNet)} NEAR proposer net.</p></article>
        <article class="consequence-card ${BigInt(secondGross) === 0n ? 'good' : 'bad'}"><div class="eyebrow">Retry</div><strong>${BigInt(secondGross) === 0n ? '0 NEAR extra principal' : `${signed(secondGross)} NEAR extra principal`}</strong><p>${near(secondGas)} NEAR gas · ${BigInt(secondGross) === 0n ? 'no second bond credit.' : 'a second bond credit is a failure.'}</p></article>
        <article class="consequence-card ${healthyPreserved ? 'good' : 'bad'}"><div class="eyebrow">Healthy obligations</div><strong>${near(healthyTransfer)} NEAR</strong><p>${healthyPreserved ? 'Declared Transfer and inherited pending Transfer preserved.' : 'The healthy obligation controls did not all pass.'}</p></article>`;
      $('money-note').innerHTML = `
        <div><b>Accounting:</b> gross bond, transaction gas and proposer net are separate values from the accepted result.</div>
        <div><b>Proposal state:</b> remains Failed; this recovery clears the bond debt, not the original failed payment.</div>`;
    } else {
      const retryGas = candidate.retryGas ? near(candidate.retryGas) : '—';
      const retryBacked = checks.authorizedRetryNoSecondRefund === true;
      const baselineCopy = baseline.bondRetained
        ? 'Contract balance change after the failed proposal. The declared bond stayed in the contract; the recipient received nothing.'
        : 'Contract balance change after the failed proposal. The declared bond was not retained in this capture; the recipient received nothing.';
      const candidateCopy = candidate.bondReturned
        ? 'Contract balance change after the same failure. The bond is no longer retained; the failed recipient still receives nothing.'
        : 'Contract balance change after the same failure. The bond is still retained in the contract, so this candidate did not repair the failure.';
      const healthyCopy = candidate.healthyPayoutUnchanged
        ? 'The healthy Transfer still pays the declared recipient; this is the control obligation.'
        : 'The healthy Transfer payout changed, so this candidate breaks the control obligation.';
      $('consequence-grid').innerHTML = `
        <article class="consequence-card ${baseline.bondRetained ? 'bad' : ''}"><div class="eyebrow">Baseline</div><strong>${signed(baseline.failedContract || 0)} NEAR</strong><p>${baselineCopy}</p></article>
        <article class="consequence-card ${candidate.bondReturned ? 'good' : 'bad'}"><div class="eyebrow">Generated candidate</div><strong>${signed(candidate.failedContract || 0)} NEAR</strong><p>${candidateCopy}</p></article>
        <article class="consequence-card ${retryBacked ? 'good' : 'bad'}"><div class="eyebrow">Authorized retry</div><strong>${retryBacked ? 'No second refund' : 'Retry not clean'}</strong><p>${retryBacked ? 'FINAL receipt; contract and recipient deltas are zero. Gas is separate.' : 'The retry check did not prove FINAL receipt-backed exactly-once execution.'}</p></article>
        <article class="consequence-card ${candidate.healthyPayoutUnchanged ? 'good' : 'bad'}"><div class="eyebrow">Healthy payout</div><strong>${signed(candidate.healthyRecipient || 0)} NEAR</strong><p>${healthyCopy}</p></article>`;
      $('money-note').innerHTML = `
        <div><b>Principal:</b> 1 NEAR bond at risk; 0.1 NEAR healthy Transfer.</div>
        <div><b>Gas on retry:</b> ${esc(retryGas)} NEAR, separate from returned principal.</div>`;
    }
    const identityRows = [
      ['Execution', 'fresh local repair; provider generation and Sandbox replay'],
      ['Source revision', run.source?.commit || '—'],
      ['Source path', run.source?.path || '—'],
      ['Generated patch', run.patch?.sha256 ? short(run.patch.sha256, 20) : '—'],
      ['Candidate WASM', run.candidate?.wasm?.sha256 ? short(run.candidate.wasm.sha256, 20) : '—'],
    ];
    $('repair-identity-grid').innerHTML = identityRows.map(([label, value]) => `<div class="kv"><span>${esc(label)}</span><b class="mono">${esc(value)}</b></div>`).join('');
    const recoveryPanel = $('recovery-panel');
    recoveryPanel.hidden = !recovery;
    if (recovery) {
      const summary = recovery.summary || {};
      const firstGross = summary.firstGrossRecoveryYocto || '0';
      const secondGross = summary.secondGrossRecoveryYocto || '0';
      const unpaid = BigInt(summary.failedRecipientDelta || 0) === 0n;
      $('recovery-badge').textContent = recovery.ok ? 'Accepted persisted recovery' : (recovery.status || 'Not accepted');
      $('recovery-copy').textContent = recovery.ok
        ? 'The same candidate was applied to an already-failed proposal without calling the initializer. The frozen proposal, policy and locked bond survived the code change; the authorized finalize recovered the bond once; the failed target was not paid.'
        : (recovery.error || 'The persisted recovery exercise did not pass its independent acceptance.');
      $('recovery-grid').innerHTML = `
        <article class="consequence-card ${recovery.ok ? 'good' : 'bad'}"><div class="eyebrow">Bond recovered</div><strong>${signed(firstGross)} NEAR</strong><p>Gross proposer credit reconciled from the frozen snapshots and receipt-derived gas, not only from the cleared liability.</p></article>
        <article class="consequence-card ${BigInt(secondGross) === 0n ? 'good' : 'bad'}"><div class="eyebrow">Second retry</div><strong>${BigInt(secondGross) === 0n ? 'Zero recovery' : signed(secondGross) + ' NEAR'}</strong><p>${BigInt(secondGross) === 0n ? 'A second authorized finalize produced no second bond credit; only gas moved.' : 'A second retry produced another bond credit, so exactly-once recovery is not proven.'}</p></article>
        <article class="consequence-card ${unpaid ? 'good' : 'bad'}"><div class="eyebrow">Failed target</div><strong>${unpaid ? 'Unpaid' : 'Paid'}</strong><p>${unpaid ? 'The missing target received nothing; the original downstream failure was preserved.' : 'The failed target received funds during recovery.'}</p></article>`;
      $('recovery-checks').innerHTML = [
        check('Frozen state preserved', summary.preservedState && summary.preservedPolicy && summary.preservedProposal, 'raw state, policy and proposal compared across code replacement'),
        check('Authority probes executed', summary.authorityRejected, 'rejected update and finalize probes reached FINAL with expected errors'),
        check('First recovery FINAL', summary.firstFinal === 'FINAL' && firstGross === c.bond, 'gross credit and locked delta reconciled to the bond'),
        check('Second retry FINAL', summary.secondFinal === 'FINAL' && BigInt(secondGross) === 0n, 'no second refund; proposal ended Failed'),
        check('Healthy control preserved', summary.healthyControl, 'past-settled payout remained unchanged'),
        check('Inherited pending Transfer paid once', summary.pendingHealthy, 'old-code pending proposal paid after upgrade with bond separated'),
      ].join('');
    }
    $('checks-list').innerHTML = [
      check('Baseline bond retained', checks.baselineBondRetained, `baseline contract ${signed(baseline.failedContract || 0)} NEAR`),
      check('Candidate bond returned', checks.candidateBondReturned, `candidate contract ${signed(candidate.failedContract || 0)} NEAR`),
      check('Authorized retry: no second refund', checks.authorizedRetryNoSecondRefund, 'FINAL receipt; zero contract and recipient delta'),
      check('Healthy payout unchanged', checks.healthyPayoutUnchanged, `${signed(candidate.healthyRecipient || 0)} NEAR recipient`),
      check('Same frozen starting state', checks.baseAndCandidateStartSameState, 'baseline and candidate healthy before-state'),
      check('Persisted recovery accepted', checks.recoveryAccepted, 'old-code failure, code replacement and exactly-once accounting'),
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
    const handoff = $('review-handoff');
    handoff.hidden = !accepted;
    if (accepted) {
      $('handoff-command').textContent = `npm run repair:review -- --bundle repair-bundle-${run.id}.json --out /tmp/repair-review-${run.id} --mode recorded-wasm`;
    }
    $('evidence-json').textContent = JSON.stringify(run.evidence || {message: 'No replay evidence for this run.'}, null, 2);
    $('evidence-label').textContent = accepted ? 'Accepted' : statusLabel(run.status);
    $('running-state').hidden = true;
    setStatus(statusLabel(run.status), accepted ? 'accepted' : (run.status === 'rejected' ? 'rejected' : 'inconclusive'));
    setButton(false);
  }

  function renderError(run) {
    show('error-state');
    $('review-handoff').hidden = true;
    $('error-title').textContent = `${statusLabel(run.status)} — no accepted result`;
    $('error-copy').textContent = run.error || 'The repair did not produce an accepted result.';
    $('error-log').textContent = (run.logs || []).slice(-40).join('\n') || 'No runner output was captured.';
    const patch = run.patch;
    $('error-patch').hidden = !patch;
    if (patch) {
      $('error-patch-meta').textContent = `${short(patch.sha256, 12)} · ${patch.bytes} bytes`;
      $('error-diff').textContent = patch.text;
      $('error-downloads').innerHTML = run.patchUrl ? `<a class="download-button" href="${esc(run.patchUrl)}" download>Download generated patch</a>` : '';
    } else {
      $('error-diff').textContent = '';
      $('error-downloads').innerHTML = '';
    }
    setStatus(statusLabel(run.status), run.status === 'rejected' ? 'rejected' : 'inconclusive');
    setButton(false);
  }

  function renderRun(run) {
    state.run = run;
    if (run.status === 'running') { renderRunning(run); return; }
    if (run.status === 'accepted' || (run.status === 'rejected' && run.consequence)) { renderResult(run); return; }
    renderError(run);
  }

  function startPoll() {
    stopPoll();
    state.poll = setInterval(poll, 1000);
    state.clock = setInterval(() => { if (state.run?.status === 'running') $('elapsed').textContent = elapsed(state.run); }, 1000);
  }

  function stopPoll() {
    clearInterval(state.poll); clearInterval(state.clock);
    state.poll = null; state.clock = null;
    state.pollEpoch += 1;
  }

  function selectionCurrent(version, runId = null) {
    return version === state.selectionVersion && (!runId || state.run?.id === runId);
  }

  async function poll() {
    const runId = state.run?.id;
    if (!runId) return;
    const version = state.selectionVersion;
    const epoch = state.pollEpoch;
    const requestId = ++state.pollRequest;
    state.pollLatest = requestId;
    const current = () => selectionCurrent(version, runId) && epoch === state.pollEpoch;
    try {
      const response = await fetch(`/api/repair/runs/${runId}`, {cache: 'no-store'});
      if (!current()) return;
      if (!response.ok) {
        if (requestId < state.pollLatest) return;
        state.failures += 1;
        if (state.failures >= 3) throw new Error('Run state is unavailable; the server may have restarted. This run is interrupted, not accepted.');
        return;
      }
      state.failures = 0;
      const run = await response.json();
      if (!current()) return;
      if (terminal.has(run.status)) {
        // A terminal response wins even if it is older than another request
        // that is still in flight. Bumping the epoch makes that request inert.
        state.run = run;
        stopPoll();
        renderRun(run); loadHistory();
        return;
      }
      if (requestId < state.pollLatest) return;
      state.run = run;
      renderRunning(run); loadHistory();
    } catch (error) {
      if (!current() || requestId < state.pollLatest) return;
      stopPoll();
      state.run = {...state.run, status: 'interrupted', error: error.message};
      renderError(state.run);
    }
  }

  async function openRun(id) {
    const version = ++state.selectionVersion;
    stopPoll();
    try {
      const response = await fetch(`/api/repair/runs/${id}`, {cache: 'no-store'});
      const run = await response.json();
      if (!selectionCurrent(version)) return;
      if (!response.ok) throw new Error(run.error || 'Repair run not found.');
      state.run = run; state.failures = 0;
      updateHistorySelection();
      if (run.status === 'running') { renderRunning(run); startPoll(); }
      else renderRun(run);
    } catch (error) {
      if (!selectionCurrent(version)) return;
      $('error-title').textContent = 'Could not load that run';
      $('error-copy').textContent = error.message;
      show('error-state'); setStatus('Run unavailable', 'error');
    }
  }

  async function startRun() {
    if (!state.case || state.run?.status === 'running') return;
    const version = ++state.selectionVersion;
    stopPoll();
    setButton(true); setStatus('Starting / fresh run', 'running');
    try {
      const response = await fetch('/api/repair/run', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({caseId: state.case.id})});
      const data = await response.json();
      if (!selectionCurrent(version)) return;
      if (!response.ok) throw new Error(data.error || 'Could not start repair.');
      state.run = data.run; state.failures = 0;
      updateHistorySelection();
      $('logs').textContent = 'Waiting for the run to report its first phase…';
      renderRunning(state.run); startPoll(); loadHistory();
    } catch (error) {
      if (!selectionCurrent(version)) return;
      setButton(false);
      $('error-title').textContent = 'Could not start the repair';
      $('error-copy').textContent = error.message;
      show('error-state'); setStatus('Run rejected', 'error');
    }
  }

  $('run-button').addEventListener('click', startRun);
  $('retry-button').addEventListener('click', () => { state.selectionVersion += 1; stopPoll(); show('empty-state'); state.run = null; setStatus('No repair run yet'); loadHistory(); });
  $('case-choice').addEventListener('change', () => { state.selectionVersion += 1; stopPoll(); state.run = null; show('empty-state'); });
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
