import { expect, it } from 'vitest';
import { parser, GFM } from '@lezer/markdown';
import { TreeFragment, type Tree } from '@lezer/common';
import { markdownSyntaxExtensions } from './extensions';

const legacy = parser.configure(GFM), current = parser.configure(markdownSyntaxExtensions);
function nodes(tree: Tree): unknown[] {
  const result: unknown[] = [];
  tree.iterate({ enter(node) { result.push([node.name, node.from, node.to]); } });
  return result;
}
it('逐行表格保留 GFM 的节点、范围、空单元格、转义及段落中断规则', () => {
  const endings = ['ordinary', '2. continuation', '1. list', '- list', '> quote', '# heading', '---', '===',
    '<div>block', '<custom>inline', '```js\nx\n```', '    indented', '| c | d |', '', '[link]: /x'];
  for (const header of ['| a | b |\n| --- | :---: |', 'a | b\n--- | ---', '| a\\|x | *b* |\n| --- | --- |', '| | b |\n| --- | --- |']) {
    for (const end of endings) {
      const text = header + '\n| x | y |\n' + end + '\n\nTail\n';
      expect(nodes(current.parse(text)), text).toEqual(nodes(legacy.parse(text)));
    }
  }
  for (const text of ['> | a | b |\n> | --- | --- |\n> | c | d |\n', '- | a | b |\n  | --- | --- |\n  | c | d |\n'])
    expect(nodes(current.parse(text))).toEqual(nodes(legacy.parse(text)));
});

it('超大表格的每次 advance 仅推进一行，完整行数与增量编辑语义保留', () => {
  const text = '| Name | Value |\n| --- | --- |\n' + Array.from({ length: 6000 }, (_, i) => `| row ${i} | **value ${i}** |\n`).join('');
  const partial = current.startParse(text);
  let tree: Tree | null = null, previous = 0, steps = 0;
  while (!(tree = partial.advance())) {
    expect(partial.parsedPos - previous).toBeLessThan(80);
    previous = partial.parsedPos; steps++;
  }
  expect(steps).toBeGreaterThan(6000);
  const table = tree.topNode.firstChild!;
  expect(table.name).toBe('Table'); expect(table.getChildren('TableRow')).toHaveLength(6000);
  const at = text.indexOf('value 3000'), changed = text.slice(0, at) + 'changed' + text.slice(at + 10);
  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: at, toA: at + 10, fromB: at, toB: at + 7 }]);
  expect(nodes(current.parse(changed, fragments))).toEqual(nodes(legacy.parse(changed)));
});
