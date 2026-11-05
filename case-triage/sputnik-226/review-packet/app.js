'use strict';

const app = document.getElementById('app');
const statusPill = document.getElementById('run-status');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const attr = (value) => esc(value);
const badge = (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`;
const resultBadge = (result) => `<span class="result-badge ${result === 'success' ? 'good' : 'fail'}">${esc(result)}</span>`;

function linkItem(link) {
  return `<a class="link-item" href="${attr(link.href)}"><strong>${esc(link.label)}</strong><small>${esc(link.note || '')}</small></a>`;
}

function stageCard(stage, index) {
  const finality = stage.finality
    ? `target ${esc(stage.finality.target)} · finalized ${esc(stage.finality.finalized)} · ${esc(stage.finality.waitedMs)} ms`
    : 'finality not recorded';
  return `<div class="stage">
    <div class="stage-index">${String(index + 1).padStart(2, '0')}</div>
    <div class="stage-main">
      <div class="stage-top"><span class="stage-title">${esc(stage.label)}</span>${resultBadge(stage.result)}</div>
      <p class="stage-detail">${esc(stage.detail)}</p>
      <div class="stage-meta"><span><b>tx</b> ${esc(stage.transaction || '—')}</span><span><b>finality</b> ${finality}</span></div>
      ${stage.error ? `<code class="error-code">${esc(stage.error)}</code>` : ''}
    </div>
  </div>`;
}

function render(packet) {
  const result = packet.result;
  const checks = packet.checks || {};
  statusPill.className = 'status-pill';
  statusPill.textContent = packet.status;
  document.title = `Sputnik #226 — ${packet.status}`;

  const source = packet.provenance.sourceRepo;
  const commitLink = (label, commit) => `<a class="inline-action" href="${attr(`${source}/commit/${commit}`)}">${esc(commit.slice(0, 12))}</a>`;
  const rerun = packet.rerun;
  const scope = (packet.scope || []).map((item) => `<li>${esc(item)}</li>`).join('');
  const retries = (result.retries || []).map((retry) => `<div class="note-card">
    <h4>${esc(retry.label)} <span class="result-badge fail">rejected</span></h4>
    <p>Same proposal, after it was Approved and paid.</p>
    <code class="error-code">${esc(retry.error)}</code>
  </div>`).join('');
  const negative = (packet.negativeControls || []).map((control) => `<div class="note-card">
    <h4>${esc(control.label)} <span class="badge">${esc(control.status)}</span></h4>
    <p>${esc(control.detail)}</p>
    <a class="inline-action" href="${attr(control.link)}">Open raw control evidence</a>
  </div>`).join('');
  const rawLinks = (packet.rawLinks || []).map(linkItem).join('');
  const stages = (packet.stages || []).map(stageCard).join('');
  const limits = (packet.limits || []).map((item) => `<li>${esc(item)}</li>`).join('');
  const nativeStages = (checks.nativeEvidenceStages || []).join(' → ');

  app.innerHTML = `
    <section class="outcome panel">
      <div class="outcome-head">
        <div>
          <div class="eyebrow">Consequence / recorded local result</div>
          <h2>${esc(packet.headline)}</h2>
        </div>
        ${badge('Recorded local run passed', 'good')}
      </div>
      <p class="lede">${esc(packet.summary)}</p>
      <div class="badge-row">
        ${badge('Historical source')}
        ${badge('Locally constructed state')}
        ${badge('Configured-factory update')}
        ${badge('Recorded local run')}
      </div>
      <div class="scope">
        <strong>Read this as</strong>
        <ul>${scope}</ul>
      </div>
      <div class="stat-row">
        <div class="stat"><span class="stat-label">Inherited proposal</span><span class="stat-value good">#${esc(result.proposalId)} · ${esc(result.proposalStatusAfter)}</span><span class="stat-note">${esc(result.proposalStatusBefore)} → ${esc(result.proposalStatusAfterUpgrade)} → ${esc(result.proposalStatusAfter)}</span></div>
        <div class="stat"><span class="stat-label">First payment</span><span class="stat-value good">${esc(result.firstPaymentNear)} local NEAR</span><span class="stat-note">recipient ${esc(result.recipientBefore)} → ${esc(result.recipientAfterFirst)}</span></div>
        <div class="stat"><span class="stat-label">Retry routes</span><span class="stat-value good">2 rejected</span><span class="stat-note">duplicate VoteApprove + Finalize</span></div>
        <div class="stat"><span class="stat-label">Recipient after retries</span><span class="stat-value good">${esc(result.recipientAfterFinalizeRetry)} NEAR</span><span class="stat-note">total delta exactly ${esc(result.totalDeltaNear)} NEAR; config unchanged</span></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><div><div class="eyebrow">Inherited state</div><h3>Before and after the upgrade</h3></div><p>Proposal ${esc(result.proposalId)} exists before migration. The same proposal is approved after the candidate code is deployed.</p></div>
      <div class="panel panel-pad">
        <div class="timeline">${stages}</div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><div><div class="eyebrow">Exactly-once check</div><h3>Two explicit retry routes were rejected</h3></div><p>These are two tested routes, not a universal exactly-once guarantee.</p></div>
      <div class="retry-grid">${retries}</div>
      <p class="note">The recipient remained at ${esc(result.recipientAfterReplay)} NEAR after both retries; total delta stayed ${esc(result.totalDeltaNear)} local NEAR. The proposal stayed ${esc(result.proposalStatusAfterRetries)} with the root vote ${esc(result.rootVote || 'Approve')}.</p>
    </section>

    <section class="section">
      <div class="section-head"><div><div class="eyebrow">Raw evidence</div><h3>Open the receipts and source/build hashes</h3></div><p>These are links to the recorded files, not a replayed result.</p></div>
      <div class="link-list">${rawLinks}</div>
      <div class="details" style="margin-top:10px">
        <details>
          <summary>Source, build, runtime and harness pins</summary>
          <div class="details-body">
            <div class="kv-grid">
              <div class="kv"><span>Source repo</span><b><a class="inline-action" href="${attr(source)}">${esc(source)}</a></b></div>
              <div class="kv"><span>Base commit</span><b>${commitLink('base', packet.provenance.baseCommit)}</b></div>
              <div class="kv"><span>Candidate commit</span><b>${commitLink('candidate', packet.provenance.candidateCommit)}</b></div>
              <div class="kv"><span>Harness commit</span><b>${esc(packet.provenance.harnessCommit)}</b></div>
              <div class="kv"><span>Base WASM SHA-256</span><b>${esc(packet.artifacts.base.sha256)}</b></div>
              <div class="kv"><span>Candidate WASM SHA-256</span><b>${esc(packet.artifacts.candidate.sha256)}</b></div>
              <div class="kv"><span>Deployed code SHA-256</span><b>${esc(packet.artifacts.codeSha256)}</b></div>
              <div class="kv"><span>Sandbox runtime</span><b>${esc(packet.provenance.runtime.version)} · ${esc(packet.provenance.runtime.platform)}</b></div>
            </div>
          </div>
        </details>
        <details>
          <summary>What the verifier checks</summary>
          <div class="details-body">
            <div class="kv-grid">
              <div class="kv"><span>Node recorded pass</span><b>${esc(checks.nodePassed)}</b></div>
              <div class="kv"><span>Native recorded pass</span><b>${esc(checks.nativePassed)}</b></div>
              <div class="kv"><span>Proposal survived</span><b>${esc(checks.proposalSurvived)}</b></div>
              <div class="kv"><span>Config unchanged</span><b>${esc(checks.configUnchanged)}</b></div>
              <div class="kv"><span>First payment exact</span><b>${esc(checks.firstPaymentExact)}</b></div>
              <div class="kv"><span>Both retries rejected</span><b>${esc(checks.bothRetriesRejected)}</b></div>
              <div class="kv"><span>No second transfer</span><b>${esc(checks.noSecondTransfer)}</b></div>
              <div class="kv"><span>Finality targets reached</span><b>${esc(checks.finalityTargetsReached)}</b></div>
            </div>
            <p class="note">Native stage order: ${esc(nativeStages)}.</p>
            <p class="note"><strong>Offline consistency is not cryptographic proof of execution.</strong> The verifier checks hashes and recorded state; rerun the harness for an execution check.</p>
          </div>
        </details>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><div><div class="eyebrow">Negative controls</div><h3>Separate checks, not part of the success claim</h3></div><p>These probes are labelled separately from the main recorded run.</p></div>
      <div class="note-grid">${negative}</div>
    </section>

    <section class="section">
      <div class="section-head"><div><div class="eyebrow">Execution check</div><h3>Rerun with the supplied source-built WASM</h3></div><p>Read-only packet; there is no Run button and no upload flow.</p></div>
      <div class="command">
        <div class="command-head"><span>Node harness · existing near-workspaces 5.0 deps</span><button class="copy" type="button" data-copy="rerun-command">Copy command</button></div>
        <pre id="rerun-command">${esc(rerun.command)}</pre>
      </div>
      <p class="note">${esc(rerun.note)}</p>
      <div class="command" style="margin-top:10px">
        <div class="command-head"><span>Offline verifier</span><button class="copy" type="button" data-copy="verify-command">Copy command</button></div>
        <pre id="verify-command">${esc(rerun.verifier)}</pre>
      </div>
      <p class="note">${esc(rerun.artifacts)}</p>
    </section>

    <section class="section">
      <div class="warning"><strong>Scope limits.</strong><ul class="plain-list">${limits}</ul></div>
    </section>
  `;

  app.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.dataset.copy);
      if (!target) return;
      const original = button.textContent;
      try {
        await navigator.clipboard.writeText(target.textContent);
        button.textContent = 'Copied';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        button.textContent = 'Select + copy';
      }
      setTimeout(() => { button.textContent = original; }, 1800);
    });
  });
}

fetch('data/packet.json')
  .then((response) => {
    if (!response.ok) throw new Error(`packet JSON returned ${response.status}`);
    return response.json();
  })
  .then(render)
  .catch((error) => {
    statusPill.className = 'status-pill bad';
    statusPill.textContent = 'Packet unavailable';
    app.innerHTML = `<div class="panel error-state"><div class="eyebrow">Read-only packet</div><h2>The packet data did not load.</h2><p>${esc(error.message)}</p><p class="note">Check that <code>data/packet.json</code> exists and serve this directory over the local server.</p></div>`;
  });
