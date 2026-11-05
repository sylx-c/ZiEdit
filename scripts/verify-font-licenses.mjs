import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const rel = p => path.relative(root, p).replaceAll('\\', '/');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const inventoryPath = path.join(root, 'public/font-licenses/manifest.json');
const groups = [
  { name: 'JetBrains Mono 2.304 derivatives', license: 'OFL-1.1', directory: 'public/fonts', filter: /\.woff2$/, legal: ['public/fonts/OFL-LICENSE.txt'], source: 'https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304' },
  { name: 'MathJax STIX2 4.1.3 derived glyphs', license: 'OFL-1.1 (glyphs); Apache-2.0 (code)', directory: 'public/renderers/font', filter: /\.js$/, legal: ['public/renderers/font/LICENSE', 'public/renderers/font/OFL-STIX.txt', 'public/renderers/font/NOTICE.txt'], source: 'https://registry.npmjs.org/@mathjax/mathjax-stix2-font/4.1.3' },
  { name: 'PDF Foxit standard fonts', license: 'BSD-3-Clause', directory: 'public/pdfjs-assets/standard_fonts', filter: /\.pfb$/, legal: ['public/pdfjs-assets/standard_fonts/LICENSE_FOXIT'], source: 'https://github.com/mozilla/pdf.js/tree/v6.4.299/external/standard_fonts' },
  { name: 'PDF Liberation Sans 1.07.4', license: 'GPL-2.0 WITH Liberation-font-exception', directory: 'public/pdfjs-assets/standard_fonts', filter: /\.ttf$/, legal: ['public/pdfjs-assets/standard_fonts/LICENSE_LIBERATION', 'compliance/third-party-sources/LIBERATION-SOURCE.txt', 'compliance/third-party-sources/fonts-liberation_1.07.4.orig.tar.gz'], source: 'https://github.com/mozilla/pdf.js/blob/v6.4.299/external/standard_fonts/README.md' },
];
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.isSymbolicLink()) throw new Error('Font evidence must not contain symlinks');
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}
function record(p) { return { path: rel(p), bytes: fs.statSync(p).size, sha256: sha(p) }; }
const records = groups.map(g => ({ name: g.name, license: g.license, source: g.source,
  files: files(path.join(root, g.directory)).filter(p => g.filter.test(p)).sort().map(record),
  notices: g.legal.map(p => record(path.join(root, p))) }));
if (records.some(g => !g.files.length)) throw new Error('An audited font group is empty');
const known = new Set(records.flatMap(g => g.files.map(x => x.path)));
for (const p of files(path.join(root, 'public'))) {
  if (/\.(?:ttf|otf|woff2?|pfb)$/i.test(p) && !known.has(rel(p))) throw new Error('Unreviewed font: ' + rel(p));
  if (/\.(?:js|mjs|css|html)$/i.test(p) && /data:(?:font\/|application\/(?:x-)?(?:font|woff|opentype|truetype))/i.test(fs.readFileSync(p, 'utf8')) && rel(p) !== 'public/renderers/mathjax/output/svg.js') throw new Error('Unreviewed embedded font: ' + rel(p));
}
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
if (lock.packages['node_modules/@mathjax/mathjax-stix2-font']?.version !== '4.1.3') throw new Error('Unexpected math font version');
const config = fs.readFileSync(path.join(root, 'src/markdown-view/render-service.ts'), 'utf8');
if (!config.includes("font: 'mathjax-stix2'") || config.includes('mathjax-newcm')) throw new Error('Unreviewed math font selected');
for (const item of records[1].files) {
  const p = path.join(root, item.path);
  const original = path.join(root, 'node_modules/@mathjax/mathjax-stix2-font', item.path.slice('public/renderers/font/'.length));
  if (sha(p) !== sha(original)) throw new Error('Modified mathematical font: ' + item.path);
}
const zeroSourcePath = path.join(root, 'public/font-licenses/MathJax-zero-source.ts.txt');
const zeroSource = fs.readFileSync(zeroSourcePath, 'utf8');
const zeroParts = [...zeroSource.matchAll(/^\s*'([A-Za-z0-9+/=]+)',?$/gm)].map(m => m[1]);
const zeroBytes = Buffer.from(zeroParts.join(''), 'base64');
const zeroHash = crypto.createHash('sha256').update(zeroBytes).digest('hex');
const svgCodePath = path.join(root, 'public/renderers/mathjax/output/svg.js');
const svgCode = fs.readFileSync(svgCodePath, 'utf8');
if (zeroHash !== '490c6efc4c095ea7c654af1a84e0bc40fd15a9eaa232af94cb2bab6cf9efc63b' || !zeroParts.every(p => svgCode.includes(p))) throw new Error('Embedded MJX-ZERO differs from the audited upstream source');
records.push({ name: 'MathJax MJX-ZERO helper 0.1 (embedded)', license: 'Apache-2.0', source: 'https://github.com/mathjax/MathJax-src/blob/4.1.3/ts/output/svg/Wrappers/zero.ts', payload: { bytes: zeroBytes.length, sha256: zeroHash }, files: [record(svgCodePath)], notices: [record(zeroSourcePath), record(path.join(root, 'public/renderers/font/LICENSE'))] });
const copies = [
  ['public/fonts/OFL-LICENSE.txt', 'OFL-JetBrainsMono.txt'],
  ['public/renderers/font/OFL-STIX.txt', 'OFL-STIX.txt'],
  ['public/renderers/font/LICENSE', 'Apache-MathJax.txt'],
  ['public/renderers/font/NOTICE.txt', 'NOTICE-MathJax-STIX2.txt'],
  ['public/pdfjs-assets/standard_fonts/LICENSE_FOXIT', 'BSD-Foxit.txt'],
  ['public/pdfjs-assets/standard_fonts/LICENSE_LIBERATION', 'GPL-Liberation.txt'],
  ['node_modules/@mathjax/mathjax-stix2-font/def/mathjax-stix2.ts', 'mathjax-stix2-definition.ts.txt'],
];
for (const [original, copy] of copies) {
  if (sha(path.join(root, original)) !== sha(path.join(root, 'public/font-licenses', copy))) throw new Error('Missing/stale readable font notice: ' + copy);
}
const resources = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).bundle.resources;
if (resources['../public/font-licenses/'] !== 'font-licenses/') throw new Error('Native distribution must include readable font notices');
const text = JSON.stringify({ schema: 1, scope: 'All font files under public plus generated mathematical SVG glyphs; OS-provided fonts are not redistributed.', readableNotices: copies.map(([, p]) => record(path.join(root, 'public/font-licenses', p))), groups: records }, null, 2) + '\n';
if (process.argv.includes('--record')) {
  fs.mkdirSync(path.dirname(inventoryPath), { recursive: true });
  fs.writeFileSync(inventoryPath, text);
} else if (fs.readFileSync(inventoryPath, 'utf8') !== text) {
  throw new Error('Font payload or legal evidence changed. Audit before explicitly updating the inventory with --record.');
}
const source = path.join(root, 'compliance/third-party-sources/fonts-liberation_1.07.4.orig.tar.gz');
if (sha(source) !== 'ad98b7498dc2992f7f0868f79b65ce4a720a3acdb63ab3f1f1cb6881117a5406') throw new Error('Incorrect Liberation corresponding source');
console.log(JSON.stringify({ groups: records.map(g => ({name:g.name, files:g.files.length})), status: 'font payload and legal evidence verified' }, null, 2));
