'use strict';
// Exercise the actual HTTP listener: malformed input must not kill this process
// or interrupt a second client using the same local application.
const assert = require('node:assert/strict');
const http = require('node:http');
const {server} = require('./server.cjs');

function request(port, target, agent) {
  return new Promise((resolve, reject) => {
    const req = http.get({host: '127.0.0.1', port, path: target, agent}, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({status: res.statusCode, body}));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTP regression request timed out')));
    req.on('error', reject);
  });
}

(async () => {
  const client = new http.Agent({keepAlive: true});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    const before = await request(port, '/api/health', client);
    assert.equal(before.status, 200);
    assert.equal(JSON.parse(before.body).ok, true);
    for (const target of ['//[', 'http://[', '//[::invalid']) {
      const [invalid, concurrent] = await Promise.all([
        request(port, target),
        request(port, '/api/health', client),
      ]);
      assert.equal(invalid.status, 400, target);
      assert.equal(typeof JSON.parse(invalid.body).error, 'string');
      assert.equal(concurrent.status, 200);
      assert.equal(JSON.parse(concurrent.body).ok, true);
    }
    assert.equal((await request(port, '/repair?mode=patch', client)).status, 200);
    console.log('malformed URL: controlled400; concurrent client and application remain available');
  } finally {
    client.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
