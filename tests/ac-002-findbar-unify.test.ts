// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { findAllIn } from '../src/common/findall';
import { EditView } from '../src/text-view/edit';
import { FindBar, buildNeedleRe } from '../src/text-view/findbar';

const opts = { caseSensitive: true, wholeWord: false, regex: false };
describe('002 查找 Rust 黄金向量', () => {
  it.each([
    ['error code err-101', 'err', true, [11]],
    ['an error here', 'error', true, [3]],
    ['errors here', 'error', true, []],
    ['err_code', 'err', true, []],
    ['plain find', 'find', false, [6]],
    ['err err err', 'err', false, [0, 4, 8]],
  ] as const)('%s', (text, needle, wholeWord, expected) => {
    expect(findAllIn(text, needle, { ...opts, wholeWord }).map(m => m.from)).toEqual(expected);
  });
  it('大小写逐字符折叠与展开映射', () => {
    const o = { ...opts, caseSensitive: false };
    expect(findAllIn('Err eRR', 'err', o).map(m => m.from)).toEqual([0, 4]);
    expect(findAllIn('İı', 'ı', o).map(m => m.from)).toEqual([1]);
    expect(findAllIn('aİbİc', 'i', o).map(m => m.from)).toEqual([1, 3]);
    expect(findAllIn('ΣΣ', 'σσ', o).map(m => m.from)).toEqual([0]);
  });
  it('正则全字组合与中文边界', () => {
    expect(findAllIn('error err err_1 err-2', 'err', { ...opts, regex: true, wholeWord: true }).map(m => m.from)).toEqual([6, 16]);
    expect(findAllIn('中文 文 文_ 文-字', '文', { ...opts, regex: true, wholeWord: true }).map(m => m.col)).toEqual([4, 9]);
    expect(findAllIn('😀x', 'x', opts)[0]).toEqual({ from: 2, to: 3, col: 2 });
  });
  it('非法正则不退化', () => {
    expect(() => findAllIn('[', '[', { ...opts, regex: true })).toThrow('Regex error:');
    expect(() => buildNeedleRe('[', { ...opts, regex: true })).toThrow('Regex error:');
  });
  it('编辑 fbRun 实例直调：字符列、行内正则、错误与导航', async () => {
    const edit = Object.create(EditView.prototype) as any;
    edit.view = { state: EditorState.create({ doc: '😀x\nerror err err_1 err-2' }) };
    edit.navigateTo = vi.fn();
    expect((await edit.fbRun('x', opts, 1, true, true)).hit).toEqual({ line: 1, col: 2 });
    expect((await edit.fbRun('err', { ...opts, wholeWord: true, regex: true }, 1, true, false)).counts.total).toBe(2);
    await expect(edit.fbRun('[', { ...opts, regex: true }, 1, true, false)).rejects.toThrow('Regex error:');
    const bar = new FindBar({ run: (...args) => edit.fbRun(...args) });
    bar.inputEl.value = '[';
    (bar as any).opts.regex = true;
    await bar.go(1);
    expect(bar.el.querySelector('.fb-count')!.textContent).toContain('Regex error:');
    bar.hide();
  });
});
