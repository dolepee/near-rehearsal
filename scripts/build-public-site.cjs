'use strict';
// Static publication only. No local API, compiler, credentials or run history.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {buildWorkbench, assertCaseFiles} = require('./build-consequence-workbench.cjs');
const {verifyPacket} = require('../case-triage/sputnik-226/review-packet/packet-model.cjs');
const ROOT = path.resolve(__dirname, '..');
const VIEW = path.join(ROOT, 'ui/sputnik/public/consequences');
const ASSETS = path.join(ROOT, 'ui/sputnik/public-release-assets');
const OUT = path.join(ROOT, '.local/public-site');
const PACKET = path.join(ROOT, 'case-triage/sputnik-226/review-packet');
const ORIGIN = 'https://rehearsal.dolepee.com';
const CANONICAL = `${ORIGIN}/consequences/`;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function trackedTree(from) {
  const relative = path.relative(ROOT, from);
  const files = execFileSync('git', ['ls-files', '-z', '--', relative], {cwd: ROOT, encoding: 'utf8'}).split('\0').filter(Boolean);
  if (!files.length) throw new Error(`No tracked publication inputs: ${relative}`);
  const allowed = new Set(files.map((file) => path.resolve(ROOT, file)));
  function inspect(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const source = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in public assets: ${source}`);
      if (entry.isDirectory()) inspect(source);
      else if (!entry.isFile() || !allowed.has(source)) throw new Error(`Unexpected publication input: ${source}`);
    }
  }
  inspect(from);
  return [...allowed].sort();
}

function assertPublicationInputs() {
  const trees = new Map();
  for (const dir of [VIEW, ASSETS, path.join(ROOT, 'LICENSES'), PACKET]) trees.set(dir, trackedTree(dir));
  return trees;
}

function copyTree(from, to, files) {
  // Copy the checked allowlist, never a fresh recursive directory listing.
  for (const source of files) {
    if (!fs.lstatSync(source).isFile()) throw new Error(`Publication input is not a regular file: ${source}`);
    const target = path.join(to, path.relative(from, source));
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(source, target);
  }
}

function buildPublicSite({out = OUT, commit} = {}) {
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('An exact source commit is required');
  const target = path.resolve(out);
  if (target === ROOT || ROOT.startsWith(`${target}${path.sep}`) || target === VIEW || target.startsWith(`${VIEW}${path.sep}`)) throw new Error('Output must not overwrite source');
  if (fs.existsSync(target)) throw new Error('Public output already exists; use a new directory');
  const trees = assertPublicationInputs();
  const data = JSON.parse(fs.readFileSync(path.join(VIEW, 'cases.json'), 'utf8'));
  assertCaseFiles(data, VIEW);
  verifyPacket(path.join(VIEW, 'downloads/226'));
  copyTree(VIEW, path.join(target, 'consequences'), trees.get(VIEW));
  copyTree(ASSETS, path.join(target, 'assets'), trees.get(ASSETS));
  copyTree(path.join(ROOT, 'LICENSES'), path.join(target, 'LICENSES'), trees.get(path.join(ROOT, 'LICENSES')));
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(ROOT, name), path.join(target, name));
  const htmlPath = path.join(target, 'consequences/index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const metadata = `
  <link rel="canonical" href="${CANONICAL}">
  <link rel="icon" href="/assets/rehearsal.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/assets/icon-180.png">
  <meta name="theme-color" content="#08110f">
  <meta property="og:type" content="website">
  <meta property="og:title" content="NEAR Rehearsal — refund Alice, preserve Bob">
  <meta property="og:description" content="Compare recorded upgrade and repair consequences. Inspect the liabilities, source identities and rerunnable evidence behind each decision.">
  <meta property="og:url" content="${CANONICAL}">
  <meta property="og:image" content="${ORIGIN}/assets/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="675">
  <meta property="og:image:alt" content="Rehearsal compares a rejected repair that clears two liabilities with a repair that releases only the bond owed.">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="NEAR Rehearsal — refund Alice, preserve Bob">
  <meta name="twitter:description" content="Recorded repair consequences, inspectable evidence, and a local reviewer handoff.">
  <meta name="twitter:image" content="${ORIGIN}/assets/og.png">`;
  if (!html.includes('</head>') || !html.includes('</footer>')) throw new Error('Workbench HTML structure changed');
  html = html.replace('</head>', `${metadata}\n</head>`).replace('No deployment, public-chain transaction, audit or universal-recovery claim.', 'No contract deployment, public-chain transaction, audit or universal-recovery claim.').replace('</footer>', `<nav class="footer-links" aria-label="Publication evidence"><a href="https://github.com/dolepee/near-rehearsal/tree/${commit}">Source revision</a><a href="https://github.com/dolepee/near-rehearsal/actions/workflows/handoff.yml">Build checks</a><a href="/release.json">Release manifest</a><a href="/THIRD_PARTY_NOTICES.md">Licenses</a></nav></footer>`);
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(path.join(target, '_redirects'), '/ /consequences/ 302\n/consequences /consequences/ 301\n');
  fs.writeFileSync(path.join(target, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
  Cache-Control: public, max-age=0, must-revalidate

/consequences/downloads/*
  X-Robots-Tag: noindex
`);
  fs.writeFileSync(path.join(target, '404.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page unavailable — NEAR Rehearsal</title><main><h1>This page is unavailable.</h1><p>The public workbench shows recorded evidence. Fresh compilation and replay run locally.</p><a href="/consequences/">Open the consequence workbench</a></main></html>');
  fs.writeFileSync(path.join(target, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /consequences/downloads/\nSitemap: ${ORIGIN}/sitemap.xml\n`);
  fs.writeFileSync(path.join(target, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${CANONICAL}</loc></url></urlset>\n`);
  const files = [];
  function inventory(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) inventory(file);
      else { const bytes = fs.readFileSync(file); const name = path.relative(target, file).split(path.sep).join('/'); files.push({path: name, served: !['_redirects', '_headers'].includes(name), bytes: bytes.length, sha256: sha(bytes)}); }
    }
  }
  inventory(target);
  const manifest = {schema: 'near-rehearsal/static-release/v1', sourceCommit: commit, canonical: CANONICAL, execution: 'recorded', cases: ['238', '226'], files: files.sort((a, b) => a.path.localeCompare(b.path))};
  fs.writeFileSync(path.join(target, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return {out: target, manifest};
}

if (require.main === module) {
  try {
    const generated = new Set(['ui/sputnik/public/consequences/cases.json', 'ui/sputnik/public/consequences/downloads/226-evidence.zip', 'ui/sputnik/public/consequences/downloads/238-evidence.zip']);
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {cwd: ROOT, encoding: 'utf8'}).trimEnd();
    const dirty = status ? status.split('\n').filter((line) => !generated.has(line.slice(3))) : [];
    if (dirty.length) throw new Error('Commit source changes before packaging a public release');
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: ROOT, encoding: 'utf8'}).trim();
    // Check before the workbench builder can copy packet files into its ZIPs.
    assertPublicationInputs();
    buildWorkbench();
    const result = buildPublicSite({commit});
    console.log(`Static publication prepared: ${path.relative(ROOT, result.out)} (${result.manifest.files.length} files)`);
    console.log(`Recorded evidence only; source ${commit}; intended hostname ${CANONICAL}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = {buildPublicSite, assertPublicationInputs, OUT, CANONICAL};
