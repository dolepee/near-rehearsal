'use strict';
// Package the already-verified public replay as a one-page maintainer review
// packet. This reads the evidence; it does not run a chain, deploy a contract,
// or add an acceptance test.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const out = path.join(root, 'out');
const reportPath = path.join(out, 'public-report.json');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const reportBytes = fs.readFileSync(reportPath);
const capturePath = path.join(out, 'public-capture.json');
const regressionPath = path.join(out, 'public-regression.json');
const captureBytes = fs.readFileSync(capturePath);
const regressionBytes = fs.readFileSync(regressionPath);
const capture = JSON.parse(captureBytes.toString('utf8'));
const regression = JSON.parse(regressionBytes.toString('utf8'));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sameRuntime = (a, b) => !!a && !!b
  && a.version === b.version
  && String(a.protocolVersion) === String(b.protocolVersion)
  && a.commit === b.commit;
const currentEvidence = {
  captureHash: regression.captureSha256 === sha256(captureBytes),
  captureIdentity: report.capture?.codeHash === capture.codeHash
    && report.capture?.stateHash === capture.stateHash
    && report.capture?.counter === capture.counter,
  manifestRuntime: sameRuntime(report.replayRuntime, regression.runtime)
    && report.runtimeMatch === true
    && (report.regressionRuntime === null || sameRuntime(report.regressionRuntime, regression.runtime)),
  candidateHashes: ['bad', 'corrected'].every((name) => {
    const expected = regression.candidates?.[name]?.candidate;
    return expected && sha256(fs.readFileSync(path.join(root, expected.wasm))) === expected.sha256;
  }),
  structuredBadFailure: report.branches?.bad?.operation?.tx?.failed === true
    && report.branches?.bad?.operation?.succeeded === false
    && !!report.branches?.bad?.operation?.tx?.failure,
};
if (Object.values(currentEvidence).some((value) => value !== true)) {
  throw new Error(`release-review packet evidence does not match current files: ${JSON.stringify(currentEvidence)}`);
}

if (report.status !== 'complete' || report.result?.status !== 'complete') {
  throw new Error('release-review packet requires a complete public report');
}
if (report.runtimeMatch !== true) throw new Error('release-review packet requires a matching declared runtime');
if (report.result?.regressionObserved !== true || report.result?.correctionObserved !== true) {
  throw new Error('release-review packet requires observed regression and correction');
}
if (report.result?.sameStartingState !== true) throw new Error('release-review packet requires a shared starting state');

