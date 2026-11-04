'use strict';
// Two narrow client-only fixes for near-workspaces 5.0.0's local health check.
// No NEAR runtime binary, permission, resource limit, or transaction is modified.
const fs = require('node:fs');
const path = require('node:path');
const packageFile = require.resolve('near-workspaces/package.json');
const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
if (pkg.version !== '5.0.0') throw new Error(`Expected near-workspaces5.0.0, got ${pkg.version}`);
const file = path.join(path.dirname(packageFile), 'dist/server/server.js');
let source = fs.readFileSync(file, 'utf8');
// 0.0.0.0 is a listen wildcard; use a concrete loopback address for a client.
source = source.replace("hostname: '0.0.0.0'", "hostname: '127.0.0.1'");
// IncomingMessage contains circular references. Only its status is needed.
source = source.replace('JSON.stringify(result)', 'String(result.statusCode)');
if (!source.includes("hostname: '127.0.0.1'") || !source.includes('String(result.statusCode)')) {
  throw new Error('Unexpected health-check source; manual review required');
}
fs.writeFileSync(file, source);
console.log('Prepared near-workspaces5 local health check: loopback address and status-only diagnostics.');
