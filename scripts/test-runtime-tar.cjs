'use strict';
// Compatibility check for the archive library used by near-sandbox. Only a
// synthetic local fixture is downloaded; no runtime executable is run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {createRequire} = require('node:module');
const sandboxRequire = createRequire(require.resolve('near-sandbox'));
const tar = sandboxRequire('tar');
const {Binary} = require('near-sandbox');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-runtime-tar-'));
  const server = http.createServer();
  try {
    const input = path.join(tmp, 'input');
    const output = path.join(tmp, 'output');
    fs.mkdirSync(path.join(input, 'package'), {recursive: true});
    const fixture = 'synthetic runtime extraction fixture; never executed\n';
    fs.writeFileSync(path.join(input, 'package', 'near-sandbox'), fixture);
    const chunks = [];
    for await (const chunk of tar.c({gzip: true, cwd: input}, ['package'])) chunks.push(chunk);
    const archive = Buffer.concat(chunks);
    server.on('request', (req, res) => {
      assert.equal(req.url, '/fixture.tar.gz');
      res.writeHead(200, {'content-type': 'application/gzip', 'content-length': archive.length});
      res.end(archive);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const binary = await Binary.create('near-sandbox', `http://127.0.0.1:${server.address().port}/fixture.tar.gz`, output);
    assert.equal(await binary.install(), true);
    assert.equal(await binary.exists(), true);
    assert.equal(fs.readFileSync(binary.binPath, 'utf8'), fixture);
    assert.deepEqual(fs.readdirSync(output), ['near-sandbox']);
    console.log('runtime tar: near-sandbox streamed extraction works with the patched archive dependency');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, {recursive: true, force: true});
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