const e = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));
const shortHash = (value, n = 16) => {
  const s = String(value ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const txHash = (branch) => branch?.operation?.tx?.transactionHash ?? 'n/a';
const migration = (branch) => branch?.migration;
const migrationTx = (branch) => branch?.migration?.transactionHash ?? 'n/a';
const failure = report.branches.bad.operation?.tx?.failure;
const runtime = report.replayRuntime || {};
const declared = report.regressionRuntime || runtime;

const evidence = {
  schema: 'near-rehearsal/release-review/v1',
  generatedAt: report.generatedAt,
  sourceContract: report.sourceContract,
  capture: report.capture,
  operation: report.operation,
  runtime,
  declaredRuntime: declared,
  runtimeMatch: report.runtimeMatch,
  status: report.status,
  branches: {
    baseline: {status: report.branches.baseline.status, transactionHash: txHash(report.branches.baseline), value: report.branches.baseline.operation?.value ?? null},
    bad: {status: report.branches.bad.status, transactionHash: txHash(report.branches.bad), failed: report.branches.bad.operation?.tx?.failed === true, failure, migration: migration(report.branches.bad)},
    corrected: {status: report.branches.corrected.status, transactionHash: txHash(report.branches.corrected), value: report.branches.corrected.operation?.value ?? null, migration: migration(report.branches.corrected)},
  },
  result: report.result,
  checksums: {
    publicCaptureSha256: sha256(captureBytes),
    publicRegressionSha256: sha256(regressionBytes),
    publicReportSha256: sha256(reportBytes),
  },
  claimBoundary: 'Read-only public testnet capture at a fixed final block; local Sandbox replay only. The bad migration is deliberately seeded. No public write, deployment, production upgrade authorization, or live vulnerability is claimed.',
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NEAR release-review packet — counter.testnet</title>
<style>
:root{color-scheme:light;--ink:#17211c;--muted:#56645b;--line:#c8d0c9;--paper:#f5f2e8;--panel:#fffdf7;--accent:#245c45;--bad:#8a2f2f;--good:#245c45}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:34px 28px 42px}
header{border-bottom:3px solid var(--ink);padding-bottom:16px;margin-bottom:20px}
.eyebrow{font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 8px}
h1{font-size:clamp(28px,5vw,48px);line-height:1.02;letter-spacing:-.035em;margin:0 0 10px;max-width:760px}
.deck{font-size:16px;color:var(--muted);max-width:760px;margin:0}
.grid{display:grid;grid-template-columns:1.12fr .88fr;gap:16px;margin:18px 0}
section{background:var(--panel);border:1px solid var(--line);padding:16px 18px;break-inside:avoid}
h2{font-size:12px;letter-spacing:.13em;text-transform:uppercase;color:var(--accent);margin:0 0 10px}
p{margin:0 0 10px}
dl{display:grid;grid-template-columns:minmax(120px,auto) 1fr;gap:6px 12px;margin:0}
dt{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;overflow-wrap:anywhere}
code{font:inherit;background:#eef0e8;padding:1px 4px;border-radius:3px}
.verdict{border-left:5px solid var(--good);padding:14px 16px;background:#edf3ea;margin:16px 0}
.verdict strong{display:block;font-size:17px;margin-bottom:3px}
.failure{border-left:5px solid var(--bad);padding:12px 14px;background:#f7ecea;margin:0 0 10px}
.failure strong{color:var(--bad)}
.small{font-size:12.5px;color:var(--muted)}
ul{margin:8px 0 0 20px;padding:0}
li{margin:5px 0}
.footer{border-top:1px solid var(--line);margin-top:18px;padding-top:12px;font-size:12px;color:var(--muted)}
@media (max-width:760px){main{padding:22px 16px 32px}.grid{grid-template-columns:1fr}header{padding-bottom:12px}}
@media print{body{background:#fff}main{max-width:none;padding:0}section{background:#fff}.grid{gap:10px}}
</style>
</head>
<body>
<main>
<header>
  <p class="eyebrow">Release review · existing verified case</p>
  <h1>State migration review for <code>${e(report.sourceContract)}</code></h1>
  <p class="deck">A read-only public capture is imported into a local NEAR Sandbox. The declared migration is applied, the same user operation is replayed, and a deliberately bad candidate is checked for a receipt-level failure.</p>
</header>

<div class="verdict">
  <strong>Bounded result: pass for this rehearsal.</strong>
  <span class="small">The declared corrected migration preserved the captured state and the user operation; the seeded bad migration failed on its receipt. This is evidence about this case, not a production approval.</span>
</div>

<div class="grid">
  <section>
    <h2>Captured baseline</h2>
    <dl>
      <dt>Contract</dt><dd>${e(report.sourceContract)}</dd>
      <dt>Block</dt><dd>${e(report.capture.blockHeight)}</dd>
      <dt>Block hash</dt><dd>${e(shortHash(report.capture.blockHash, 24))}</dd>
      <dt>Code hash</dt><dd>${e(report.capture.codeHash)}</dd>
      <dt>Source build</dt><dd>${e(shortHash(report.capture.source.sourceBuildSha256, 24))}</dd>
      <dt>Source match</dt><dd>${report.capture.source.sourceBuildMatchesDeployed ? 'yes — deployed bytes match source build' : 'NO'}</dd>
      <dt>State</dt><dd>${e(report.capture.stateBytes)} bytes · counter ${e(report.capture.counter)}</dd>
      <dt>Runtime</dt><dd>${e(runtime.version)} · protocol ${e(runtime.protocolVersion)}</dd>
    </dl>
  </section>
  <section>
    <h2>Replay result</h2>
    <dl>
      <dt>Operation</dt><dd>${e(report.operation.method)}(${e(JSON.stringify(report.operation.args))}) → ${e(report.operation.view)}</dd>
      <dt>Baseline</dt><dd>${e(report.branches.baseline.operation?.value ?? 'n/a')} · tx ${e(shortHash(txHash(report.branches.baseline), 20))}</dd>
      <dt>Bad candidate</dt><dd>${e(report.branches.bad.status)} · receipt failed: ${report.branches.bad.operation?.tx?.failed === true ? 'yes' : 'no'}</dd>
      <dt>Corrected</dt><dd>${e(report.branches.corrected.operation?.value ?? 'n/a')} · tx ${e(shortHash(txHash(report.branches.corrected), 20))}</dd>
      <dt>Shared start</dt><dd>${report.result.sameStartingState ? 'yes' : 'NO'}</dd>
      <dt>Runtime match</dt><dd>${report.runtimeMatch ? 'yes' : 'NO'}</dd>
    </dl>
  </section>
</div>

<section>
  <h2>What the reviewer can verify</h2>
  <ul>
    <li>The public contract's deployed code hash is pinned to the captured block and the recorded source build.</li>
    <li>The captured state is imported into local Sandbox; each branch starts from the same state hash.</li>
    <li>The bad migration is deliberately seeded and its failure is a structured transaction receipt, not a missing read or transport error.</li>
    <li>The corrected migration completes, and the same user operation advances the counter.</li>
    <li>The replay is rerunnable from <code>out/public-regression.json</code>; the runtime declaration is checked against the actual run.</li>
  </ul>
</section>

<div class="grid">
  <section>
    <h2>Seeded bad migration</h2>
    <div class="failure"><strong>Receipt failure:</strong> ${e(failure?.FunctionCallError?.ExecutionError ?? failure?.ActionError?.kind?.FunctionCallError?.ExecutionError ?? 'structured failure recorded')}</div>
    <dl>
      <dt>Migration tx</dt><dd>${e(migrationTx(report.branches.bad))}</dd>
      <dt>Before state</dt><dd>${e(shortHash(migration(report.branches.bad)?.beforeState, 24))}</dd>
      <dt>After state</dt><dd>${e(shortHash(migration(report.branches.bad)?.afterState, 24))}</dd>
      <dt>Change observed</dt><dd>${migration(report.branches.bad)?.changedState ? 'yes — bad candidate mutated state before failing' : 'no'}</dd>
    </dl>
  </section>
  <section>
    <h2>Corrected migration</h2>
    <dl>
      <dt>Migration tx</dt><dd>${e(migrationTx(report.branches.corrected))}</dd>
      <dt>Before state</dt><dd>${e(shortHash(migration(report.branches.corrected)?.beforeState, 24))}</dd>
      <dt>After state</dt><dd>${e(shortHash(migration(report.branches.corrected)?.afterState, 24))}</dd>
      <dt>Counter after</dt><dd>${e(report.branches.corrected.operation?.value ?? 'n/a')}</dd>
    </dl>
  </section>
</div>

<section>
  <h2>Reproduce and inspect</h2>
  <p class="small">From the repository, with the pinned local Sandbox runtime available:</p>
  <p><code>npm run replay:public</code> then <code>npm run verify:public</code></p>
  <p class="small">The regression manifest declares runtime <code>${e(declared.version)}</code>, protocol <code>${e(declared.protocolVersion)}</code>, commit <code>${e(shortHash(declared.commit, 12))}</code>. The replay records the actual runtime and refuses to report a complete regression if they differ.</p>
</section>

<section>
  <h2>Scope and limits</h2>
  <ul>
    <li>Read-only capture: no public write, deployment, upgrade authorization, or production state change was performed.</li>
    <li>Execution is local NEAR Sandbox, not public testnet or mainnet. Native NEAR state and receipts are the subject; this is not a claim about Tempo custody or an external payment.</li>
    <li>The bad migration is intentionally seeded for contrast. The packet does not claim a live vulnerability or a general recovery capability.</li>
    <li>This is one small-state case with one operation. It does not establish adoption, maintainer preference, or release approval.</li>
  </ul>
</section>

<div class="footer">
  Evidence files: <code>out/public-capture.json</code> · <code>out/public-report.json</code> · <code>out/public-regression.json</code><br>
  Capture SHA-256: <code>${e(evidence.checksums.publicCaptureSha256)}</code><br>
  Regression SHA-256: <code>${e(evidence.checksums.publicRegressionSha256)}</code><br>
  Report SHA-256: <code>${e(evidence.checksums.publicReportSha256)}</code>
</div>
</main>
</body>
</html>
`;

fs.writeFileSync(path.join(out, 'release-review.json'), JSON.stringify(evidence, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'release-review.html'), html);
console.log(JSON.stringify({
  html: 'out/release-review.html',
  json: 'out/release-review.json',
  status: report.status,
  runtimeMatch: report.runtimeMatch,
  checksums: evidence.checksums,
}, null, 2));
