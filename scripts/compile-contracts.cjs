'use strict';
const fs = require('node:fs');
const path = require('node:path');
const wabt = require('wabt');
(async () => {
  const root = path.join(__dirname, '..', 'contracts');
  const mod = await wabt();
  for (const name of ['state-v1', 'state-v2-buggy', 'state-v2-fixed']) {
    const wat = fs.readFileSync(path.join(root, `${name}.wat`), 'utf8');
    const wasm = mod.parseWat(`${name}.wat`, wat).toBinary({});
    fs.writeFileSync(path.join(root, `${name}.wasm`), Buffer.from(wasm.buffer));
    console.log(`compiled contracts/${name}.wasm (${wasm.buffer.length} bytes)`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
