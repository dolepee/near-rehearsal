// Local, deliberately seeded regression fixture. Never deploy this artifact to
// a public chain. Preserve every section except one exported function's body.
const fs = require('node:fs');
const crypto = require('node:crypto');

function readU32(bytes, cursor) {
  let value = 0, shift = 0;
  for (let i = 0; i < 5; i++) {
    if (cursor.pos >= bytes.length) throw new Error('Truncated ULEB128');
    const b = bytes[cursor.pos++];
    value += (b & 127) * 2 ** shift;
    if (!(b & 128)) {
      if (value > 0xffffffff) throw new Error('u32 overflow');
      return value;
    }
    shift += 7;
  }
  throw new Error('Invalid ULEB128');
}
function u32(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 128;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}
function name(bytes, cursor) {
  const length = readU32(bytes, cursor);
  if (cursor.pos + length > bytes.length) throw new Error('Truncated name');
  const text = bytes.subarray(cursor.pos, cursor.pos + length).toString('utf8');
  cursor.pos += length;
  return text;
}
function limits(bytes, cursor) {
  const flags = readU32(bytes, cursor);
  if (flags & ~3) throw new Error('Unsupported memory/table limits');
  readU32(bytes, cursor);
  if (flags & 1) readU32(bytes, cursor);
}
function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function patchExportToTrap(input, exportName = 'ft_resolve_transfer') {
  const bytes = Buffer.from(input);
  const header = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  if (!bytes.subarray(0, 8).equals(header)) throw new Error('Not WASM v1');
  const sections = [];
  const cursor = { pos: 8 };
  while (cursor.pos < bytes.length) {
    const id = bytes[cursor.pos++];
    const length = readU32(bytes, cursor);
    if (cursor.pos + length > bytes.length) throw new Error('Truncated section');
    sections.push({ id, payload: bytes.subarray(cursor.pos, cursor.pos + length) });
    cursor.pos += length;
  }
  let imports = 0;
  const importSection = sections.find(x => x.id === 2);
  if (importSection) {
    const data = importSection.payload, cur = { pos: 0 };
    const count = readU32(data, cur);
    for (let i = 0; i < count; i++) {
      name(data, cur); name(data, cur);
      const kind = data[cur.pos++];
      if (kind === 0) { readU32(data, cur); imports++; }
      else if (kind === 1) { cur.pos++; limits(data, cur); }
      else if (kind === 2) limits(data, cur);
      else if (kind === 3) cur.pos += 2;
      else if (kind === 4) { cur.pos++; readU32(data, cur); }
      else throw new Error('Unsupported import kind: ' + kind);
    }
  }
  const exports = sections.find(x => x.id === 7);
  if (!exports) throw new Error('Missing export section');
  let functionIndex;
  {
    const cur = { pos: 0 }, data = exports.payload;
    const count = readU32(data, cur);
    for (let i = 0; i < count; i++) {
      const exportLabel = name(data, cur), kind = data[cur.pos++];
      const index = readU32(data, cur);
      if (exportLabel === exportName) {
        if (kind !== 0) throw new Error('Target is not a function');
        functionIndex = index;
      }
    }
  }
  if (functionIndex === undefined) throw new Error('Export not found: ' + exportName);
  const bodyIndex = functionIndex - imports;
  if (bodyIndex < 0) throw new Error('Cannot replace an imported function');
  const code = sections.find(x => x.id === 10);
  if (!code) throw new Error('Missing code section');
  const data = code.payload, cur = { pos: 0 };
  const count = readU32(data, cur);
  if (bodyIndex >= count) throw new Error('Function body not found');
  const bodies = [];
  let originalBodyBytes;
  for (let i = 0; i < count; i++) {
    const length = readU32(data, cur);
    const original = data.subarray(cur.pos, cur.pos + length);
    if (original.length !== length) throw new Error('Truncated function body');
    cur.pos += length;
    // Zero locals, unconditional trap, function end. Unreachable is valid for
    // any result type, and changes no imports, exports, data or storage layout.
    const body = i === bodyIndex ? Buffer.from([0, 0, 11]) : original;
    if (i === bodyIndex) originalBodyBytes = length;
    bodies.push(u32(body.length), body);
  }
  if (cur.pos !== data.length) throw new Error('Unexpected code-section tail');
  code.payload = Buffer.concat([u32(count), ...bodies]);
  const output = Buffer.concat([header, ...sections.flatMap(x => [Buffer.from([x.id]), u32(x.payload.length), x.payload])]);
  if (!WebAssembly.validate(output)) throw new Error('Patched WASM failed structural validation');
  return { output, metadata: {
    label: 'Intentionally seeded callback-trap regression; local testing only',
    exportedFunction: exportName,
    functionIndex, bodyIndex, originalBodyBytes, replacementBodyBytes: 3,
    originalSha256: sha256(bytes), candidateSha256: sha256(output),
    change: 'Replace only this exported callback body with an unconditional WASM trap.'
  } };
}
module.exports = { patchExportToTrap, sha256 };
if (require.main === module) {
  const [inputPath, outputPath, exportName] = process.argv.slice(2);
  if (!inputPath || !outputPath || inputPath === outputPath) {
    throw new Error('Usage: node patch-wasm.cjs INPUT.wasm NEW-OUTPUT.wasm [export]');
  }
  const result = patchExportToTrap(fs.readFileSync(inputPath), exportName);
  fs.writeFileSync(outputPath, result.output);
  process.stdout.write(JSON.stringify(result.metadata, null, 2) + '\n');
}
