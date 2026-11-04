(() => {
  'use strict';

  const state = {
    run: null,
    focus: 'bad',
    detailBranch: 'bad',
    tab: 'receipt',
    poll: null,
    clock: null,
    candidate: null,
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
  const branchName = (name, candidateLabel = 'Supplied candidate') => ({baseline: 'Baseline', bad: candidateLabel, corrected: 'Corrected reference'}[name] || name);
  const candidateReady = () => Boolean(state.candidate?.base64 && state.candidate?.sha256);

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(binary);
  }

  function renderCandidate(message) {
    const meta = $('candidate-meta');
    if (!meta) return;
    if (state.candidate) {
      meta.className = 'candidate-meta ready';
      meta.textContent = `${state.candidate.name} · ${state.candidate.bytes} bytes · sha256 ${state.candidate.sha256}`;
    } else {
      meta.className = 'candidate-meta';
      meta.textContent = message || 'No candidate selected. Rehearse requires an actual WASM input.';
    }
    $('run-button').disabled = !candidateReady() || state.run?.status === 'running';
  }

  async function setCandidate(bytes, name) {
    if (!bytes?.length) throw new Error('The selected file is empty.');
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Candidate WASM must be 2 MB or smaller.');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    state.candidate = {name, bytes: bytes.length, sha256, base64: bytesToBase64(bytes)};
    renderCandidate();
  }

  async function loadFixture(name) {
    try {
      const response = await fetch(`/fixtures/${name}.wasm`, {cache: 'no-store'});
      if (!response.ok) throw new Error(`Fixture request failed (${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await setCandidate(bytes, `${name}.wasm`);
    } catch (error) {
      renderCandidate(error.message);
    }
  }

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
    $('export-button').disabled = true;
    setStatus('Running / local Sandbox', 'running');
  }

  function renderError() {
    $('error-copy').textContent = state.run?.error || 'The runner exited without producing a new result.';
    $('error-log').textContent = (state.run?.logs || []).slice(-30).join('\n') || 'No runner output.';
    $('run-button').disabled = !candidateReady();
    $('rerun-button').hidden = true;
    $('export-button').disabled = true;
    setStatus('Rehearsal error', 'error');
    show('error-state');
  }

  function branchSummary(branch, name, isFocus, isDetail, candidateLabel) {
    const [status, tone] = branchStatus(branch);
    const transfer = branch?.transfer?.linked ? 'beneficiary link' : 'no link';
    const before = branch?.entitlement?.beforeMigration;
    const afterMigration = branch?.entitlement?.afterMigration;
    const afterClaim = branch?.entitlement?.afterClaim;
    const userDelta = branch?.balances?.user?.delta;
    const tx = branch?.claim?.transactionHash;
    const controlLabel = branch?.controls?.outsiderDenied ? 'controls pass' : 'controls not run';
    const interimBalance = branch?.balances?.status === 'interim';
    return `<article class="branch-card ${tone === 'bad' ? 'bad-card' : 'good-card'} ${isFocus ? 'focus' : ''} ${isDetail ? 'detail' : ''}" data-branch="${escape(name)}">
      <div class="branch-name"><strong>${escape(branchName(name, candidateLabel))}</strong><span class="branch-status ${tone}">${escape(status)}</span></div>
      <div class="branch-kicker">${escape(name === 'baseline' ? 'claim_refund() — no candidate' : name === 'bad' ? `${escape(candidateLabel)} + migrate()` : 'corrected reference + migrate()')}</div>
      <div class="branch-mini">
        <div><span>Entitlement before</span><b>${escape(near(before))} NEAR</b></div>
        <div><span>After migration</span><b>${escape(near(afterMigration))} NEAR</b></div>
        <div><span>After claim</span><b>${escape(near(afterClaim))} NEAR</b></div>
        <div><span>User net</span><b>${interimBalance ? 'pending / unavailable' : userDelta ? (BigInt(userDelta) > 0n ? '+' : '') + near(userDelta) + ' NEAR' : '—'}</b></div>
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
    const candidateLabel = report.branches?.bad?.candidateLabel || state.run?.input?.filename || 'Supplied candidate';
    const focus = state.focus === 'corrected' ? corrected : bad;
    const focusName = state.focus === 'corrected' ? 'corrected' : 'bad';

    $('result-banner').className = `result-banner ${complete ? 'ok' : 'bad'}`;
    const candidateOutcome = report.result?.candidateOutcome;
    $('result-banner').textContent = complete
      ? `New run complete. Candidate classified as ${candidateOutcome === 'paid' ? 'beneficiary paid' : 'structured NO_REFUND'}; fixed capture, runtime pin, controls and corrected beneficiary-linked payout all passed.`
      : 'Run incomplete. This is not release evidence; inspect the failed gate and raw report below.';

    const badBlocked = bad?.status === 'expected-failure' && bad?.transfer?.linked === false;
    const badPaid = bad?.status === 'completed' && bad?.transfer?.linked === true;
    const goodPaid = corrected?.status === 'completed' && corrected?.transfer?.linked === true;
    const focusIsBad = focusName === 'bad';
    const focusPaid = focusIsBad ? badPaid : goodPaid;
    $('outcome-title').textContent = focusIsBad
      ? (badBlocked ? 'The supplied candidate removes the existing user’s refund.' : badPaid ? 'The supplied candidate preserves the existing user’s refund.' : 'The supplied candidate is inconclusive.')
      : (goodPaid ? 'The correction restores the existing user’s refund.' : 'The corrected result is not a verified payout.');
    $('outcome-badge').textContent = focusIsBad
      ? (badBlocked ? 'NO_REFUND / no payout' : badPaid ? 'BENEFICIARY PAID' : 'INCONCLUSIVE')
      : (goodPaid ? 'BENEFICIARY PAID' : 'UNVERIFIED');
    $('outcome-badge').className = `badge ${focusIsBad ? (badBlocked ? 'bad' : badPaid ? 'good' : 'subtle') : (goodPaid ? 'good' : 'subtle')}`;
    $('outcome-copy').textContent = focusIsBad
      ? (badBlocked
        ? 'The supplied candidate and declared migration clear the stored entitlement before the same existing-user claim. The claim fails with a structured NO_REFUND and there is no contract-to-beneficiary transfer link. The funds stay in the contract; this is an authored local-Sandbox example, not a public incident.'
        : badPaid
          ? 'The supplied candidate preserves the stored entitlement and the same claim succeeds. The contract receipt’s SuccessReceiptId links to a SuccessValue receipt executed by the captured beneficiary. This is a legitimate paid outcome, not a required seeded failure.'
          : 'The supplied candidate did not produce a classified paid or structured NO_REFUND outcome. Treat it as inconclusive and do not export it as release evidence.')
      : 'The corrected migration preserves the stored entitlement. The same claim succeeds and the contract receipt’s SuccessReceiptId links to a SuccessValue receipt executed by the captured beneficiary. The gross entitlement and net balance are shown separately.';

    const before = focus?.entitlement?.beforeMigration;
    const afterMigration = focus?.entitlement?.afterMigration;
    const afterClaim = focus?.entitlement?.afterClaim;
    const link = focus?.transfer?.linked === true;
    $('outcome-stats').innerHTML = `
      <div class="stat"><span class="stat-label">Refund entitlement before</span><div class="stat-value">${escape(near(before))} NEAR</div></div>
      <div class="stat"><span class="stat-label">After migration</span><div class="stat-value ${focusIsBad && afterMigration === '0' ? 'bad' : 'good'}">${escape(near(afterMigration))} NEAR</div></div>
      <div class="stat"><span class="stat-label">Claim result</span><div class="stat-value ${focusPaid ? 'good' : focusIsBad && badBlocked ? 'bad' : 'bad'}">${focusPaid ? 'PAID' : focusIsBad && badBlocked ? 'NO_REFUND' : 'INCONCLUSIVE'}</div></div>
      <div class="stat"><span class="stat-label">Beneficiary transfer link</span><div class="stat-value ${link ? 'good' : 'bad'}">${link ? 'linked' : 'not present'}</div></div>`;
    $('outcome-foot').textContent = focusIsBad
      ? `Baseline is ${baseline?.status || 'unknown'}; corrected is ${corrected?.status || 'unknown'}. The bad branch’s balance is marked ${bad?.balances?.status || 'interim'} and is not presented as a final net payout.`
      : `Baseline is ${baseline?.status || 'unknown'}; bad is ${bad?.status || 'unknown'} with ${bad?.transfer?.linked ? 'an unexpected link' : 'no beneficiary link'}.`;

    $('branch-grid').innerHTML = ['baseline', 'bad', 'corrected'].map((name) => {
      const branch = report.branches?.[name];
      return branchSummary(branch, name, name === focusName, name === state.detailBranch, candidateLabel);
    }).join('');
    for (const card of document.querySelectorAll('.branch-card')) {
      card.addEventListener('click', () => {
        state.detailBranch = card.dataset.branch;
        state.tab = 'receipt';
        renderResult();
      });
    }

    $('detail-branch-label').textContent = `${branchName(state.detailBranch, candidateLabel)} detail`;
    for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === state.tab);
    renderDetails(report);
    $('run-button').disabled = !candidateReady();
    $('rerun-button').hidden = false;
    $('rerun-button').disabled = false;
    $('export-button').disabled = !complete;
    $('export-button').textContent = 'Export verified replay';
    if (!complete) $('export-result').hidden = true;
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

  let pollGeneration = 0;

  async function pollRun() {
    const runId = state.run?.id;
    if (!runId) return;
    const generation = ++pollGeneration;
    const isCurrent = () => generation === pollGeneration && state.run?.id === runId;
    await window.RehearsalPoller.pollUntilTerminal({
      delayMs: 1400,
      shouldStop: () => !isCurrent(),
      fetchRun: async () => {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {cache: 'no-store'});
        if (!response.ok) throw new Error(`Status request failed (${response.status})`);
        return response.json();
      },
      onRun: (run) => {
        if (!isCurrent()) return;
        state.run = run;
        render();
      },
      onError: (error) => {
        if (!isCurrent()) return;
        state.run = {...state.run, status: 'error', error: error.message};
        render();
      },
    });
  }

  async function exportRun() {
    if (state.run?.status !== 'complete' || state.run?.report?.result?.status !== 'complete') return;
    const button = $('export-button');
    const output = $('export-result');
    button.disabled = true;
    button.textContent = 'Exporting verified replay…';
    output.hidden = false;
    output.innerHTML = '<strong>Export</strong>Validating the completed report and hashing inputs…';
    try {
      const response = await fetch('/api/export', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({runId: state.run.id}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Export failed.');
      output.innerHTML = `<strong>Verified export written</strong>${escape(data.bundle)}<br>${escape(data.verifyCommand)}`;
      button.textContent = 'Export verified replay';
      button.disabled = false;
    } catch (error) {
      output.innerHTML = `<strong style="color:var(--red)">Export rejected</strong>${escape(error.message)}`;
      button.textContent = 'Export verified replay';
      button.disabled = false;
    }
  }

  async function startRun() {
    if (state.run?.status === 'running') return;
    if (!candidateReady()) {
      renderCandidate('Select a candidate WASM before rehearsing. Candidate focus alone does not execute an input.');
      return;
    }
    let migration;
    let operation;
    try {
      migration = JSON.parse($('migration-input').value);
      operation = JSON.parse($('operation-input').value);
    } catch (error) {
      renderCandidate(`Declared input is not valid JSON: ${error.message}`);
      return;
    }
    $('run-button').disabled = true;
    $('rerun-button').disabled = true;
    $('export-button').disabled = true;
    try {
      const response = await fetch('/api/rehearse', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          family: 'refund-v1',
          candidate: {
            filename: state.candidate.name,
            sha256: state.candidate.sha256,
            base64: state.candidate.base64,
          },
          migration,
          operation,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not start the rehearsal.');
      state.run = data.run;
      state.detailBranch = state.focus;
      state.tab = 'receipt';
      render();
      pollRun();
    } catch (error) {
      state.run = {status: 'error', error: error.message, logs: []};
      render();
    }
  }

  function render() {
    clearInterval(state.clock);
    if (!state.run) {
      renderCandidate();
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

  $('candidate-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await setCandidate(bytes, file.name);
    } catch (error) {
      state.candidate = null;
      renderCandidate(error.message);
    }
  });
  $('fixture-bad').addEventListener('click', () => loadFixture('refund-v2-bad'));
  $('fixture-corrected').addEventListener('click', () => loadFixture('refund-v2-fixed'));
  renderCandidate();

  $('focus-select').addEventListener('change', (event) => {
    state.focus = event.target.value;
    state.detailBranch = state.focus;
    state.tab = 'receipt';
    if (state.run?.report) renderResult();
  });
  $('run-button').addEventListener('click', startRun);
  $('retry-button').addEventListener('click', startRun);
  $('rerun-button').addEventListener('click', startRun);
  $('export-button').addEventListener('click', exportRun);
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
      pollRun();
    } else {
      render();
    }
  }).catch(() => render());
})();
