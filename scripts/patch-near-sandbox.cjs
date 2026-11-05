'use strict';
/*
 * near-sandbox 0.1.5 calls AWSUrl() before honoring NEAR_SANDBOX_BIN_PATH and
 * therefore throws "Unsupported platform" on Linux arm64. This patch makes an
 * explicitly supplied wrapper/binary directory take precedence. It is only a
 * host compatibility shim; the NEAR runtime bytes are unchanged.
 */
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '..', 'node_modules', 'near-sandbox', 'dist', 'getBinary.js');
if (!fs.existsSync(file)) {
  console.log('near-sandbox not installed; nothing to patch');
  process.exit(0);
}
let s = fs.readFileSync(file, 'utf8');
if (s.includes('NEAR_SANDBOX_BIN_PATH') && s.includes('Local compatibility')) {
  console.log('near-sandbox already patched');
  process.exit(0);
}
const old = `function getBinary(name = "near-sandbox") {\n    if (!process.env["NEAR_SANDBOX_BIN_PATH"]) {\n        process.env["NEAR_SANDBOX_BINARY_PATH"] = (0, path_1.join)(os.homedir(), ".near", "sandbox");\n    }\n    // Will use version after publishing to AWS\n    // const version = require("./package.json").version;\n    const fromEnv = process.env["SANDBOX_ARTIFACT_URL"];\n    const urls = [AWSUrl()];\n    if (fromEnv) {\n        urls.unshift(fromEnv);\n    }\n    return _1.Binary.create(name, urls);\n}\n`;
const neu = `function getBinary(name = "near-sandbox") {\n    // Local compatibility for non-Linux-x64 hosts: use an explicitly supplied\n    // wrapper/binary directory instead of resolving an unsupported platform.\n    if (process.env["NEAR_SANDBOX_BIN_PATH"]) {\n        return _1.Binary.create(name, "https://invalid.local/near-sandbox.tar.gz", process.env["NEAR_SANDBOX_BIN_PATH"]);\n    }\n    if (!process.env["NEAR_SANDBOX_BINARY_PATH"]) {\n        process.env["NEAR_SANDBOX_BINARY_PATH"] = (0, path_1.join)(os.homedir(), ".near", "sandbox");\n    }\n    const fromEnv = process.env["SANDBOX_ARTIFACT_URL"];\n    const urls = [AWSUrl()];\n    if (fromEnv) {\n        urls.unshift(fromEnv);\n    }\n    return _1.Binary.create(name, urls);\n}\n`;
if (!s.includes(old)) throw new Error('near-sandbox getBinary.js shape changed; patch manually');
fs.writeFileSync(file, s.replace(old, neu));
console.log('patched node_modules/near-sandbox/dist/getBinary.js for NEAR_SANDBOX_BIN_PATH');
