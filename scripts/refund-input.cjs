'use strict';
const crypto = require('node:crypto');
const path = require('node:path');

const FAMILY = 'refund-v1';
const INPUT_FIELDS = new Set(['family', 'candidate', 'migration', 'operation']);
const CANDIDATE_FIELDS = new Set(['filename', 'sha256', 'base64']);
const MIGRATION_FIELDS = new Set(['method', 'args']);
const OPERATION_FIELDS = new Set(['method', 'args', 'view']);
const SUPPORTED_MIGRATION = {method: 'migrate', args: {}};
const SUPPORTED_OPERATION = {method: 'claim_refund', args: {}, view: 'get_refundable'};
const MAX_WASM_BYTES = 2 * 1024 * 1024;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function fields(object, allowed, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${label} must be an object`);
  const extra = Object.keys(object).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`unsupported ${label} field(s): ${extra.join(', ')}`);
}

function validateDeclaredMigration(migration) {
  fields(migration, MIGRATION_FIELDS, 'migration');
  if (migration.method !== SUPPORTED_MIGRATION.method || JSON.stringify(migration.args) !== '{}') {
    throw new Error('this refund family only supports migrate({})');
  }
  return {method: migration.method, args: {}};
}

function validateDeclaredOperation(operation) {
  fields(operation, OPERATION_FIELDS, 'operation');
  if (operation.method !== SUPPORTED_OPERATION.method
    || JSON.stringify(operation.args) !== '{}'
    || operation.view !== SUPPORTED_OPERATION.view) {
    throw new Error('this refund family only supports claim_refund({}) with get_refundable');
  }
  return {method: operation.method, args: {}, view: operation.view};
}

function validateCandidateExport(bytes) {
  let module;
  try {
    module = new WebAssembly.Module(bytes);
  } catch (error) {
    throw new Error(`candidate is not valid WebAssembly: ${error.message}`);
  }
  const exports = new Set(WebAssembly.Module.exports(module).map((item) => item.name));
  for (const name of ['migrate', 'claim_refund', 'get_refundable']) {
    if (!exports.has(name)) throw new Error(`candidate is missing supported export: ${name}`);
  }
  return [...exports].sort();
}

function validateInput(payload) {
  fields(payload, INPUT_FIELDS, 'input');
  if (payload.family !== FAMILY) throw new Error(`unsupported contract family: ${payload.family || '(missing)'}`);
  fields(payload.candidate, CANDIDATE_FIELDS, 'candidate');
  const filename = String(payload.candidate.filename || '').trim();
  if (!filename || filename.length > 120) throw new Error('candidate filename is required and must be under 120 characters');
  if (!/^[a-f0-9]{64}$/.test(payload.candidate.sha256 || '')) throw new Error('candidate sha256 must be 64 lowercase hex characters');
  if (typeof payload.candidate.base64 !== 'string' || !payload.candidate.base64) throw new Error('candidate bytes are required');
  const bytes = Buffer.from(payload.candidate.base64, 'base64');
  if (!bytes.length || bytes.length > MAX_WASM_BYTES) throw new Error(`candidate must be between 1 and ${MAX_WASM_BYTES} bytes`);
  const actual = sha256(bytes);
  if (actual !== payload.candidate.sha256) throw new Error('candidate sha256 does not match its bytes');
  const exports = validateCandidateExport(bytes);
  const migration = validateDeclaredMigration(payload.migration);
  const operation = validateDeclaredOperation(payload.operation);
  return {
    family: FAMILY,
    filename: path.basename(filename),
    sha256: actual,
    bytes,
    exports,
    migration,
    operation,
  };
}

module.exports = {
  FAMILY,
  SUPPORTED_MIGRATION,
  SUPPORTED_OPERATION,
  validateInput,
  validateDeclaredMigration,
  validateDeclaredOperation,
  validateCandidateExport,
  sha256,
};
