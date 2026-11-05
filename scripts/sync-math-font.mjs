import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

/** Copy only the audited STIX2 SVG font, never MathJax's default NewCM bundle. */
export function syncMathFont() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = join(root, 'node_modules/@mathjax/mathjax-stix2-font');
  const target = join(root, 'public/renderers/font');
  const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (metadata.version !== '4.1.3') throw new Error('STIX2 version changed: re-audit the font before distributing it');
  const definition = readFileSync(join(source, 'def/mathjax-stix2.ts'), 'utf8');
  if (/NewCM|MJX-Extra/.test(definition) || !definition.includes('STIXTwoMath-Regular.otf')) throw new Error('Unexpected STIX2 font inputs');
  const expected = new Set(['svg.js']);
  function list(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Font symlink not permitted');
      const full = join(dir, entry.name);
      if (entry.isDirectory()) list(full);
      else if (entry.name.endsWith('.js')) expected.add(relative(source, full).replaceAll('\\', '/'));
    }
  }
  list(join(source, 'svg'));
  function rejectStale(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Font symlink not permitted');
      const full = join(dir, entry.name);
      if (entry.isDirectory()) rejectStale(full);
      else if (entry.name.endsWith('.js') && !expected.has(relative(target, full).replaceAll('\\', '/'))) {
        throw new Error('Unreviewed/stale math font asset: ' + relative(target, full));
      }
    }
  }
  rejectStale(target);
  for (const legal of ['LICENSE', 'OFL-STIX.txt', 'NOTICE.txt']) {
    if (!existsSync(join(target, legal))) throw new Error('Missing math font license: ' + legal);
  }
  mkdirSync(target, { recursive: true });
  cpSync(join(source, 'svg.js'), join(target, 'svg.js'));
  cpSync(join(source, 'svg'), join(target, 'svg'), { recursive: true });
}
