'use strict';
(() => {
  const el = id => document.getElementById(id);
  const input = el('patch-text'), file = el('patch-file'), button = el('check'), status = el('patch-status');
  const max = 64 * 1024;
  let selection = 0, active = false, pendingFile = false, loadedText = null;
  function resetResult() { el('patch-result').hidden = true; el('patch-report').textContent = ''; el('evidence-links').replaceChildren(); }
  function controls() { button.disabled = active || pendingFile; input.disabled = file.disabled = active; }
  function editing() { resetResult(); status.textContent = ''; }
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
  async function json(url, opts) {
    const r = await fetch(url, {...opts, cache:'no-store', signal:AbortSignal.timeout(15000)}); const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'The local reviewer is unavailable.'); return d;
  }
  function result(run) {
    resetResult(); el('result-title').textContent = titles[run.status] || titles.inconclusive;
    el('result-note').textContent = run.note || 'See the checker evidence for this run.';
    if (run.report) { el('patch-report').textContent = run.report; el('patch-report').hidden = false; } else el('patch-report').hidden = true;
    for (const [key,label] of [['status','Download status'],['report','Download report'],['patch','Download submitted diff']]) {
      if (!run.downloads?.includes(key)) continue;
      const a = document.createElement('a'); a.className = 'download-button'; a.download = ''; a.href = '/api/patch/runs/'+encodeURIComponent(run.id)+'/'+key; a.textContent = label; el('evidence-links').append(a);
    }
    el('patch-result').hidden = false; el('result-title').focus();
  }
  el('patch-form').addEventListener('submit', async ev => {
    ev.preventDefault(); if (active || pendingFile) return;
    const patch = loadedText ?? input.value; editing();
    if (!patch.trim() || new TextEncoder().encode(patch).length > max) {
      status.textContent = 'Enter a source diff of up to 64 KiB.'; input.focus(); return;
    }
    active = true; controls(); status.textContent = 'Starting the local source check…';
    let runId = null;
    try {
      let run = await json('/api/patch/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patch})});
      runId = run.id; const until = Date.now() + 21 * 60 * 1000;
      while (run.status === 'running') {
        status.textContent = 'Building and checking your patch in the local Sandbox…';
        if (Date.now() > until) throw new Error('Timed out waiting for the checker.');
        await new Promise(resolve => setTimeout(resolve,1500)); run = await json('/api/patch/runs/'+encodeURIComponent(runId));
      }
      status.textContent = ''; result(run);
    } catch (e) { status.textContent = e.message + (runId ? ' This page could not confirm the outcome of the run.' : ''); }
    finally { active = false; controls(); }
  });
})();
