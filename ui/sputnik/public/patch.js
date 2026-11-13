'use strict';
(() => {
  const el = (id) => document.getElementById(id);
  const input = el('patch-text'), file = el('patch-file'), button = el('check'), status = el('patch-status');
  const max = 64 * 1024;
  let selection = 0, view = 0, active = false, pendingFile = false, loadedText = null;
  function resetResult() {
    el('patch-result').hidden = true;
    el('patch-outcomes').hidden = true;
    el('patch-failed').hidden = true;
    el('patch-report').textContent = '';
    el('evidence-links').replaceChildren();
  }
  function controls() { button.disabled = active || pendingFile; input.disabled = file.disabled = active; }
  function editing() { ++view; resetResult(); status.textContent = ''; }
  file.addEventListener('change', async () => {
    const mine = ++selection, f = file.files[0]; editing(); loadedText = null; input.value = ''; pendingFile = Boolean(f); controls();
    if (!f) return;
    try {
      if (f.size > max) throw new Error('Choose a diff smaller than 64 KiB.');
      const text = await f.text(); if (mine === selection) { input.value = text; loadedText = text; }
    } catch (e) { if (mine === selection) status.textContent = e.message; }
    finally { if (mine === selection) { pendingFile = false; controls(); } }
  });
  input.addEventListener('input', () => { ++selection; pendingFile = false; loadedText = null; file.value = ''; controls(); editing(); });
  const titles = {accepted:'Passed the recovery checks',rejected:'Failed a recovery check',input_error:'Patch could not be applied',build_error:'Patch could not be built',inconclusive:'No verified result'};
  const statusLabels = {accepted:'Accepted',rejected:'Rejected',input_error:'Input error',build_error:'Build error',inconclusive:'Inconclusive',running:'Running'};
  async function json(url, opts) {
    const r = await fetch(url, {...opts, cache:'no-store', signal:AbortSignal.timeout(15000)}); const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'The local reviewer is unavailable.'); return d;
  }
  function value(value, fallback = 'Not measured') { return value === null || value === undefined || value === '' ? fallback : value; }
  function approximate(value) {
    if (value === null || value === undefined || value === '') return 'Not measured';
    const text = String(value).trim();
    const match = text.match(/^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(.*)$/i);
    if (!match) return text;
    const number = Number(match[1]);
    if (!Number.isFinite(number)) return text;
    // Six significant figures keep the display compact. A nonzero measurement
    // that would round to zero switches to exponent notation, never to an
    // unmarked zero.
    let short = String(Number(number.toPrecision(6)));
    if (number !== 0 && Number(short) === 0) short = number.toExponential(5);
    return `≈${short}${match[2] ? ' ' + match[2] : ''}`;
  }
  function outcomes(run) {
    const box = el('patch-outcomes'), failed = el('patch-failed');
    box.replaceChildren(); failed.replaceChildren();
    if (run.summary) {
      const s = run.summary;
      const cards = [
        ['Bond returned', value(s.firstRecovery?.gross), s.firstRecovery?.endedFailed ? 'Failed status preserved' : 'No failed status recorded'],
        ['First recovery gas', approximate(s.firstRecovery?.gas), 'Reported separately from the gross bond', value(s.firstRecovery?.gas)],
        ['Proposer net', approximate(s.firstRecovery?.proposerNet), 'Gross bond less measured gas', value(s.firstRecovery?.proposerNet)],
        ['Retry principal', value(s.retry?.gross), 'Second finalize; no extra principal when measured at zero'],
        ['Retry gas', approximate(s.retry?.gas), 'Gas moved separately from retry principal', value(s.retry?.gas)],
        ['Retry proposer net', approximate(s.retry?.proposerNet), 'Net after retry gas', value(s.retry?.proposerNet)],
        ['Healthy settled', value(s.healthy?.settledTransfer), 'Already-paid Transfer'],
        ['Healthy pending', value(s.healthy?.pendingTransfer), 'Inherited pending Transfer'],
      ];
      for (const [label, amount, note, exact = amount] of cards) {
        const card = document.createElement('div');
        card.className = 'consequence-card';
        card.innerHTML = `<div class="eyebrow">${escapeHtml(label)}</div><strong title="${escapeHtml(exact)}" aria-label="${escapeHtml(exact)}">${escapeHtml(amount)}</strong><p>${escapeHtml(note)}</p>`;
        box.append(card);
      }
      box.hidden = false;
    } else {
      const card = document.createElement('div');
      card.className = 'consequence-card';
      card.innerHTML = '<div class="eyebrow">Money outcome</div><strong>Not available</strong><p>No accepted measured result was produced for this run.</p>';
      box.append(card); box.hidden = false;
    }
    const notPassed = Array.isArray(run.checks) ? run.checks.filter((check) => check.status !== 'pass') : [];
    if (notPassed.length) {
      for (const check of notPassed) {
        const li = document.createElement('li');
        const mark = document.createElement('span'); mark.className = 'check-mark bad'; mark.textContent = '✕';
        li.append(mark, document.createTextNode(`${check.id}: ${check.detail || check.status}`));
        failed.append(li);
      }
      failed.hidden = false;
    } else if (run.status === 'accepted') {
      const li = document.createElement('li');
      li.innerHTML = '<span class="check-mark">✓</span><span>All defined checks passed for this pinned case.</span>';
      failed.append(li); failed.hidden = false;
    }
  }
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }
  function result(run) {
    resetResult(); el('result-title').textContent = titles[run.status] || titles.inconclusive;
    el('result-note').textContent = run.note || 'See the checker evidence for this run.';
    outcomes(run);
    if (run.report) { el('patch-report').textContent = run.report; el('patch-report').hidden = false; } else el('patch-report').hidden = true;
    for (const [key,label] of [['package','Download evidence package'],['status','Download status'],['report','Download report'],['patch','Download submitted diff']]) {
      if (!run.downloads?.includes(key)) continue;
      const a = document.createElement('a'); a.className = 'download-button'; a.download = ''; a.href = '/api/patch/runs/'+encodeURIComponent(run.id)+'/'+key; a.textContent = label; el('evidence-links').append(a);
    }
    el('patch-result').hidden = false; el('result-title').focus();
  }
  function renderRecent(runs) {
    const list = el('recent-list'), section = el('recent-runs');
    list.replaceChildren();
    if (!Array.isArray(runs) || !runs.length) { section.hidden = true; return; }
    for (const run of runs) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'history-item';
      button.innerHTML = `<b>${escapeHtml(statusLabels[run.status] || 'Unknown')} · ${escapeHtml(run.id.slice(0, 8))}</b><small>${escapeHtml(run.finishedAt || run.createdAt || '')}</small>`;
      button.addEventListener('click', () => follow(run.id));
      list.append(button);
    }
    section.hidden = false;
  }
  async function loadRecent() {
    try { const data = await json('/api/patch/runs'); renderRecent(data.runs); } catch { renderRecent([]); }
  }
  const runKey = 'rehearsal-patch-run';
  async function follow(runId, initial = null) {
    const mine = ++view;
    active = true; controls();
    const until = Date.now() + 21 * 60 * 1000;
    try {
      let run = initial || await json('/api/patch/runs/'+encodeURIComponent(runId));
      if (mine !== view) return;
      sessionStorage.setItem(runKey, runId);
      while (run.status === 'running') {
        status.textContent = 'Building and checking your patch in the local Sandbox…';
        if (Date.now() > until) throw new Error('Timed out waiting for the checker.');
        await new Promise(resolve => setTimeout(resolve,1500));
        if (mine !== view) return;
        run = await json('/api/patch/runs/'+encodeURIComponent(runId));
      }
      if (mine !== view) return;
      status.textContent = ''; result(run); await loadRecent();
    } catch(e) {
      if (mine !== view) return;
      status.textContent = e.message + ' You can resume this check without submitting the patch again.';
      const resume = document.createElement('button');
      resume.type = 'button'; resume.className = 'secondary'; resume.textContent = 'Resume check';
      resume.addEventListener('click', () => { resume.remove(); follow(runId); });
      status.append(document.createTextNode(' '), resume);
    } finally {
      if (mine === view) { active = false; controls(); }
    }
  }
  el('patch-form').addEventListener('submit', async ev => {
    ev.preventDefault(); if (active || pendingFile) return;
    const patch = loadedText ?? input.value; editing();
    if (!patch.trim() || new TextEncoder().encode(patch).length > max) {
      status.textContent = 'Enter a source diff of up to 64 KiB.'; input.focus(); return;
    }
    active = true; controls(); status.textContent = 'Starting the local source check…';
    try {
      const run = await json('/api/patch/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patch})});
      sessionStorage.setItem(runKey, run.id);
      await follow(run.id, run);
    } catch(e) { status.textContent = e.message; }
    finally { active = false; controls(); }
  });
  loadRecent();
  const saved = sessionStorage.getItem(runKey);
  if (saved && /^[a-f0-9-]{36}$/.test(saved)) follow(saved);
})();
