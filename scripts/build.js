// Builds dist/<name>-<version>.zip for the Chrome Web Store from extension/,
// with manifest.json at the root of the zip. No dependencies: it writes the
// zip format by hand.
// Usage: npm run build

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import path from 'node:path';

const SOURCE = 'extension';

const manifest = JSON.parse(readFileSync(path.join(SOURCE, 'manifest.json'), 'utf8'));
// The file name comes from the extension name, which lives only in messages.json.
const messages = JSON.parse(readFileSync(path.join(SOURCE, '_locales/en/messages.json'), 'utf8'));
const slug = messages.extShortName.message.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const files = walk(SOURCE).sort();

const entries = [];
let offset = 0;
const chunks = [];
for (const file of files) {
  const data = readFileSync(file);
  const compressed = deflateRawSync(data, { level: 9 });
  const name = Buffer.from(path.relative(SOURCE, file).split(path.sep).join('/'));
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(0, 10); // time
  local.writeUInt16LE(0x21, 12); // date: 1980-01-01, keeps builds identical
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, name, compressed);
  entries.push({ name, crc, size: data.length, csize: compressed.length, offset });
  offset += local.length + name.length + compressed.length;
}

const centralStart = offset;
for (const e of entries) {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(0x0800, 8);
  head.writeUInt16LE(8, 10);
  head.writeUInt16LE(0, 12);
  head.writeUInt16LE(0x21, 14);
  head.writeUInt32LE(e.crc, 16);
  head.writeUInt32LE(e.csize, 20);
  head.writeUInt32LE(e.size, 24);
  head.writeUInt16LE(e.name.length, 28);
  head.writeUInt32LE(e.offset, 42);
  chunks.push(head, e.name);
  offset += head.length + e.name.length;
}
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(offset - centralStart, 12);
end.writeUInt32LE(centralStart, 16);
chunks.push(end);

mkdirSync('dist', { recursive: true });
const out = `dist/${slug}-${manifest.version}.zip`;
writeFileSync(out, Buffer.concat(chunks));
console.log(`${out}: ${entries.length} files`);

function walk(entry) {
  if (statSync(entry).isDirectory()) {
    return readdirSync(entry).flatMap((child) => walk(path.join(entry, child)));
  }
  return [entry];
}
