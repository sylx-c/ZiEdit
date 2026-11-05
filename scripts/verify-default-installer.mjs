import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'compliance/third-party-sources/windows-installer/default-nsis-3.11');
const digest = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest('hex');
const bytes = file => fs.readFileSync(file);
const manifestBytes = bytes(path.join(directory, 'manifest.json'));
assert.equal(digest(manifestBytes), 'bca1a1ec2adbbebd2eea14557071a88ce46a41c9448d625de30a48266f6d204f', 'Audited default NSIS manifest changed; explicit review required');
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.nsisVersion, '3.11');
assert.equal(manifest.tauriCliVersion, '2.12.2');
assert.equal(manifest.archive.sha1, 'ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d');
assert.equal(manifest.archive.sha256, 'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1');

function match(data, entry, description = entry.path) {
  assert.equal(data.length, entry.bytes, 'Length mismatch: ' + description);
  assert.equal(digest(data), entry.sha256, 'SHA256 mismatch: ' + description);
}
for (const file of manifest.files) match(bytes(path.join(directory, file.path)), file);
const source = bytes(path.join(directory, 'tauri-cli-2.12.2-nsis-mod.rs.txt')).toString('utf8');
assert(source.includes(manifest.archive.url), 'Tauri source does not declare this NSIS archive');
assert(source.includes(manifest.archive.sha1.toUpperCase()), 'Tauri source does not declare this SHA1');
const parent = JSON.parse(bytes(path.join(directory, '../manifest.json')));
const plugin = manifest.tools.find(tool => tool.path.endsWith('/additional/nsis_tauri_utils.dll'));
const inheritedPlugin = parent.tools.find(tool => tool.path === plugin.path);
assert.equal(plugin.version, parent.pluginVersion);
assert.equal(plugin.sourceCommit, parent.pluginSourceCommit);
assert.equal(plugin.bytes, inheritedPlugin.bytes);
assert.equal(plugin.sha256, inheritedPlugin.sha256);
assert(source.includes(plugin.sourceURL) && source.includes(plugin.sha1.toUpperCase()), 'Tauri plugin default differs');
for (const relative of plugin.licenseFiles) {
  const entry = parent.files.find(file => file.path === path.basename(relative));
  assert(entry, 'Missing previously audited plugin license: ' + relative);
  match(bytes(path.join(directory, relative)), entry);
}

// Read only the regular non-ZIP64 archive produced at the fixed official URL.
// Hash the entire archive before interpreting its directory; no path is extracted.
function zipEntries(buffer) {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  assert(end >= 0, 'ZIP end record missing');
  assert.equal(buffer.readUInt16LE(end + 4), 0, 'Multi-volume ZIP unsupported');
  const count = buffer.readUInt16LE(end + 10);
  const entries = new Map();
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'Invalid central directory');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const packedSize = buffer.readUInt32LE(offset + 20);
    const rawSize = buffer.readUInt32LE(offset + 24);
    const nameSize = buffer.readUInt16LE(offset + 28);
    const extraSize = buffer.readUInt16LE(offset + 30);
    const commentSize = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameSize).toString('utf8');
    assert(!entries.has(name), 'Duplicate archive entry: ' + name);
    assert.equal(flags & 1, 0, 'Encrypted archive unsupported');
    entries.set(name, () => {
      assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, 'Invalid local file header');
      const dataOffset = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const packed = buffer.subarray(dataOffset, dataOffset + packedSize);
      assert([0, 8].includes(method), 'Unsupported ZIP compression method');
      const raw = method === 0 ? packed : zlib.inflateRawSync(packed);
      assert.equal(raw.length, rawSize, 'Archive decompressed length mismatch');
      return raw;
    });
    offset += 46 + nameSize + extraSize + commentSize;
  }
  return entries;
}

const args = process.argv.slice(2);
let archivePath, toolsetPath, distribution = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--archive') archivePath = args[++index];
  else if (args[index] === '--toolset') toolsetPath = args[++index];
  else if (args[index] === '--dist') distribution = true;
  else throw new Error('Use optional --archive <official zip>, --toolset <NSIS cache directory>, --dist');
}
if (archivePath) {
  const archive = bytes(path.resolve(archivePath));
  match(archive, manifest.archive, 'Official NSIS 3.11 ZIP');
  assert.equal(digest(archive, 'sha1'), manifest.archive.sha1, 'Official archive SHA1 mismatch');
  const entries = zipEntries(archive);
  const copying = entries.get('nsis-3.11/COPYING');
  assert(copying, 'Original COPYING absent');
  assert.deepEqual(copying(), bytes(path.join(directory, 'NSIS-COPYING.txt')), 'COPYING differs from archive original');
  for (const tool of manifest.tools.filter(tool => tool.archiveEntry)) {
    const entry = entries.get(tool.archiveEntry);
    assert(entry, 'Required archive tool absent: ' + tool.path);
    match(entry(), tool);
  }
}
if (toolsetPath) {
  const cache = path.resolve(toolsetPath);
  for (const tool of manifest.tools) match(bytes(path.join(cache, tool.path)), tool);
  assert.deepEqual(bytes(path.join(cache, 'COPYING')), bytes(path.join(directory, 'NSIS-COPYING.txt')), 'Actual NSIS 3.11 COPYING differs');
}
if (distribution) {
  // 瘦身口径：证据目录不得进入发行物；dist 内若出现即失败。
  assert(!fs.existsSync(path.join(root, 'dist/compliance')) && !fs.existsSync(path.join(root, 'dist/third-party-sources')), 'Evidence directory leaked into the built distribution');
}
console.log(JSON.stringify({ status: 'Audited default NSIS 3.11 license and expected toolset evidence verified', archiveChecked: !!archivePath,
  actualToolsetChecked: !!toolsetPath, builtEvidenceChecked: distribution, toolFiles: manifest.tools.length,
  scope: 'Evidence only; no compiler, plugin or installer executed. Does not claim a build selected these bytes unless --toolset is supplied; final installer/compressor verification is separate.' }, null, 2));
