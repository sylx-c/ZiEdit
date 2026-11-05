import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Offline by default. --write regenerates only reviewed Emoji derivatives, not policy.
// --fetch-check additionally compares each immutable upstream URL byte for byte.
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = 'compliance/asset-provenance/emoji/';
const runtimePath = 'src/markdown-view/unicode-emojis.json';
const noticePath = 'src/markdown-view/unicode-emojis.NOTICE.md';
const scriptPath = 'scripts/verify-asset-provenance.mjs';
const gemojiCommit = 'fadaeaf1f1a9be82b321316a6c5502e43138b2f6';
const iamcalCommit = 'e77759c296ed37beb0dbd63908b43d8619509c6d';
const unicodeCommit = '48afe632bf194a20bcd27c3488b49dc23274b684';
const sources = [
  ['gemoji-data', 'gemoji-emoji.json', `https://raw.githubusercontent.com/github/gemoji/${gemojiCommit}/db/emoji.json`, 'b174ae2aeb321b52f64adb9ff412f966a7f338839d780784dd15dcad702c2dd6'],
  ['gemoji-license', 'gemoji-LICENSE.txt', `https://raw.githubusercontent.com/github/gemoji/${gemojiCommit}/LICENSE`, '7ea1d1fd0602e6623b9a65e791499a0ea5a2f5f60f91bfad78cbaeee19da26e6'],
  ['iamcal-data', 'iamcal-emoji.json', `https://raw.githubusercontent.com/iamcal/emoji-data/${iamcalCommit}/emoji.json`, '8736d721991e48c41c57acc46b65e5d32258a45e4bcdebcc6012f420f81e775d'],
  ['iamcal-license', 'iamcal-LICENSE.txt', `https://raw.githubusercontent.com/iamcal/emoji-data/${iamcalCommit}/LICENSE`, 'ee9953a79bf2132b59b1342b217f1c377b3d03d9e7713006f6c3b89eb159f1db'],
  ['unicode-data', 'unicode-emoji-test-17.0.0.txt', 'https://unicode.org/Public/17.0.0/emoji/emoji-test.txt', '1d8a944f88d7952f7ef7c5167fef3c67995bcae24543949710231b03a201acda'],
  ['unicode-repository-data', 'unicode-repository-emoji-test-17.0.txt', `https://raw.githubusercontent.com/unicode-org/unicodetools/${unicodeCommit}/unicodetools/data/emoji/17.0/emoji-test.txt`, '1d8a944f88d7952f7ef7c5167fef3c67995bcae24543949710231b03a201acda'],
  ['unicode-license', 'unicode-LICENSE.txt', `https://raw.githubusercontent.com/unicode-org/unicodetools/${unicodeCommit}/LICENSE`, 'fe5c62b543e287981db198f2acfa0ca732d12591a1024536dc8fd85dacd77104'],
];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = relative => fs.readFileSync(path.join(root, relative));
const json = relative => JSON.parse(read(relative));
const stringify = value => JSON.stringify(value, null, 2) + '\n';
const normalize = value => value.replace(/[\uFE0E\uFE0F]/g, '');
const codepoints = value => [...value].map(c => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
const record = relative => ({ path: relative, bytes: read(relative).length, sha256: sha(read(relative)) });

export function parseUnicode(text) {
  const rows = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match = /^([0-9A-F ]+?)\s*;\s*([a-z-]+)\s*#\s*(\S+)\s+E([\d.]+)\s+(.+)$/.exec(line);
    if (!match) return;
    const unicode = String.fromCodePoint(...match[1].trim().split(/\s+/).map(c => parseInt(c, 16)));
    assert.equal(match[3], unicode, `Unicode literal/codepoint mismatch at line ${index + 1}`);
    rows.push({ unicode, status: match[2], emojiVersion: match[4], name: match[5], line: index + 1, codepoints: codepoints(unicode) });
  });
  assert(rows.length > 5000, 'Incomplete Unicode 17.0 data');
  return rows;
}

function upstreamRows(gemoji, iamcal, unicodeRows) {
  return [
    ...gemoji.flatMap((row, index) => row.aliases.map((alias, aliasIndex) => ({
      source: 'gemoji', alias, unicode: row.emoji, pointer: `/${index}/aliases/${aliasIndex}`,
    }))),
    ...iamcal.flatMap((row, index) => row.short_names.map((alias, aliasIndex) => ({
      source: 'iamcal', alias, unicode: String.fromCodePoint(...row.unified.split('-').map(c => parseInt(c, 16))),
      pointer: `/${index}/short_names/${aliasIndex}`,
    }))),
    ...unicodeRows.filter(row => row.status === 'component').map(row => ({
      source: 'unicode17', alias: row.name, unicode: row.unicode, line: row.line,
    })),
  ];
}

