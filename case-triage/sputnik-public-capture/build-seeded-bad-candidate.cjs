'use strict';
/*
 * Build a deliberately seeded, clearly labelled bad candidate:
 * the candidate's exported `act_proposal` body is replaced with `unreachable`.
 * Migration remains the real candidate migration; only the existing obligation
 * operation is broken. This is a test fixture, not a historical release.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const here = __dirname;
const repo = path.resolve(here, '../../..');
const wabt = process.env.WABT_BIN_DIR || path.join(repo, 'node_modules', 'wabt', 'bin');
const input = path.resolve(here, '../sputnik-226/verified-case/candidate.wasm');
const wat = path.join(here, 'artifacts', 'candidate-seeded-bad.wat');
const output = path.join(here, 'artifacts', 'candidate-seeded-bad.wasm');
if (!fs.existsSync(path.join(wabt, 'wasm2wat'))) throw new Error(`wabt binaries not found: ${wabt}`);
let r = spawnSync(path.join(wabt, 'wasm2wat'), [input, '-o', wat], { encoding: 'utf8' });
if (r.status !== 0) throw new Error(r.stderr || 'wasm2wat failed');
let text = fs.readFileSync(wat, 'utf8');
const start = text.indexOf('  (func (;631;) (type 6)');
const next = text.indexOf('  (func (;632;)', start);
if (start < 0 || next < 0) throw new Error('could not locate act_proposal function 631');
const replacement = '  (func (;631;) (type 6)\n    unreachable)\n';
text = text.slice(0, start) + replacement + text.slice(next);
fs.writeFileSync(wat, text);
r = spawnSync(path.join(wabt, 'wat2wasm'), [wat, '-o', output], { encoding: 'utf8' });
if (r.status !== 0) throw new Error(r.stderr || 'wat2wasm failed');
r = spawnSync(path.join(wabt, 'wasm-validate'), [output], { encoding: 'utf8' });
if (r.status !== 0) throw new Error(r.stderr || 'wasm-validate failed');
console.log(JSON.stringify({ input, output, sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(output)).digest('hex'), bytes: fs.statSync(output).size }, null, 2));
