'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const home = fs.readFileSync(path.join(root, 'public', 'home.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.cjs'), 'utf8');
const repair = fs.readFileSync(path.join(root, 'public', 'repair.html'), 'utf8');
const review = fs.readFileSync(path.join(root, 'public', 'review.html'), 'utf8');
const compare = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

assert.match(home, /Repair a stranded proposal bond/);
assert.match(home, /Sputnik #238/);
assert.match(home, /href="\/repair"[\s\S]*Generate a fresh repair/);
assert.match(home, /href="\/review"[\s\S]*Independently review a repair/);
assert.match(home, /No model account required/);
assert.match(home, /remains Failed/);
assert.match(home, /does not re-execute the failed payment/);
assert.match(home, /Not a live DAO/);
assert.doesNotMatch(home, /<script/i, 'front door does not start execution');

assert.match(server, /url\.pathname === '\/'\) return file\(res, 'home\.html'\)/);
assert.match(server, /url\.pathname === '\/compare'[\s\S]*url\.pathname === '\/index\.html'\) return file\(res, 'index\.html'\)/);
assert.match(repair, /href="\/"[\s\S]*Home/);
assert.match(repair, /href="\/compare"[\s\S]*Authored comparison/);
assert.match(repair, /href="\/review"[\s\S]*Review a bundle/);
assert.match(review, /href="\/"[\s\S]*Home/);
assert.match(review, /href="\/compare"[\s\S]*Authored comparison/);
assert.match(compare, /href="\/"[\s\S]*Home/);
assert.match(compare, /href="\/repair"[\s\S]*Generate a repair/);
assert.match(compare, /href="\/review"[\s\S]*Review a bundle/);

console.log(JSON.stringify({
  schema: 'near-rehearsal/front-door-tests/v1',
  passed: true,
  checks: ['supported-problem', 'two-actions', 'legacy-index-alias', 'compare-route', 'navigation'],
}, null, 2));
