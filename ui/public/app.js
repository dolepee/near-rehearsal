(() => {
  'use strict';

  const state = {
    run: null,
    focus: 'bad',
    detailBranch: 'bad',
    tab: 'receipt',
    poll: null,
    clock: null,
  };

  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const short = (value, size = 10) => value ? `${String(value).slice(0, size)}…${String(value).slice(-6)}` : '—';
  const num = (value) => value === null || value === undefined ? null : BigInt(value);
  const near = (value) => {
    if (value === null || value === undefined) return '—';
    const n = BigInt(value);
    const whole = n / 1000000000000000000000000n;
    const fraction = (n % 1000000000000000000000000n).toString().padStart(24, '0').slice(0, 6).replace(/0+$/, '');
    return `${whole.toString()}${fraction ? `.${fraction}` : ''}`;
  };
  const pct = (value) => value === null || value === undefined ? '—' : `${(Number(value) / 1e24).toFixed(6)} NEAR`;
  const branchStatus = (branch) => {
    if (!branch) return ['Unknown', ''];
    if (branch.status === 'completed') return ['Payout', 'good'];
    if (branch.status === 'expected-failure') return ['No payout', 'bad'];
    if (branch.status === 'inconclusive') return ['Inconclusive', 'bad'];
    return ['Error', 'bad'];
  };
  const branchName = (name) => ({baseline: 'Baseline', bad: 'Seeded bad', corrected: 'Corrected'}[name] || name);

  function setStatus(text, kind = 'idle') {
    const el = $('global-status');
    el.textContent = text;
    el.className = `status-pill ${kind}`;
  }

  function show(id) {
    for (const key of ['empty-state', 'running-state', 'error-state', 'result-state']) {
      const el = $(key);
      if (el) el.hidden = key !== id;
    }
  }

  function elapsedText() {
    if (!state.run || state.run.status !== 'running') return '00:00';
    const start = Date.parse(state.run.startedAt || new Date().toISOString());
    const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  function renderRunning() {
    $('running-title').textContent = elapsedText() === '00:00' ? 'Starting three-way rehearsal…' : 'Running baseline, bad, and corrected…';
    $('running-copy').textContent = 'The actual runner is executing local Sandbox transactions. The result is not shown until the runner writes a new report.';
    $('elapsed').textContent = elapsedText();
    $('run-id').textContent = state.run?.id ? short(state.run.id, 8) : '';
    const logs = state.run?.logs || [];
    $('log-output').textContent = logs.length ? logs.slice(-22).join('\n') : 'Waiting for the runner…';
    $('log-output').scrollTop = $('log-output').scrollHeight;
    $('run-button').disabled = true;
    $('rerun-button').hidden = true;
    setStatus('Running / local Sandbox', 'running');
  }

  function renderError() {
    $('error-copy').textContent = state.run?.error || 'The runner exited without producing a new result.';
    $('error-log').textContent = (state.run?.logs || []).slice(-30).join('\n') || 'No runner output.';
    $('run-button').disabled = false;
    $('rerun-button').hidden = true;
    setStatus('Rehearsal error', 'error');
    show('error-state');
  }

  function branchSummary(branch, name, isFocus, isDetail) {
    const [status, tone] = branchStatus(branch);
    const transfer = branch?.transfer?.linked ? 'beneficiary link' : 'no link';
    const before = branch?.entitlement?.beforeMigration;
    const afterMigration = branch?.entitlement?.afterMigration;
    const afterClaim = branch?.entitlement?.afterClaim;
    const userDelta = branch?.balances?.user?.delta;
    const tx = branch?.claim?.transactionHash;
    const controlLabel = branch?.controls?.outsiderDenied ? 'controls pass' : 'controls not run';
    return `<article class="branch-card ${tone === 'bad' ? 'bad-card' : 'good-card'} ${isFocus ? 'focus' : ''} ${isDetail ? 'detail' : ''}" data-branch="${escape(name)}">
      <div class="branch-name"><strong>${escape(branchName(name))}</strong><span class="branch-status ${tone}">${escape(status)}</span></div>
      <div class="branch-kicker">${escape(name === 'baseline' ? 'claim_refund() — no candidate' : name === 'bad' ? 'seeded-bad-v2 + migrate()' : 'corrected-v2 + migrate()')}</div>
      <div class="branch-mini">
        <div><span>Entitlement before</span><b>${escape(near(before))} NEAR</b></div>
        <div><span>After migration</span><b>${escape(near(afterMigration))} NEAR</b></div>
        <div><span>After claim</span><b>${escape(near(afterClaim))} NEAR</b></div>
        <div><span>User net</span><b>${userDelta ? (BigInt(userDelta) > 0n ? '+' : '') + near(userDelta) + ' NEAR' : 'interim / —'}</b></div>
        <div><span>Transfer</span><b>${escape(transfer)}</b></div>
        <div><span>${escape(controlLabel)}</span><b>${branch?.balances?.status === 'interim' ? 'balance interim' : 'balance final'}</b></div>
      </div>
      <div class="branch-tx">tx ${escape(short(tx, 12))}</div>
    </article>`;
  }

  function renderResult() {
    const report = state.run?.report;
    if (!report) { renderError(); return; }
    const complete = report.result?.status === 'complete';
    const bad = report.branches?.bad;
    const corrected = report.branches?.corrected;
    const baseline = report.branches?.baseline;
    const focus = state.focus === 'corrected' ? corrected : bad;
    const focusName = state.focus === 'corrected' ? 'corrected' : 'bad';

    $('result-banner').className = `result-banner ${complete ? 'ok' : 'bad'}`;
    $('result-banner').textContent = complete
      ? 'New run complete. Fixed capture, runtime pin, controls, structured bad failure, and beneficiary-linked payouts all passed.'
      : 'Run incomplete. This is not release evidence; inspect the failed gate and raw report below.';

    const badBlocked = bad?.status === 'expected-failure' && bad?.transfer?.linked === false;
    const goodPaid = corrected?.status === 'completed' && corrected?.transfer?.linked === true;
    const focusIsBad = focusName === 'bad';
    $('outcome-title').textContent = focusIsBad
      ? (badBlocked ? 'The migration removes the existing user’s refund.' : 'The seeded bad result is not a verified NO_REFUND.')
      : (goodPaid ? 'The correction restores the existing user’s refund.' : 'The corrected result is not a verified payout.');
    $('outcome-badge').textContent = focusIsBad ? (badBlocked ? 'NO_REFUND / no payout' : 'UNVERIFIED') : (goodPaid ? 'BENEFICIARY PAID' : 'UNVERIFIED');
    $('outcome-badge').className = `badge ${focusIsBad ? (badBlocked ? 'bad' : 'subtle') : (goodPaid ? 'good' : 'subtle')}`;
    $('outcome-copy').textContent = focusIsBad
      ? 'The seeded migration clears the stored entitlement before the same existing-user claim. The claim fails with a structured NO_REFUND and there is no contract-to-beneficiary transfer link. The funds stay in the contract; this is an authored local-Sandbox example, not a public incident.'
      : 'The corrected migration preserves the stored entitlement. The same claim succeeds and the contract receipt’s SuccessReceiptId links to a SuccessValue receipt executed by the captured beneficiary. The gross entitlement and net balance are shown separately.';

    const before = focus?.entitlement?.beforeMigration;
    const afterMigration = focus?.entitlement?.afterMigration;
    const afterClaim = focus?.entitlement?.afterClaim;
    const link = focus?.transfer?.linked === true;
    $('outcome-stats').innerHTML = `
      <div class="stat"><span class="stat-label">Refund entitlement before</span><div class="stat-value">${escape(near(before))} NEAR</div></div>
      <div class="stat"><span class="stat-label">After migration</span><div class="stat-value ${focusIsBad && afterMigration === '0' ? 'bad' : 'good'}">${escape(near(afterMigration))} NEAR</div></div>
      <div class="stat"><span class="stat-label">Claim result</span><div class="stat-value ${focusIsBad ? 'bad' : 'good'}">${focusIsBad ? 'NO_REFUND' : 'PAID'}</div></div>
      <div class="stat"><span class="stat-label">Beneficiary transfer link</span><div class="stat-value ${link ? 'good' : 'bad'}">${link ? 'linked' : 'not present'}</div></div>`;
    $('outcome-foot').textContent = focusIsBad
      ? `Baseline is ${baseline?.status || 'unknown'}; corrected is ${corrected?.status || 'unknown'}. The bad branch’s balance is marked ${bad?.balances?.status || 'interim'} and is not presented as a final net payout.`
      : `Baseline is ${baseline?.status || 'unknown'}; bad is ${bad?.status || 'unknown'} with ${bad?.transfer?.linked ? 'an unexpected link' : 'no beneficiary link'}.`;

    $('branch-grid').innerHTML = ['baseline', 'bad', 'corrected'].map((name) => {
      const branch = report.branches?.[name];
      return branchSummary(branch, name, name === focusName, name === state.detailBranch);
    }).join('');
    for (const card of document.querySelectorAll('.branch-card')) {
      card.addEventListener('click', () => {
        state.detailBranch = card.dataset.branch;
        state.tab = 'receipt';
        renderResult();
      });
    }

    $('detail-branch-label').textContent = `${branchName(state.detailBranch)} detail`;
    for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === state.tab);
    renderDetails(report);
    $('run-button').disabled = false;
    $('rerun-button').hidden = false;
    $('rerun-button').disabled = false;
    setStatus(complete ? 'Complete / verified run' : 'Incomplete / not evidence', complete ? 'complete' : 'incomplete');
    show('result-state');
  }

  function renderDetails(report) {
    const branch = report.branches?.[state.detailBranch];
    const panel = $('detail-panel');
    if (!branch) { panel.innerHTML = '<p class="muted">No branch selected.</p>'; return; }
    if (state.tab === 'raw') {
      panel.innerHTML = `<pre class="raw">${escape(JSON.stringify(report, null, 2))}</pre>`;
      return;
    }
    if (state.tab === 'provenance') {
      const c = report.capture || {};
      const controls = branch.controls || {};
      panel.innerHTML = `
        <div class="kv-grid">
          <div class="kv"><span>Capture contract</span><b>${escape(c.contract)}</b></div>
          <div class="kv"><span>Capture block</span><b>${escape(c.blockHeight)} / ${escape(short(c.blockHash, 14))}</b></div>
          <div class="kv"><span>Code hash</span><b>${escape(c.codeHash)}</b></div>
          <div class="kv"><span>Code SHA-256</span><b>${escape(c.codeSha256)}</b></div>
          <div class="kv"><span>State hash</span><b>${escape(c.stateHash)}</b></div>
          <div class="kv"><span>State bytes / entitlement</span><b>${escape(c.stateBytes)} / ${escape(near(c.entitlement))} NEAR</b></div>
          <div class="kv"><span>Captured beneficiary</span><b>${escape(c.beneficiary)}</b></div>
          <div class="kv"><span>Runtime</span><b>${escape(c.runtime?.version)} / protocol ${escape(c.runtime?.protocolVersion)}</b></div>
          <div class="kv"><span>Runtime commit</span><b>${escape(c.runtime?.commit)}</b></div>
          <div class="kv"><span>Branch runtime pin</span><b>${branch.runtimePinMatched ? 'matched' : 'not matched'}</b></div>
          <div class="kv"><span>Import identity</span><b>${branch.importCheck?.matches ? 'code + state match' : 'not matched'}</b></div>
          <div class="kv"><span>Controls</span><b>${controls.outsiderDenied ? 'outsider denied' : 'outsider not denied'} · ${controls.migrationAuthorityDenied === null ? 'migration n/a' : controls.migrationAuthorityDenied ? 'migration denied' : 'migration not denied'} · ${controls.secondClaimDenied ? 'second claim denied' : 'second claim not denied'}</b></div>
        </div>
        <p class="notice">${escape(report.boundary || '')}</p>`;
      return;
    }

    const receiptRows = (branch.claim?.receipts || []).map((receipt) => {
      const status = receipt.status?.SuccessReceiptId ? 'success receipt id' : receipt.status?.SuccessValue !== undefined ? 'success value' : receipt.status?.Failure ? 'failure' : 'other';
      const tone = receipt.status?.Failure ? 'fail' : 'ok';
      return `<div class="receipt">
        <div class="receipt-top"><div class="receipt-title">${escape(short(receipt.id, 16))}</div><div class="receipt-status ${tone}">${escape(status)}</div></div>
        <div class="receipt-grid">
          <div><span>Executor</span><code>${escape(receipt.executorId || '—')}</code></div>
          <div><span>Gas burnt</span><code>${escape(receipt.gasBurnt || '—')}</code></div>
          <div><span>Tokens burnt</span><code>${escape(receipt.tokensBurnt || '—')}</code></div>
        </div>
      </div>`;
    }).join('');
    const link = branch.transfer?.links?.[0];
    panel.innerHTML = `
      <div class="receipt">
        <div class="receipt-top"><div class="receipt-title">Claim transaction ${escape(short(branch.claim?.transactionHash, 18))}</div><div class="receipt-status ${branch.claim?.failed ? 'fail' : 'ok'}">${branch.claim?.failed ? 'failed' : branch.claim?.succeeded ? 'succeeded' : 'unknown'}</div></div>
        <div class="receipt-note">${branch.claim?.failed ? escape((branch.claim.receiptFailures || []).join(' ')) : 'Transaction succeeded. Payout acceptance below requires the contract SuccessReceiptId link.'}</div>
        <div class="receipt-grid">
          <div><span>Beneficiary</span><code>${escape(branch.beneficiary || branch.transfer?.beneficiary || '—')}</code></div>
          <div><span>Payout link</span><code>${link ? 'contract → beneficiary' : 'not present'}</code></div>
          <div><span>Gas / tokens</span><code>${escape(branch.claim?.gasBurnt || '—')} / ${escape(branch.claim?.tokensBurnt || '—')}</code></div>
        </div>
      </div>
      ${link ? `<div class="receipt"><div class="receipt-top"><div class="receipt-title">Linked beneficiary receipt</div><div class="receipt-status ok">SuccessValue</div></div><div class="receipt-grid"><div><span>Contract receipt</span><code>${escape(link.contractReceiptId)}</code></div><div><span>Beneficiary receipt</span><code>${escape(link.beneficiaryReceiptId)}</code></div><div><span>Execution</span><code>${escape(link.beneficiaryExecutorId)}</code></div></div><div class="receipt-note">This is the contract’s SuccessReceiptId pointing at the beneficiary SuccessValue receipt. A separate gas-refund receipt does not satisfy this gate.</div></div>` : '<p class="notice">No contract-to-beneficiary SuccessValue link is present. A positive balance alone would not be accepted.</p>'}
      <h4 class="mini-label" style="margin-top:18px">Raw receipts</h4>
      ${receiptRows || '<p class="muted">No receipts recorded.</p>'}`;
  }

  function schedulePoll() {
    clearTimeout(state.poll);
    if (state.run?.status !== 'running') return;
    state.poll = setTimeout(refresh, 1400);
  }

  async function refresh() {
    if (!state.run?.id) return;
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(state.run.id)}`, {cache: 'no-store'});
      if (!response.ok) throw new Error(`Status request failed (${response.status})`);
      state.run = await response.json();
      render();
    } catch (error) {
      state.run = {...state.run, status: 'error', error: error.message};
      render();
    }
  }

  async function startRun() {
    if (state.run?.status === 'running') return;
    $('run-button').disabled = true;
    $('rerun-button').disabled = true;
    try {
      const response = await fetch('/api/rehearse', {method: 'POST'});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not start the rehearsal.');
      state.run = data.run;
      state.detailBranch = state.focus;
      state.tab = 'receipt';
      render();
      schedulePoll();
    } catch (error) {
      state.run = {status: 'error', error: error.message, logs: []};
      render();
    }
  }

  function render() {
    clearInterval(state.clock);
    if (!state.run) {
      setStatus('No run yet');
      show('empty-state');
      return;
    }
    if (state.run.status === 'running') {
      show('running-state');
      renderRunning();
      state.clock = setInterval(() => { if (state.run?.status === 'running') renderRunning(); }, 1000);
      return;
    }
    if (state.run.report) {
      renderResult();
      return;
    }
    show('error-state');
    renderError();
  }

  $('focus-select').addEventListener('change', (event) => {
    state.focus = event.target.value;
    state.detailBranch = state.focus;
    state.tab = 'receipt';
    if (state.run?.report) renderResult();
  });
  $('run-button').addEventListener('click', startRun);
  $('retry-button').addEventListener('click', startRun);
  $('rerun-button').addEventListener('click', startRun);
  $('export-button').addEventListener('click', () => {});
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      if (state.run?.report) renderResult();
    });
  }

  fetch('/api/state', {cache: 'no-store'}).then((response) => response.json()).then((data) => {
    if (data.active) {
      state.run = data.active;
      state.detailBranch = state.focus;
      render();
      schedulePoll();
    } else {
      render();
    }
  }).catch(() => render());
})();
