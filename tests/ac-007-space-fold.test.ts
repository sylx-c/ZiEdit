// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { buildLiveDeco } from '../src/markdown-view/live-deco';
import { emojiField, referenceField } from '../src/markdown-view/live-state';
import { findHighlighter } from '../src/markdown-view/live-block-field';

function mount(anchor: number, head = anchor) {
  const source = '甲   乙\n\n`code   literal`\n\n尾段';
  const view = new EditorView({ state: EditorState.create({ doc: source, selection: { anchor, head },
    extensions: [markdown({ base: markdownLanguage }), referenceField, emojiField,
      findHighlighter(() => ({ needle: '甲   乙', opts: { caseSensitive: true, wholeWord: false, regex: false } }))] }) });
  ensureSyntaxTree(view.state, source.length, 100);
  const folds: [number, number][] = [];
  for (let c = buildLiveDeco(view, null).iter(); c.value; c.next())
    if (c.value.spec.class === 'md-space-fold') folds.push([c.from, c.to]);
  return { view, folds, source };
}

describe('AC-38 非活动正文空格折叠', () => {
  it('仅标记多余空格，代码字面量和源文档不变', () => {
    const { view, folds, source } = mount(25);
    expect(folds).toEqual([[2, 4]]);
    expect(view.state.doc.toString()).toBe(source);
    view.destroy();
  });
  it('光标所在行与选区保持原空格', () => {
    for (const [anchor, head] of [[1, 1], [0, 5]]) {
      const { view, folds } = mount(anchor!, head!);
      expect(folds).toEqual([]);
      view.destroy();
    }
  });
  it('查找高亮仍覆盖完整源范围', () => {
    const { view, folds } = mount(25);
    expect(folds).toEqual([[2, 4]]);
    expect(view.dom.querySelector('.mdir-findhit')?.textContent).toBe('甲   乙');
    expect(view.state.doc.sliceString(0, 5)).toBe('甲   乙');
    view.destroy();
  });
});
