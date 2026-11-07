'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'public/repair.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, 'public/repair.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'public/repair.css'), 'utf8');

assert.match(html, /href="\/"[\s\S]*Release comparison/, 'manual release-comparison journey stays linked');
assert.match(html, /supported reproduction/i);
assert.match(html, /pinned upstream source/i);
assert.match(html, /not a live DAO/i);
assert.match(html, /Run fresh repair/);
assert.match(html, /data-phase="reproducing"/);
assert.match(html, /data-phase="generating"/);
assert.match(html, /data-phase="compiling"/);
assert.match(html, /data-phase="replaying"/);
assert.match(html, /role="status" aria-live="polite"/);
assert.match(html, /id="downloads"/);
assert.match(html, /id="error-patch"/);
assert.match(js, /Download generated patch/);
assert.match(js, /Download review bundle/);
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
assert.match(js, /const candidateCopy = candidate\.bondReturned\s*\?/, 'candidate explanation follows the measured bond check');
assert.match(js, /const healthyCopy = candidate\.healthyPayoutUnchanged\s*\?/, 'healthy-payout explanation follows the measured payout check');
assert.match(js, /const baselineCopy = baseline\.bondRetained\s*\?/, 'baseline explanation follows the measured bond check');
assert.doesNotMatch(js, /bond is no longer retained; the failed recipient still receives nothing\.<\/p>/, 'no unconditional repair claim on a rejected run');
assert.doesNotMatch(js, /The healthy Transfer still pays the declared 0\.1 NEAR recipient<\/p>/, 'no unconditional payout claim on a rejected run');

console.log(JSON.stringify({
  schema: 'near-rehearsal/repair-browser-ui-tests/v1',
  passed: true,
  checks: ['route-content', 'boundary-copy', 'phases', 'live-status', 'downloads', 'measured-result-copy', 'no-credential-form', 'no-arbitrary-input', 'reduced-motion', '44px-controls', 'case-only-request'],
}, null, 2));
