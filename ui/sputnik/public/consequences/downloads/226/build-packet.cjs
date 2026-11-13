'use strict';
/*
 * Build the read-only reviewer packet from actual verified-case evidence.
 * Source consistency runs before the evidence directory is replaced.
 */
const fs = require('node:fs');
const path = require('node:path');
const {derivePacket} = require('./packet-model.cjs');

const here = __dirname;
const sourceDir = path.resolve(here, '..', 'verified-case');
const evidenceDir = path.join(here, 'evidence');
const dataDir = path.join(here, 'data');

// Full source validation happens before any copy or packet write.
const packet = derivePacket(sourceDir, new Date().toISOString());

fs.rmSync(evidenceDir, {recursive: true, force: true});
fs.mkdirSync(evidenceDir, {recursive: true});
for (const file of fs.readdirSync(sourceDir)) {
  const from = path.join(sourceDir, file);
  if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(evidenceDir, file));
}
fs.mkdirSync(dataDir, {recursive: true});
fs.writeFileSync(path.join(dataDir, 'packet.json'), JSON.stringify(packet, null, 2) + '\n');
console.log(`wrote ${path.join(dataDir, 'packet.json')}`);
console.log(`copied ${fs.readdirSync(evidenceDir).length} evidence files`);
