import { expect, it } from 'vitest';
import { Tree, TreeFragment } from '@lezer/common';
import { parser, GFM } from '@lezer/markdown';
import { liveMarkdownExtensions } from './extensions';

it.each([false, true])('tail typing keeps fragments and shared subtrees (custom rules=%s)', custom => {
  const md = parser.configure(custom ? [GFM, liveMarkdownExtensions] : [GFM]);
  const block = 'paragraph text '.repeat(20) + '\n\n- item **bold**\n\n```js\nconst n = 1;\n```\n\n'
    + '| a | b |\n| --- | --- |\n| v | t |\n\n$$\nx+1\n$$\n\nnote [^n]\n\n[^n]: footnote\n\n';
  const text = block.repeat(5000) + 'last paragraph target';
  const old = md.parse(text), at = text.length;
  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(old), [{ fromA: at, toA: at, fromB: at, toB: at + 1 }]);
  const coverage = fragments.reduce((sum, fragment) => sum + fragment.to - fragment.from, 0);
  const started = performance.now();
  const next = md.parse(text + 'x', fragments), ms = performance.now() - started;
  const timings = [ms];
  for (let i = 0; i < 8; i++) {
    const begin = performance.now(); md.parse(text + 'x', fragments); timings.push(performance.now() - begin);
  }
  timings.sort((a, b) => a - b);
  const oldNodes = new Set<object>();
  const collect = (tree: Tree): void => { for (const child of tree.children) { oldNodes.add(child); if (child instanceof Tree) collect(child); } };
  collect(old);
  let shared = 0;
  const compare = (tree: Tree): void => { for (const child of tree.children) { if (oldNodes.has(child)) shared++; if (child instanceof Tree) compare(child); } };
  compare(next);
  expect(next.length).toBe(text.length + 1);
  expect(text.length + 1 - coverage).toBeLessThanOrEqual(256);
  expect(shared).toBeGreaterThan(0);
  console.info('IR tail parse reuse', { custom, chars: text.length, fragments: fragments.length, uncoveredChars: text.length + 1 - coverage,
    sharedSubtrees: shared, medianMs: +timings[4]!.toFixed(3), samples: timings.length });
});
