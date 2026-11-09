'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'public/repair.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, 'public/repair.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'public/repair.css'), 'utf8');

assert.match(html, /href="\/"[\s\S]*Home/, 'repair page links to the maintainer front door');
assert.match(html, /href="\/compare"/, 'authored comparison has its own route');
assert.match(html, /href="\/review"/, 'reviewer handoff stays linked');
assert.match(html, /supported reproduction/i);
assert.match(html, /pinned upstream source/i);
assert.match(html, /not a live DAO/i);
assert.match(html, /Run fresh repair/);
assert.match(html, /data-phase="reproducing"/);
assert.match(html, /data-phase="generating"/);
assert.match(html, /data-phase="compiling"/);
assert.match(html, /data-phase="replaying"/);
assert.match(html, /data-phase="recovering"/);
assert.match(html, /id="recovery-panel"/);
assert.match(html, /id="recovery-checks"/);
assert.match(html, /role="status" aria-live="polite"/);
assert.match(html, /id="downloads"/);
assert.match(html, /id="review-handoff"/);
assert.match(html, /id="handoff-command"/);
assert.match(html, /replace <code>--bundle<\/code>/, 'handoff copy explains replacing the bundle path');
assert.match(html, /id="repair-identity-details"/);
assert.match(html, /id="error-patch"/);
assert.match(js, /Download generated patch/);
assert.match(js, /Download review bundle/);
assert.match(js, /repair-bundle-\$\{run\.id\}\.json/, 'handoff command uses the real download filename');
assert.match(js, /--mode recorded-wasm/, 'handoff command names the explicit review mode');
assert.match(js, /repair-review-\$\{run\.id\}/, 'handoff command names a fresh output directory');
assert.match(html, /REPAIR_SANDBOX_DIR/, 'handoff copy reuses the configured runtime');
assert.doesNotMatch(js, /--sandbox-dir \/path\/to/, 'handoff command never shows a placeholder runtime');
assert.match(js, /firstGrossRecoveryYocto/, 'accepted money card uses the measured first recovery');
assert.match(js, /firstGasYocto/, 'accepted money card uses measured gas');
assert.match(js, /secondGrossRecoveryYocto/, 'accepted retry card uses the measured retry recovery');
assert.match(js, /secondGasYocto/, 'accepted retry card uses measured retry gas');
assert.match(js, /frozenLockedAmount/, 'accepted money card uses the frozen bond value');
assert.match(js, /candidate\.wasm\.sha256/, 'technical identity exposes the candidate WASM');
assert.doesNotMatch(html, /type="password"/i, 'no browser credential form');
assert.doesNotMatch(html, /type="file"/i, 'no arbitrary browser file/path input');
assert.doesNotMatch(html, /percent|%/i, 'no made-up percentage progress');
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /min-height: 44px/);
assert.match(css, /var\(--green\)/);
assert.match(js, /Elapsed time|elapsed\(/);
assert.match(js, /caseId/);
assert.match(js, /bundleUrl/);
assert.match(js, /patchUrl/);
assert.match(js, /historySignature/, 'history polls compare the rendered run signature');
assert.match(js, /selectionVersion/, 'selection generation invalidates stale requests');
assert.match(js, /selectionCurrent\(version, runId\)/, 'poll responses are checked against the selected run');
assert.match(js, /pollLatest/, 'same-run poll requests enforce response ordering');
assert.match(js, /terminal\.has\(run\.status\)/, 'terminal poll responses invalidate older work');
assert.match(js, /aria-current/, 'selected history item is exposed accessibly');
assert.match(js, /retryBacked = checks\.authorizedRetryNoSecondRefund === true/, 'retry card requires the authoritative receipt-backed check');
assert.match(js, /retryBacked \? 'good' : 'bad'/, 'retry card styling follows the authoritative check');
assert.doesNotMatch(js, /candidate\.retryNoSecondRefund \? 'good'/, 'retry card does not use the weaker zero-delta flag');
assert.match(js, /Contract balance change after the failed proposal/, 'baseline card labels the value as a delta');
assert.match(js, /Contract balance change after the same failure/, 'candidate card labels the value as a delta');
assert.doesNotMatch(js, /Contract balance after the failed proposal/, 'no stale balance label');
assert.match(js, /const candidateCopy = candidate\.bondReturned\s*\?/, 'candidate explanation follows the measured bond check');
assert.match(js, /const healthyCopy = candidate\.healthyPayoutUnchanged\s*\?/, 'healthy-payout explanation follows the measured payout check');
assert.match(js, /const baselineCopy = baseline\.bondRetained\s*\?/, 'baseline explanation follows the measured bond check');
assert.doesNotMatch(js, /bond is no longer retained; the failed recipient still receives nothing\.<\/p>/, 'no unconditional repair claim on a rejected run');
assert.doesNotMatch(js, /The healthy Transfer still pays the declared 0\.1 NEAR recipient<\/p>/, 'no unconditional payout claim on a rejected run');

console.log(JSON.stringify({
  schema: 'near-rehearsal/repair-browser-ui-tests/v1',
  passed: true,
  checks: ['route-content', 'boundary-copy', 'phases', 'persisted-recovery-panel', 'live-status', 'downloads', 'review-handoff', 'measured-money', 'measured-result-copy', 'no-credential-form', 'no-arbitrary-input', 'reduced-motion', '44px-controls', 'case-only-request', 'history-focus', 'balance-change-label', 'retry-authoritative-check', 'selection-race-guard', 'same-run-poll-ordering'],
}, null, 2));
