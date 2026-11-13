'use strict';
// Exercise the actual CLI with a denied-bind fixture. No network or Sandbox.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-226-network-'));
try {
  const runtime = path.join(tmp, 'runtime');
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'near-sandbox'), '#!/bin/sh\nprintf "neard (release 2.6.2)\\n"\n', {mode: 0o755});
  for (const [code, deniedHost] of [['EPERM', '127.0.0.1'], ['EACCES', '0.0.0.0']]) {
    const preload = path.join(tmp, `${code}.cjs`);
    fs.writeFileSync(preload, `
      const {EventEmitter}=require('node:events');
      require('node:net').createServer=()=>{
        const s=new EventEmitter();
        s.listen=(port,host,ready)=>{
          if(port!==0) throw new Error('expected ephemeral setup probe');
          process.nextTick(()=>host===${JSON.stringify(deniedHost)}
            ? s.emit('error',Object.assign(new Error('denied'),{code:${JSON.stringify(code)}}))
            : ready());
          return s;
        };
        s.close=(done)=>{process.nextTick(()=>done?.());return s;};
        return s;
      };
    `);
    const out = path.join(tmp, code);
    const result = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, 'run-case.cjs'), '--sandbox-dir', runtime, '--out', out], {
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.error, undefined, 'permission failure must terminate promptly');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Local Sandbox networking unavailable/);
    assert.ok(result.stderr.includes(`${code} binding ${deniedHost}`), result.stderr);
    assert.equal(fs.existsSync(out), false, 'preflight must fail before creating a running job');
    console.log(`PASS CLI rejects ${code} on ${deniedHost} before starting Sandbox`);
  }
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}
