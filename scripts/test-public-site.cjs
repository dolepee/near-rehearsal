'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {buildPublicSite, assertPublicationInputs, CANONICAL} = require('./build-public-site.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-public-'));
try {
  const out = path.join(tmp, 'site');
  const {manifest} = buildPublicSite({out, commit: '1'.repeat(40)});
  const html = fs.readFileSync(path.join(out, 'consequences/index.html'), 'utf8');
  assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
  assert.ok(html.includes(`rel="canonical" href="${CANONICAL}"`));
  for (const field of ['og:title', 'og:description', 'og:url', 'og:image', 'twitter:card', 'twitter:image']) assert.ok(html.includes(`"${field}"`), field);
  assert.match(html, /Recorded execution/);
  assert.match(html, /Run locally \/ setup/);
  assert.equal(fs.readFileSync(path.join(out, '_redirects'), 'utf8'), '/ /consequences/ 302\n/consequences /consequences/ 301\n');
  assert.ok(fs.existsSync(path.join(out, '404.html')), 'unknown routes must not silently become the app');
  assert.ok(fs.existsSync(path.join(out, 'LICENSE')));
  assert.ok(fs.existsSync(path.join(out, 'LICENSES/sputnik-dao-contract-MIT.txt')));
  for (const entry of manifest.files) {
    assert.doesNotMatch(entry.path, /(^|\/)(\.env|\.git|node_modules|auth\.json|server\.cjs)(\/|$)/);
    const bytes = fs.readFileSync(path.join(out, entry.path));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    assert.equal(bytes.length, entry.bytes);
  }
  for (const name of ['repair.html', 'review.html', 'home.html', 'server.cjs', 'package.json']) assert.equal(fs.existsSync(path.join(out, name)), false, `${name} is not a public backend`);
  const cases = JSON.parse(fs.readFileSync(path.join(out, 'consequences/cases.json')));
  for (const id of ['238', '226']) {
    const entry = cases.cases[id].downloads.evidence;
    const bytes = fs.readFileSync(path.join(out, 'consequences', entry.path));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
  const png = fs.readFileSync(path.join(out, 'assets/og.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 675);
  assert.throws(() => buildPublicSite({out, commit: '1'.repeat(40)}), /already exists/);
  for (const directory of ['ui/sputnik/public/consequences', 'case-triage/sputnik-226/review-packet']) {
    const ignored = path.join(__dirname, '..', directory, `${path.basename(tmp)}.log`);
    let created = false;
    try {
      fs.writeFileSync(ignored, 'private diagnostic fixture; must never be published\n', {flag: 'wx'});
      created = true;
      assert.throws(() => assertPublicationInputs(), /Unexpected publication input/);
      const rejected = path.join(tmp, 'rejected-site');
      assert.throws(() => buildPublicSite({out: rejected, commit: '1'.repeat(40)}), /Unexpected publication input/);
      assert.equal(fs.existsSync(rejected), false, 'unexpected input must fail before any publication output');
    } finally { if (created) fs.unlinkSync(ignored); }
  }
  console.log('public-site: isolated static output, recorded evidence parity, metadata, notices and manifest verified');
} finally { fs.rmSync(tmp, {recursive: true, force: true}); }