// Explicit aliasOf is mandatory; equal glyphs alone never establish semantic provenance.
export function derive(policy, upstream, unicodeRows) {
  assert.equal(policy.schema, 1);
  assert.equal(policy.baseline.aliases, 1946);
  const table = Object.create(null);
  const entries = [];
  const corrections = new Map(policy.changes.map(change => [change.alias, change]));
  assert.equal(corrections.size, policy.changes.length, 'Duplicate correction');
  for (const tuple of policy.entries) {
    assert(Array.isArray(tuple) && tuple.length >= 3 && tuple.length <= 4, 'Invalid alias policy tuple');
    const [alias, source, aliasOf, presentation] = tuple;
    assert(typeof alias === 'string' && /^[A-Za-z0-9_+\-]+$/.test(alias), `Invalid alias: ${alias}`);
    assert(!Object.hasOwn(table, alias), `Duplicate runtime alias: ${alias}`);
    const candidates = upstream.filter(row => row.source === source && row.alias === aliasOf);
    assert.equal(candidates.length, 1, `Missing/ambiguous upstream aliasOf: ${alias} -> ${source}:${aliasOf}`);
    const target = candidates[0];
    const unicode = presentation ?? target.unicode;
    assert(typeof unicode === 'string' && unicode.length > 0);
    assert.equal(normalize(unicode), normalize(target.unicode), `Non-presentation override: ${alias}`);
    if (presentation !== undefined) assert.notEqual(unicode, target.unicode, `Redundant override: ${alias}`);
    const sameName = upstream.filter(row => row.alias === alias && row.source !== 'unicode17');
    if (sameName.length) assert(sameName.some(row => row.unicode === target.unicode), `Same-name conflict concealed by aliasOf: ${alias}`);
    const unicodeRecord = unicodeRows.find(row => row.unicode === unicode)
      ?? unicodeRows.find(row => normalize(row.unicode) === normalize(unicode));
    assert(unicodeRecord, `No Unicode 17.0 sequence: ${alias}`);
    table[alias] = unicode;
    const change = corrections.get(alias);
    entries.push({
      alias, unicode, codepoints: codepoints(unicode),
      status: change?.action === 'correct-mapping' ? 'corrected-mapping'
        : source === 'unicode17' ? 'unicode-component-alias'
        : alias !== aliasOf ? 'compatibility-alias'
        : presentation === undefined ? 'upstream-exact' : 'presentation-only',
      source: { id: source, aliasOf, unicode: target.unicode, codepoints: codepoints(target.unicode),
        ...(target.pointer ? { pointer: target.pointer } : { line: target.line }) },
      transform: presentation === undefined ? 'none' : 'legacy FE0E/FE0F presentation only',
      unicode17: { line: unicodeRecord.line, name: unicodeRecord.name, status: unicodeRecord.status,
        codepoints: unicodeRecord.codepoints, exact: unicodeRecord.unicode === unicode },
    });
  }
  const reconstructed = new Set(Object.keys(table));
  for (const change of policy.changes) {
    assert(['add-canonical-alias', 'correct-mapping', 'remove-misnamed-alias'].includes(change.action));
    if (change.action === 'add-canonical-alias') {
      assert.equal(table[change.alias], change.after);
      reconstructed.delete(change.alias);
    } else {
      assert(typeof change.before === 'string');
      assert(Object.hasOwn(table, change.preservedAs), `Old glyph lost: ${change.alias} -> ${change.preservedAs}`);
      assert.equal(normalize(table[change.preservedAs]), normalize(change.before), `Old glyph not preserved: ${change.alias}`);
      if (change.action === 'remove-misnamed-alias') {
        assert(!Object.hasOwn(table, change.alias), `Removed semantic error reintroduced: ${change.alias}`);
        reconstructed.add(change.alias);
      } else assert.equal(table[change.alias], change.after);
    }
  }
  assert.equal(reconstructed.size, policy.baseline.aliases, 'Unexpected runtime alias addition/removal');
  assert.equal(sha(JSON.stringify([...reconstructed].sort())), policy.baseline.aliasSetSha256, 'Original compatibility alias set changed without a recorded correction');
  // Reconstruct original bytes from the reviewed diff. This binds all preserved values and
  // the original order to the pre-remediation artifact, not just a count of aliases.
  const original = {};
  for (const [alias, value] of Object.entries(table)) {
    if (corrections.get(alias)?.action === 'add-canonical-alias') continue;
    original[alias] = corrections.get(alias)?.before ?? value;
  }
  // Removed rows have recorded insertion anchors because JSON property order is part of SHA256.
  for (const change of policy.changes.filter(c => c.action === 'remove-misnamed-alias')) {
    assert(change.beforeAlias && Object.hasOwn(original, change.beforeAlias), `Missing original-order anchor: ${change.alias}`);
    const ordered = Object.entries(original);
    ordered.splice(ordered.findIndex(([alias]) => alias === change.beforeAlias), 0, [change.alias, change.before]);
    for (const key of Object.keys(original)) delete original[key];
    Object.assign(original, Object.fromEntries(ordered));
  }
  assert.equal(sha(stringify(original)), policy.baseline.sha256, 'Unrecorded original value/order change');
  return { table, entries };
}

