// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, foldable, syntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { editorMarkdown } from './editor-language';

it('keeps GFM, folding, language data and list editing with the shared parser', () => {
  const state = EditorState.create({ doc: '# heading\n\n- [x] task\n\n| a |\n| --- |\n| b |\n\n```js\nconst x = 1;\n```\n', extensions: [editorMarkdown()] });
  ensureSyntaxTree(state, state.doc.length, 1000);
  const tree = syntaxTree(state).toString();
  expect(tree).toContain('Task'); expect(tree).toContain('Table'); expect(tree).toContain('FencedCode');
  expect(state.languageDataAt('commentTokens', 0)).toContainEqual({ block: { open: '<!--', close: '-->' } });
  expect(foldable(state, 0, 9)?.to).toBeGreaterThan(9);
  const view = new EditorView({ state: EditorState.create({ doc: '- item', selection: { anchor: 6 }, extensions: [editorMarkdown()] }) });
  try { expect(insertNewlineContinueMarkup(view)).toBe(true); expect(view.state.doc.toString()).toBe('- item\n- '); }
  finally { view.destroy(); }
});

it('does not wrap a completed Markdown parse in an uninterruptible mixed-language scan', () => {
  const parser = editorMarkdown().language.parser;
  const parse = parser.startParse('paragraph\n\n'.repeat(6001));
  expect(parse.constructor.name).not.toBe('MixedParse');
  let tree = parse.advance(); while (!tree) tree = parse.advance();
  expect(tree.length).toBe(11 * 6001);
});
