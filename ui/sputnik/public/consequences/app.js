'use strict';

(() => {
  const root = document.getElementById('workbench');
  const case238 = document.getElementById('case-238');
  const case226 = document.getElementById('case-226');
  const content238 = document.getElementById('case-238-content');
  const content226 = document.getElementById('case-226-content');
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  let data = null;
  let selected = 'clear-all';
  const model = globalThis.ConsequenceModel;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const attr = (value) => esc(value);
  const short = (value, length = 14) => {
    const text = String(value || '');
    return text.length > length ? `${text.slice(0, length)}…` : text;
  };
  const statusClass = (status) => {
    const value = String(status || '').toLowerCase();
    return value === 'failed' ? 'status-failed'
      : value === 'inprogress' ? 'status-pending'
        : value === 'approved' ? 'status-approved'
          : value === '' ? 'status-unread' : '';
  };
  const proposalStatus = (stage, name) => stage.proposals?.[name]?.status || 'not re-read';
  const resultClass = (result, expected) => result === 'success' ? 'success' : expected ? 'expected' : 'failure';

  function nearText(yocto, maxDigits = 4) {
    let value;
    try { value = BigInt(String(yocto)); } catch { return 'unavailable'; }
    const negative = value < 0n;
    if (negative) value = -value;
    const whole = value / 1000000000000000000000000n;
    const fraction = value % 1000000000000000000000000n;
    let digits = fraction.toString().padStart(24, '0').replace(/0+$/, '');
    if (digits.length > maxDigits) digits = digits.slice(0, maxDigits);
    const text = digits ? `${whole}.${digits}` : String(whole);
    return `${negative ? '−' : ''}${text}`;
  }

  function nearDelta(yocto, maxDigits = 4) {
    let value;
    try { value = BigInt(String(yocto)); } catch { return 'unavailable'; }
    return `${value > 0n ? '+' : value < 0n ? '−' : ''}${nearText(value < 0n ? -value : value, maxDigits)} NEAR`;
  }

  function titleCase(value) {
    return String(value || '').replace(/(^|[\s-])([a-z])/g, (_, prefix, char) => `${prefix}${char.toUpperCase()}`);
  }

  function unavailable(label) {
    return `<div class="error-card"><strong>${esc(label)} unavailable</strong><p>This recorded artifact is missing or malformed, so no result is being shown. Check the evidence download and the source pins before relying on it.</p></div>`;
  }

  function invalidEvidence(label, reason) {
    return `<div class="error-card"><strong>${esc(label)} invalid</strong><p>The recorded decision metadata is inconsistent: ${esc(reason)}. The page will not label this evidence as accepted.</p></div>`;
  }

  function negateYocto(value) {
    try { return String(-BigInt(String(value))); } catch { return '0'; }
  }

  function loadFailure(message) {
    const text = `The recorded consequence data could not be loaded. ${message}`;
    content238.innerHTML = `<div class="error-card" role="alert"><strong>Evidence unavailable</strong><p>${esc(text)}</p><p>This page does not substitute a green result when its data is missing. The local evidence directory and checksums are the source of truth.</p></div>`;
    content226.innerHTML = `<div class="error-card" role="alert"><strong>Evidence unavailable</strong><p>${esc(text)}</p></div>`;
  }

  function render238() {
    const record = data?.cases?.['238'];
    if (!model || typeof model.validateRepairCandidate !== 'function') {
      content238.innerHTML = unavailable('#238 evidence model');
      return;
    }
    if (!record || !Array.isArray(record.candidates) || record.candidates.length < 1 || !record.baseline) {
      content238.innerHTML = unavailable('#238 evidence');
      return;
    }
    const candidate = record.candidates.find((item) => item.id === selected) || record.candidates[0];
    const verdict = model.validateRepairCandidate(candidate);
    if (!verdict.ok) {
      content238.innerHTML = invalidEvidence('#238 candidate', verdict.reason);
      return;
    }
    const locked = candidate.stages.map((stage) => nearText(stage.locked));
    const baseline = record.baseline.stages?.[0];
    const bad = candidate.status === 'REJECTED';
    const errors = Array.isArray(candidate.errors) ? candidate.errors : [];
    const status = bad ? 'REJECTED' : 'ACCEPTED';
    const statusText = bad ? 'Liability erased' : 'Liability preserved';

    const candidateButtons = record.candidates.map((item) => `
      <button class="candidate-button" type="button" data-candidate="${attr(item.id)}" aria-pressed="${item.id === candidate.id}">
        ${esc(item.label)}<span>${esc(item.status)}</span>
      </button>`).join('');

    const rows = [
      ['Contract locked liability', (stage) => `<span class="value ${stage.locked === '0' ? 'zero' : 'liability'}">${nearText(stage.locked)} NEAR</span>`],
      ['Alice proposal', (stage) => `<span class="status-text ${statusClass(stage.proposals?.alice?.status)}">${esc(proposalStatus(stage, 'alice'))}</span>`],
      ['Bob proposal', (stage) => `<span class="status-text ${statusClass(stage.proposals?.bob?.status)}">${esc(proposalStatus(stage, 'bob'))}</span>`],
      ['Carol proposal', (stage) => `<span class="status-text ${statusClass(stage.proposals?.carol?.status)}">${esc(proposalStatus(stage, 'carol'))}</span>`],
    ];

    const ledger = `
      <div class="ledger-card">
        <div class="ledger-scroll" tabindex="0" aria-label="Recorded obligation ledger; scroll sideways for later stages">
          <table class="ledger">
            <thead><tr><th scope="col">Obligation</th>${candidate.stages.map((stage) => `<th scope="col">${esc(stage.label)}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(([label, value]) => `<tr><td class="row-label">${esc(label)}</td>${candidate.stages.map((stage) => `<td>${value(stage)}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>
        </div>
        <p class="mobile-note">The ledger scrolls sideways on a narrow screen; the page itself does not.</p>
      </div>`;

    const errorList = errors.length
      ? `<ul>${errors.map((error) => `<li>${esc(error)}</li>`).join('')}</ul>`
      : '<p class="cash-note">All declared payout and liability-release checks passed.</p>';

    content238.innerHTML = `
      <div class="case-head">
        <div>
          <div class="eyebrow">Recorded repair decision / ${esc(candidate.label)}</div>
          <h2>Refund Alice. Preserve Bob.</h2>
          <p>Alice’s failed proposal holds a 1 NEAR bond. Bob has an inherited 1 NEAR obligation plus a 0.1 NEAR funded Transfer. A repair must release Alice without deleting Bob’s liability before his operation runs.</p>
        </div>
        <span class="recorded-label">● Recorded execution</span>
      </div>

      <div class="candidate-switch" role="group" aria-label="Choose a recorded repair">
        ${candidateButtons}
      </div>

      <div class="decision-grid">
        <section class="decision-card ${bad ? 'rejected' : 'accepted'}" aria-labelledby="decision-title">
          <div class="decision-status">
            <span class="status-badge ${bad ? 'rejected' : 'accepted'}">${status}</span>
            <span class="eyebrow">${esc(statusText)}</span>
          </div>
          <h3 id="decision-title">${bad ? 'The refund looks right. The ledger is wrong.' : 'The refund releases one bond. The other stays owed.'}</h3>
          <p>${esc(candidate.summary)}</p>
          <div class="why">
            <strong>${bad ? 'Why the policy rejects it' : 'What the policy checked'}</strong>
            ${errorList}
          </div>
        </section>

        <aside class="cash-card" aria-labelledby="cash-title">
          <h3 id="cash-title">Cash movements that still pass</h3>
          <div class="cash-list">
            <div class="cash-row"><span>Alice bond returned (gross)</span><b>${nearDelta(candidate.cash.aliceBondGross)}</b></div>
            <div class="cash-row"><span>Gas charged to Alice</span><b>${nearDelta(negateYocto(candidate.cash.aliceGas), 8)}</b></div>
            <div class="cash-row"><span>Alice net after gas</span><b>${nearDelta(candidate.cash.aliceBondNet)}</b></div>
            <div class="cash-row"><span>Bob funded transfer</span><b>${nearDelta(candidate.cash.bobTransfer)}</b></div>
            <div class="cash-row"><span>Bob bond return</span><b>${nearDelta(candidate.cash.bobBondReturned)}</b></div>
            <div class="cash-row"><span>Bob contract debit</span><b>${nearDelta(candidate.cash.bobContractDelta)}</b></div>
          </div>
          <p class="cash-note">${bad ? 'Bob did not lose his money. This bad candidate still pays the funded operation; it fails the locked-liability release condition. The +0.9993 figure is Alice’s net proposer change after measured gas, not the gross 1 NEAR bond. Displayed amounts are rounded; exact yocto values are in the recorded report.' : 'This repair pays the same funded operation while preserving Bob’s liability until it is released. The +0.9993 figure is Alice’s net proposer change after measured gas, not the gross 1 NEAR bond. Displayed amounts are rounded; exact yocto values are in the recorded report.'}</p>
        </aside>
      </div>

      <div class="section-title">
        <h3>Obligation ledger across the recorded run</h3>
        <p>Baseline locked liability: ${baseline ? `${nearText(baseline.locked)} NEAR` : 'unavailable'}</p>
      </div>
      ${ledger}

      <div class="two-col">
        <section class="provenance-card" aria-labelledby="identity-title">
          <h3 id="identity-title">Source, patch and policy identity</h3>
          <dl class="detail-list">
            <div class="detail-row"><dt>Pinned source</dt><dd>${esc(short(record.source?.commit, 18))}</dd></div>
            <div class="detail-row"><dt>Upstream issue</dt><dd><a href="${attr(record.source?.issue)}">Sputnik #238</a></dd></div>
            <div class="detail-row"><dt>Runtime</dt><dd>Sandbox ${esc(record.runtime?.version)} · protocol ${esc(record.runtime?.protocol)}</dd></div>
            <div class="detail-row"><dt>Base WASM</dt><dd><span class="hash">${esc(record.source?.baseWasmSha256)}</span></dd></div>
            <div class="detail-row"><dt>Candidate WASM</dt><dd><span class="hash">${esc(candidate.candidate?.wasm?.sha256)}</span></dd></div>
            <div class="detail-row"><dt>Patch</dt><dd><span class="hash">${candidate.candidate?.patch ? esc(candidate.candidate.patch.sha256) : 'no repair patch'}</span></dd></div>
            <div class="detail-row"><dt>Policy</dt><dd><span class="hash">${esc(record.policy?.sha256)}</span></dd></div>
          </dl>
        </section>

        <section class="evidence-card" aria-labelledby="evidence-title">
          <h3 id="evidence-title">Evidence and downloads</h3>
          <ul class="download-list">
            <li><a href="${attr(record.downloads?.evidence?.path)}">Complete #238 evidence zip <small>${esc(record.downloads?.evidence?.bytes || '')} bytes</small></a></li>
            ${candidate.candidate?.patch ? `<li><a href="${attr(candidate.candidate.patch.path)}">Download ${esc(candidate.label)} patch <small>${esc(candidate.candidate.patch.sha256.slice(0, 12))}…</small></a></li>` : ''}
            <li><a href="${attr(candidate.candidate?.wasm?.path)}">Download ${esc(candidate.label)} WASM <small>${esc(candidate.candidate?.wasm?.sha256?.slice(0, 12) || '')}…</small></a></li>
            <li><a href="downloads/238/README.md">Review reproduction notes <small>prerequisites + command</small></a></li>
          </ul>
          <details>
            <summary>Show the supported source-review command</summary>
            <pre class="command">${esc(candidate.status === 'ACCEPTED' ? record.commands?.intended : record.commands?.review)}</pre>
            <p class="cash-note">Run from a clean checkout at the pinned source commit with Sandbox 2.14.0. This is a fresh local source-build check, not the recorded result shown above. The exact patch, report and verifier output are in the download.</p>
          </details>
        </section>
      </div>

      <div class="warning"><strong>Scope.</strong> ${bad ? 'The #238 failure is an accounting failure in the repair: cash movements look plausible, but the aggregate locked liability drops from 2 NEAR to 0 before Bob’s operation.' : 'This accepted record releases Alice’s bond while preserving Bob’s inherited liability until his funded operation.'} The recorded state is local Sandbox state, not a live DAO or a mainnet capture.</div>`;
  }

  function render226() {
    if (!model || typeof model.validateUpgrade !== 'function') {
      content226.innerHTML = unavailable('#226 evidence model');
      return;
    }
    const record = data?.cases?.['226'];
    if (!record) {
      content226.innerHTML = unavailable('#226 evidence');
      return;
    }
    const verdict = model.validateUpgrade(record);
    if (!verdict.ok) {
      content226.innerHTML = invalidEvidence('#226 evidence', verdict.reason);
      return;
    }
    const timeline = record.stages.map((stage, index) => {
      const isRetry = stage.id === 'replay' || stage.id === 'finalizeRetry';
      const label = isRetry ? 'Blocked as expected' : stage.result;
      const raw = stage.error ? `<details><summary>Raw RPC failure</summary><pre class="command">${esc(stage.error)}</pre></details>` : '';
      const finality = stage.finality ? `target ${esc(stage.finality.target)} · finalized ${esc(stage.finality.finalized)} · ${esc(stage.finality.waitedMs)} ms` : 'finality not recorded';
      return `<div class="timeline-item">
        <div class="timeline-index">${String(index + 1).padStart(2, '0')}</div>
        <div>
          <div class="timeline-top"><strong>${esc(stage.label)}</strong><span class="result-badge ${resultClass(stage.result, isRetry)}">${esc(label)}</span></div>
          <p class="timeline-detail">${esc(stage.detail)}</p>
          <div class="timeline-meta"><span>tx ${esc(short(stage.transaction, 20))}</span><span>${esc(finality)}</span></div>
          ${raw}
        </div>
      </div>`;
    }).join('');

    const rawLinks = (record.packet?.href ? `<li><a href="${attr(record.packet.href)}">Open the full recorded #226 packet <small>timeline + raw evidence</small></a></li>` : '')
      + (record.downloads?.evidence?.path ? `<li><a href="${attr(record.downloads.evidence.path)}">Download the #226 evidence zip <small>${esc(record.downloads.evidence.bytes || '')} bytes</small></a></li>` : '');

    content226.innerHTML = `
      <div class="case-head">
        <div>
          <div class="eyebrow">Recorded upgrade compatibility / Sputnik #226</div>
          <h2>An inherited proposal survives the update.</h2>
          <p>${esc(record.summary)}</p>
        </div>
        <span class="recorded-label">● Recorded local run</span>
      </div>

      <div class="decision-grid">
        <section class="decision-card accepted" aria-labelledby="case226-title">
          <div class="decision-status"><span class="status-badge accepted">PASS</span><span class="eyebrow">recorded local run</span></div>
          <h3 id="case226-title">Old proposal. New code. One payment.</h3>
          <p>${esc(record.headline)}</p>
          <div class="stat-grid">
            <div class="stat"><span>Proposal</span><b>#${esc(record.result.proposalId)}</b><small>${esc(record.result.proposalStatusBefore)} → ${esc(record.result.proposalStatusAfter)}</small></div>
            <div class="stat"><span>First payment</span><b>${esc(record.result.firstPaymentNear)} NEAR</b><small>local funds only</small></div>
            <div class="stat"><span>Retries</span><b>2 rejected</b><small>VoteApprove + Finalize</small></div>
            <div class="stat"><span>Recipient delta</span><b>${esc(record.result.totalDeltaNear)} NEAR</b><small>after both retries</small></div>
          </div>
        </section>

        <aside class="cash-card" aria-labelledby="case226-boundary">
          <h3 id="case226-boundary">What this case is not</h3>
          <div class="cash-list">
            <div class="cash-row"><span>Mode</span><b>configured-factory update</b></div>
            <div class="cash-row"><span>State</span><b>locally constructed</b></div>
            <div class="cash-row"><span>Runtime</span><b>Sandbox ${esc(record.runtime?.version)}</b></div>
            <div class="cash-row"><span>Governance</span><b>not UpgradeSelf</b></div>
          </div>
          <p class="cash-note">Upstream PR #226, not a captured mainnet state. The #226 runtime is separate from #238’s Sandbox 2.14.0. Recorded evidence is not a fresh execution.</p>
        </aside>
      </div>

      <div class="section-title"><h3>Recorded upgrade timeline</h3><p>Source pins ${esc(short(record.source?.baseCommit, 12))} → ${esc(short(record.source?.candidateCommit, 12))}</p></div>
      <section class="timeline-card" aria-label="Recorded #226 timeline">
        <div class="timeline">${timeline}</div>
      </section>

      <div class="two-col">
        <section class="provenance-card" aria-labelledby="case226-provenance">
          <h3 id="case226-provenance">Provenance and scope</h3>
          <dl class="detail-list">
            <div class="detail-row"><dt>Source</dt><dd><a href="${attr(record.source?.repository)}">near-daos/sputnik-dao-contract</a></dd></div>
            <div class="detail-row"><dt>Upstream PR</dt><dd>#${esc(record.source?.pr)}</dd></div>
            <div class="detail-row"><dt>Base commit</dt><dd><span class="hash">${esc(record.source?.baseCommit)}</span></dd></div>
            <div class="detail-row"><dt>Candidate commit</dt><dd><span class="hash">${esc(record.source?.candidateCommit)}</span></dd></div>
            <div class="detail-row"><dt>Harness</dt><dd><span class="hash">${esc(record.source?.harnessCommit || 'recorded in packet')}</span></dd></div>
            <div class="detail-row"><dt>Runtime</dt><dd>Sandbox ${esc(record.runtime?.version)} · ${esc(record.runtime?.platform)}</dd></div>
          </dl>
          <details><summary>Show scope boundaries</summary><ul class="scope-list">${(record.scope || []).map((item) => `<li>${esc(item)}</li>`).join('')}</ul></details>
        </section>

        <section class="evidence-card" aria-labelledby="case226-evidence">
          <h3 id="case226-evidence">Evidence and downloads</h3>
          <ul class="download-list">${rawLinks}</ul>
          <details>
            <summary>Show the recorded rerun and verifier commands</summary>
            <pre class="command">${esc(record.commands?.rerun || '')}</pre>
            <pre class="command" style="margin-top:8px">${esc(record.commands?.verify || '')}</pre>
            <p class="cash-note">${esc(record.commands?.note || '')} Offline packet verification checks recorded consistency, not cryptographic proof of execution. The rerun is the execution check.</p>
            <p class="cash-note">${esc(record.commands?.prerequisite || '')}</p>
          </details>
          <div class="warning"><strong>Recorded, not fresh.</strong> This timeline comes from the verified local packet. The page does not start the #226 runner. A fresh local replay is a separate action with its own runtime and output.</div>
        </section>
      </div>`;
  }

  function bind238() {
    if (!model?.bindCandidateSwitch) return;
    model.bindCandidateSwitch(content238, (candidateId) => {
      selected = candidateId;
      render238();
      const replacement = content238.querySelector(`[data-candidate="${candidateId}"]`);
      if (replacement) replacement.focus({preventScroll: true});
    });
  }

  function render() {
    render238();
    render226();
    bind238();
  }

  function selectTab(caseId, focus = false) {
    const is238 = caseId === '238';
    tabs.forEach((tab) => {
      const active = tab.dataset.case === caseId;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    });
    case238.hidden = !is238;
    case226.hidden = is238;
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      selectTab(tab.dataset.case);
      history.replaceState(null, '', tab.dataset.case === '226' ? '#case-226' : '#case-238');
    });
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const next = event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
        : event.key === 'ArrowRight' ? (index + 1) % tabs.length
          : event.key === 'Home' ? 0 : tabs.length - 1;
      selectTab(tabs[next].dataset.case, true);
    });
  });

  fetch('cases.json', {cache: 'no-store'})
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((json) => {
      if (!json || json.schema !== 'near-rehearsal/consequence-workbench/v1' || !json.cases) {
        throw new Error('unexpected evidence schema');
      }
      data = json;
      render();
      bind238();
      if (location.hash === '#case-226') selectTab('226');
    })
    .catch((error) => loadFailure(error.message));
})();