function selfTest(policy, upstream, unicodeRows) {
  const badPresentation = structuredClone(policy);
  badPresentation.entries[0][3] = '🦗';
  assert.throws(() => derive(badPresentation, upstream, unicodeRows), /Non-presentation override/);
  const missing = structuredClone(policy);
  missing.entries.shift();
  assert.throws(() => derive(missing, upstream, unicodeRows), /Unexpected runtime alias/);
  const wrongAlias = structuredClone(policy);
  wrongAlias.entries.find(row => row[0] === 'cricket')[2] = 'cricket_game';
  assert.throws(() => derive(wrongAlias, upstream, unicodeRows), /Same-name conflict/);
  const wrongHair = structuredClone(policy);
  wrongHair.entries.find(row => row[0] === 'red_haired')[2] = 'bald';
  assert.throws(() => derive(wrongHair, upstream, unicodeRows), /Unrecorded original value/);
  console.log('Mutation checks passed: wrong glyph, dropped alias, concealed same-name conflict, wrong hair component rejected.');
}

async function main() {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) assert(['--write', '--fetch-check', '--self-test', '--distribution', '--dist'].includes(arg), `Unknown option: ${arg}`);
  for (const [id, file, url, expected] of sources) {
    assert.equal(sha(read(directory + file)), expected, `Pinned source/license hash mismatch: ${id}`);
    if (args.has('--fetch-check')) {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      assert(response.ok, `Cannot retrieve ${url}: ${response.status}`);
      assert.equal(sha(Buffer.from(await response.arrayBuffer())), expected, `Remote source changed: ${id}`);
    }
  }
  const policy = json(directory + 'alias-policy.json');
  const unicodeRows = parseUnicode(read(directory + 'unicode-emoji-test-17.0.0.txt').toString('utf8'));
  const upstream = upstreamRows(json(directory + 'gemoji-emoji.json'), json(directory + 'iamcal-emoji.json'), unicodeRows);
  const { table, entries } = derive(policy, upstream, unicodeRows);
  if (args.has('--self-test')) selfTest(policy, upstream, unicodeRows);
  const runtime = stringify(table);
  if (args.has('--write')) {
    fs.writeFileSync(path.join(root, runtimePath), runtime);
    fs.copyFileSync(path.join(root, noticePath), path.join(root, directory + 'NOTICE.md'));
    fs.copyFileSync(path.join(root, runtimePath), path.join(root, directory + 'unicode-emojis.json'));
  }
  assert.equal(read(runtimePath).toString('utf8'), runtime, 'Emoji map differs from reviewed sources; inspect policy, then explicitly regenerate with --write');
  assert.deepEqual(read(directory + 'unicode-emojis.json'), read(runtimePath), 'Readable distributed Emoji map is stale');
  assert.deepEqual(read(directory + 'NOTICE.md'), read(noticePath), 'Readable distributed Emoji notice is stale');
  const manifest = {
    schema: 1, scope: 'Emoji shortcode data only; not an audit of fonts, icons, website, or other dependencies.',
    licenses: { gemoji: 'MIT', iamcal: 'MIT', unicode17: 'Unicode-3.0' },
    versions: { gemoji: gemojiCommit, iamcal: iamcalCommit, unicode17: '17.0.0', unicodeRepository: unicodeCommit },
    sources: sources.map(([id, file, url]) => ({ id, url, ...record(directory + file) })),
    policy: record(directory + 'alias-policy.json'), generator: record(scriptPath),
    runtime: record(runtimePath), distributedRuntime: record(directory + 'unicode-emojis.json'),
    notices: [record(noticePath), record(directory + 'NOTICE.md')],
    baseline: policy.baseline, changes: policy.changes,
    summary: entries.reduce((counts, entry) => ({ ...counts, [entry.status]: (counts[entry.status] ?? 0) + 1 }), {}),
    entries,
  };
  const manifestText = stringify(manifest);
  const manifestPath = directory + 'manifest.json';
  if (args.has('--write')) fs.writeFileSync(path.join(root, manifestPath), manifestText);
  assert.equal(read(manifestPath).toString('utf8'), manifestText, 'Emoji evidence manifest differs; audit changes before explicitly running --write');
  if (args.has('--distribution')) {
    const resources = json('src-tauri/tauri.conf.json').bundle.resources;
    assert(!Object.entries(resources).some(([from, to]) => from.includes('asset-provenance') || String(to).startsWith('compliance/')), 'Asset provenance is repo-only evidence; it must not be declared as an installer resource');
  }
  if (args.has('--dist')) {
    assert(!fs.existsSync(path.join(root, 'dist/asset-provenance')) && !fs.existsSync(path.join(root, 'dist/compliance')), 'Evidence directories leaked into the built distribution');
  }
  console.log(JSON.stringify({ status: 'Emoji source bytes, original licenses, aliasOf derivation, correction history and runtime map verified', aliases: entries.length, summary: manifest.summary, remoteVerified: args.has('--fetch-check'), resourceDeclarationVerified: args.has('--distribution'), builtEvidenceVerified: args.has('--dist') }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
}
