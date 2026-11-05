// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import { editorMarkdown } from '../markdown-view/editor-language';
import { cmScrollSurface } from './scroll-surface';

it('samples source literally and IR structure from the same height map without querying offscreen DOM', () => {
  const state = EditorState.create({ doc: '# heading\n\n```js\nconst x = 1;\n```\n\n- item\n\n![alt](local.png)', extensions: [editorMarkdown()] });
  ensureSyntaxTree(state, state.doc.length, 1000);
  const scrollDOM = document.createElement('div'); let line = 1;
  const view = { state, scrollDOM, contentHeight: 100, documentTop: 0, visibleRanges: [],
    lineBlockAtHeight: () => ({ from: state.doc.line(line).from, to: state.doc.line(line).to, top: 0, height: 100 }),
    domAtPos: () => { throw new Error('offscreen DOM read'); },
  } as unknown as EditorView;
  const source = cmScrollSurface(view, 'source'), ir = cmScrollSurface(view, 'ir');
  const layout = { version: 1, height: 100, top: 0, viewport: 20 };
  expect(source.overview(1, layout)[0]!.text).toBe('# heading');
  expect(ir.overview(1, layout)[0]!.kind).toBe('heading');
  line = 4; expect(ir.overview(1, layout)[0]).toMatchObject({ text: 'const x = 1;', kind: 'code' });
  line = 7; expect(ir.overview(1, layout)[0]!.kind).toBe('list');
  line = 9; expect(ir.overview(1, layout)[0]).toMatchObject({ text: '[image]', kind: 'image' });
  expect(source.overview(1, layout)[0]!.text).toBe('![alt](local.png)');
});
