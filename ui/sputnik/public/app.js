(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = {supported: null, candidate: null, correction: null, run: null, tab: 'summary', poll: null, clock: null, export: null, pollFailures: 0};
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const short = (v, n = 10) => v ? `${String(v).slice(0, n)}…${String(v).slice(-6)}` : '—';
  const near = (v) => {
    if (v === null || v === undefined) return '—';
    const n = BigInt(v); const unit = 10n ** 24n;
    const whole = n / unit; const fraction = (n % unit).toString().padStart(24, '0').slice(0, 6).replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''}`;
  };
  const bytesToB64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const digest = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const statusKind = (s) => s === 'preserved' ? 'good' : s === 'regressed' ? 'bad' : 'subtle';

  function setStatus(text, kind = 'idle') { const el = $('status'); el.textContent = text; el.className = `status-pill ${kind}`; }
  function show(id) { for (const k of ['empty-state', 'running-state', 'error-state', 'result-state']) $(k).hidden = k !== id; }
  function renderChoiceMeta() {
    const c = $('candidate-meta'); const g = $('correction-meta');
    c.className = 'meta ready';
    c.innerHTML = state.candidate ? `<b>${esc(state.candidate.filename)}</b><br>${state.candidate.role} · ${state.candidate.bytes ?? 'manifest'} bytes · <span class="mono">${esc(short(state.candidate.sha256, 16))}</span>` : 'No candidate selected.';
    g.className = 'meta ready';
    g.innerHTML = state.correction ? `<b>${esc(state.correction.filename)}</b><br>${state.correction.role} · ${state.correction.bytes ?? 'manifest'} bytes · <span class="mono">${esc(short(state.correction.sha256, 16))}</span>` : 'No correction selected.';
    $('run-button').disabled = !state.candidate || !state.correction || state.run?.status === 'running';
    // Rerun is a correction-only action; it must not remain usable while the
    // previous correction has been cleared or a new file is still unverified.
    $('rerun-button').disabled = !state.correction || !state.run || state.run.status === 'running';
  }
  function clearChoice(which, message) {
    if (which === 'candidate') state.candidate = null; else state.correction = null;
    renderChoiceMeta();
    $(`${which}-meta`).className = 'meta bad';
    $(`${which}-meta`).textContent = message;
  }
  async function setFile(which, file) {
    // Clear first, including on cancel/invalid input. A previous artifact must
    // never remain selected while the picker has a different file selected.
    clearChoice(which, `Reading ${which} WASM…`);
    if (!file) { clearChoice(which, `No ${which} file selected.`); return; }
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
      if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error('WASM must be between 1 byte and 2 MB.');
      const sha256 = await digest(bytes);
      const target = {filename: file.name, bytes: bytes.length, sha256, base64: bytesToB64(bytes), role: 'upload', label: file.name, provenance: 'uploaded WASM'};
      if (which === 'candidate') state.candidate = target; else state.correction = target;
      renderChoiceMeta();
    } catch (e) {
      clearChoice(which, e.message || `Could not read ${which} WASM.`);
    }
  }
  function chooseArtifact(which, choice) {
    if (choice === 'upload') {
      const input = $(`${which}-file`);
      input.value = '';
      clearChoice(which, `Choose a ${which} WASM file.`);
      input.hidden = false;
      input.click();
      return;
    }
    $(`${which}-file`).hidden = true;
    const artifacts = state.supported?.artifacts || {};
    // Older manifests may expose the healthy bytes only under `corrected`.
    const key = choice === 'healthy' && !artifacts.healthy && artifacts.corrected?.roles?.includes('candidate') ? 'corrected' : choice;
    const a = artifacts[key];
    const roleAllowed = a && Array.isArray(a.roles) ? a.roles.includes(which) : !!a;
    if (!a || !roleAllowed) {
      if (which === 'candidate') state.candidate = null; else state.correction = null;
      $(`${which}-choice`).value = '';
      renderChoiceMeta();
      $(`${which}-meta`).className = 'meta bad';
      $(`${which}-meta`).textContent = `Unsupported ${which} selection. Choose a manifest artifact or upload a WASM.`;
      return;
    }
    const target = {filename: a.label || key, bytes: null, sha256: a.sha256, role: key, label: a.label || key, provenance: a.provenance || `manifest artifact ${key}`, base64: null};
    if (which === 'candidate') state.candidate = target; else state.correction = target;
    renderChoiceMeta();
  }
  async function loadSupported() {
    const r = await fetch('/api/supported', {cache: 'no-store'});
    if (!r.ok) throw new Error('Could not load the supported family manifest.');
    state.supported = await r.json();
    $('family-label').textContent = `${state.supported.family} · ${state.supported.label}`;
    chooseArtifact('candidate', 'candidate');
    chooseArtifact('correction', 'corrected');
  }
  function payloadChoice(which) {
    const c = which === 'candidate' ? state.candidate : state.correction;
    if (!c) throw new Error(`Select a ${which}.`);
    if (!/^[a-f0-9]{64}$/.test(c.sha256 || '')) throw new Error(`Selected ${which} has no valid SHA-256.`);
    if (c.role === 'upload') {
      if (!c.base64 || !c.bytes) throw new Error(`Uploaded ${which} bytes are missing.`);
      return {choice: 'upload', filename: c.filename, sha256: c.sha256, base64: c.base64, label: c.label, provenance: c.provenance};
    }
    return {choice: c.role};
  }
  async function startRun(kind = 'run') {
    if (state.run?.status === 'running') return;
    try {
      const body = kind === 'correction'
        ? {runId: state.run.id, correction: payloadChoice('correction')}
        : {family: state.supported.family, candidate: payloadChoice('candidate'), correction: payloadChoice('correction')};
      const r = await fetch(kind === 'correction' ? '/api/correction' : '/api/run', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Could not start run.');
      state.run = data.run; state.export = null; state.pollFailures = 0;
      resetExportUi();
      show('running-state'); renderRunning(); renderChoiceMeta(); startPoll();
    } catch (e) { setStatus('Run rejected', 'error'); show('error-state'); $('error-copy').textContent = e.message; $('error-log').textContent = ''; }
  }
  function startPoll() {
    clearInterval(state.poll); clearInterval(state.clock);
    state.poll = setInterval(poll, 1000);
    state.clock = setInterval(() => { if (state.run?.status === 'running') $('elapsed').textContent = elapsed(); }, 1000);
  }
  function elapsed() {
    if (!state.run?.startedAt) return '00:00';
    const sec = Math.max(0, Math.floor((Date.now() - Date.parse(state.run.startedAt)) / 1000));
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }
  function resetExportUi() {
    $('export-button').textContent = 'Verify and export';
    $('export-button').disabled = true;
    $('rerun-button').disabled = true;
    $('rerun-button').hidden = true;
  }
  function renderRunning() {
    $('running-title').textContent = 'Running baseline, candidate and correction…';
    $('running-copy').textContent = 'Real local Sandbox transactions are executing. Candidate and correction outcomes are derived from receipts; only runner/RPC failures are inconclusive.';
    $('run-id').textContent = state.run?.id ? short(state.run.id, 8) : '';
    $('elapsed').textContent = elapsed();
    const logs = state.run?.logs || [];
    $('logs').textContent = logs.slice(-24).join('\n') || 'Waiting for the runner…';
    $('logs').scrollTop = $('logs').scrollHeight;
    $('export-button').disabled = true;
    $('export-button').textContent = 'Verify and export';
    $('rerun-button').disabled = true;
    $('rerun-button').hidden = true;
    $('run-button').disabled = true;
    setStatus('Running / local Sandbox', 'running');
  }
  async function poll() {
    if (!state.run?.id) return;
    try {
      const r = await fetch(`/api/runs/${state.run.id}`, {cache: 'no-store'});
      if (!r.ok) {
        state.pollFailures += 1;
        if (state.pollFailures >= 3) throw new Error('Run state is no longer available (the review server may have restarted). Start a new run.');
        return;
      }
      state.pollFailures = 0;
      state.run = await r.json();
      renderRunning();
      if (state.run.status !== 'running') { clearInterval(state.poll); clearInterval(state.clock); renderTerminal(); }
    } catch (e) {
      clearInterval(state.poll); clearInterval(state.clock);
      state.run = {...state.run, status: 'error'};
      show('error-state'); $('error-copy').textContent = e.message; $('error-log').textContent = (state.run.logs || []).slice(-20).join('\n'); setStatus('Run state unavailable', 'error');
    }
  }
  function failureText(tx) {
    if (!tx?.failure) return '—';
    return tx.failure.ActionError?.kind?.FunctionCallError?.ExecutionError || JSON.stringify(tx.failure).slice(0, 220);
  }
  function card(name, label, b, role) {
    const artifact = name === 'candidate' ? state.run?.report?.artifacts?.candidate : name === 'corrected' ? state.run?.report?.artifacts?.corrected : null;
    const title = name === 'baseline' ? 'Old contract' : artifact?.label || role;
    const provenance = artifact?.provenance || '';
    const status = b?.status || 'missing';
    const delta = b?.before && b?.afterFirst ? BigInt(b.afterFirst.recipientBalance) - BigInt(b.before.recipientBalance) : null;
    const failed = b?.first?.failed === true;
    const reason = failureText(b?.first);
    return `<article class="branch-card ${statusKind(status)}" data-branch="${esc(name)}">
      <div class="branch-head"><div><div class="eyebrow">${esc(label)}</div><h3>${esc(title)}</h3>${provenance ? `<small class="provenance">${esc(provenance)}</small>` : ''}</div><span class="badge ${statusKind(status)}">${esc(status)}</span></div>
      <div class="consequence"><span>Recipient delta</span><strong>${delta === null ? '—' : `${delta >= 0n ? '+' : ''}${near(delta)} NEAR`}</strong></div>
      <div class="mini-grid">
        <div><span>Declared role</span><b>${esc(role)}</b></div>
        <div><span>Operation</span><b>${failed ? 'failed' : b?.first?.succeeded ? 'succeeded' : '—'}</b></div>
        <div><span>Code</span><b class="mono">${esc(short(b?.afterUpgrade?.codeHash || b?.before?.codeHash, 12))}</b></div>
        <div><span>Frozen initial</span><b class="mono">${esc(short(b?.initial?.stateHash, 12))}</b></div>
      </div>
      ${failed ? `<p class="failure"><strong>Raw failure</strong> ${esc(reason)}</p>` : ''}
      <button class="detail-link" data-detail="${esc(name)}" type="button">Inspect ${esc(name)}</button>
    </article>`;
  }
  function renderTerminal() {
    if (state.run.status !== 'complete') {
      show('error-state');
      $('error-copy').textContent = state.run.error || 'The run was inconclusive.';
      $('error-log').textContent = (state.run.logs || []).slice(-30).join('\n');
      setStatus('Inconclusive / not evidence', 'error');
      return;
    }
    state.export = null;
    const report = state.run.report;
    const b = report.branches;
    $('result-banner').className = 'result-banner ok';
    $('result-banner').textContent = `Complete report. Candidate ${b.candidate.status}; correction ${b.corrected.status}. Outcomes are derived from receipts and balances; a red branch is not a runner failure.`;
    const fb = report.frozenBundle || {};
    const obligation = fb.proposal || report.branches?.baseline?.before?.proposal || {};
    const transfer = obligation.kind?.Transfer || report.branches?.baseline?.before?.proposal?.kind?.Transfer;
    const identities = fb.identities || {};
    $('obligation-strip').innerHTML = `<div><span>Obligation</span><b>#${esc(obligation.id ?? '—')} · ${esc(obligation.status || '—')}</b></div><div><span>Declared recipient</span><b>${esc(transfer?.receiver_id || '—')}</b></div><div><span>Declared transfer</span><b>${near(transfer?.amount)} NEAR</b></div><div><span>Frozen state</span><b class="mono">${esc(short(fb.stateHash, 18))}</b></div>`;
    $('frozen-summary').innerHTML = `<div><span>Frozen state</span><b class="mono">${esc(report.frozenBundle.stateHash)}</b></div><div><span>Same initial facts</span><b>${report.sameStartingState ? 'verified across all branches' : 'not verified'}</b></div><div><span>Frozen bundle</span><b>${esc(state.run.frozenBundle ? short(state.run.frozenBundle.stateHash, 16) : '—')}</b></div>`;
    $('branch-grid').innerHTML = [
      card('baseline', 'Old state → existing operation', b.baseline, 'baseline'),
      card('candidate', `Old state → ${report.artifacts.candidate.label || 'candidate'} → operation`, b.candidate, 'candidate'),
      card('corrected', `Old state → ${report.artifacts.corrected.label || 'correction'} → operation`, b.corrected, 'correction'),
    ].join('');
    for (const el of document.querySelectorAll('.detail-link')) el.addEventListener('click', () => { state.tab = 'summary'; state.detail = el.dataset.detail; renderDetails(); });
    $('rerun-button').hidden = false;
    $('rerun-button').disabled = false;
    $('export-button').disabled = false;
    $('run-button').disabled = false;
    setStatus('Complete report', 'complete');
    show('result-state');
    renderDetails();
  }
  function renderDetails() {
    const report = state.run?.report; if (!report) return;
    const panel = $('detail-panel');
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === state.tab);
    if (state.tab === 'raw') { panel.innerHTML = `<pre class="raw">${esc(JSON.stringify(report, null, 2))}</pre>`; return; }
    if (state.tab === 'export') { const shown = state.export ? {...state.export, candidate: {...state.export.candidate, bytesBase64: '[included in download]'}, correction: {...state.export.correction, bytesBase64: '[included in download]'}} : null; panel.innerHTML = shown ? `<p class="notice">Self-contained JSON includes frozen state, candidate/correction bytes, input manifest, raw report and verdict.</p><a class="download-link" href="/api/runs/${encodeURIComponent(state.run.id)}/export/download" download>Download self-contained export JSON</a><pre class="raw">${esc(JSON.stringify(shown, null, 2))}</pre>` : '<p class="muted">Run Verify and export after a complete report.</p>'; return; }
    const b = report.branches[state.detail || 'candidate'];
    panel.innerHTML = `<div class="kv-grid">
      <div class="kv"><span>Current branch</span><b>${esc(state.detail || 'candidate')}</b></div>
      <div class="kv"><span>Verdict</span><b>${esc(b.status)}</b></div>
      <div class="kv"><span>Initial state hash</span><b class="mono">${esc(b.initial.stateHash)}</b></div>
      <div class="kv"><span>After operation</span><b class="mono">${esc(short(b.afterFirst?.stateHash, 20))}</b></div>
      <div class="kv"><span>Candidate code</span><b class="mono">${esc(short(b.afterUpgrade?.codeHash || b.before?.codeHash, 20))}</b></div>
      <div class="kv"><span>Local block</span><b>${esc(b.localBlock.height)} / ${esc(short(b.localBlock.hash, 14))}</b></div>
      <div class="kv"><span>Frozen bundle context</span><b>${esc(report.frozenBundle.context.frozenAtLocalBlock.height)} / ${esc(report.frozenBundle.context.frozenAtLocalBlock.timestamp)}</b></div>
      <div class="kv"><span>Failure</span><b>${esc(failureText(b.first))}</b></div>
    </div><p class="notice">${esc(report.fixture)}</p>`;
  }
  async function exportRun() {
    if (!state.run?.id) return;
    try {
      const r = await fetch(`/api/runs/${state.run.id}/export`, {method: 'POST'});
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Export failed.');
      state.export = data.export; state.tab = 'export'; renderDetails();
      $('export-button').textContent = `Exported: ${data.exportPath}`;
    } catch (e) { setStatus('Export rejected', 'error'); $('export-button').textContent = 'Export failed'; $('error-copy').textContent = e.message; }
  }
  function bind() {
    $('candidate-choice').addEventListener('change', (e) => chooseArtifact('candidate', e.target.value));
    $('correction-choice').addEventListener('change', (e) => chooseArtifact('correction', e.target.value));
    $('candidate-file').addEventListener('change', (e) => setFile('candidate', e.target.files[0]).catch((err) => { $('candidate-meta').textContent = err.message; }));
    $('correction-file').addEventListener('change', (e) => setFile('correction', e.target.files[0]).catch((err) => { $('correction-meta').textContent = err.message; }));
    $('run-button').addEventListener('click', () => startRun('run'));
    $('retry-button').addEventListener('click', () => startRun('run'));
    $('rerun-button').addEventListener('click', () => startRun('correction'));
    $('export-button').addEventListener('click', exportRun);
    for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => { state.tab = t.dataset.tab; renderDetails(); });
  }
  async function loadExistingRun(id) {
    try {
      const r = await fetch(`/api/runs/${encodeURIComponent(id)}`, {cache: 'no-store'});
      if (!r.ok) throw new Error('Run not found.');
      state.run = await r.json();
      if (state.run.status === 'running') { show('running-state'); renderRunning(); startPoll(); return; }
      if (state.run.status === 'complete') { renderTerminal(); return; }
      show('error-state'); $('error-copy').textContent = state.run.error || 'Run was inconclusive.'; $('error-log').textContent = (state.run.logs || []).slice(-20).join('\n');
    } catch (e) { setStatus('Run unavailable', 'error'); $('error-copy').textContent = e.message; show('error-state'); }
  }
  bind();
  loadSupported().then(() => {
    const requested = new URLSearchParams(location.search).get('run');
    if (requested) loadExistingRun(requested);
  }).catch((e) => { setStatus('Manifest error', 'error'); $('candidate-meta').textContent = e.message; });
})();
