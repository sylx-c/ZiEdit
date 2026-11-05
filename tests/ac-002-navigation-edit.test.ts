// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { EditView } from '../src/text-view/edit';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { trackImageTarget } from '../src/markdown-view/imagehost';

vi.mock('../src/common/ipc', () => ({
  textOpen: async () => ({ newline: 'lf', mixed: false }),
  textReadAll: async () => '',
  textSave: async () => {},
}));
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

async function editor(bookmarks: number[] = []) {
  const saved: number[][] = [];
  let ready!: () => void;
  const gate = new Promise<void>(resolve => { ready = resolve; });
  const v = new EditView(document.createElement('div'), {
    path: 'audit.txt', language: null, encoding: 'UTF-8',
    initialDoc: Array.from({ length: 50 }, (_, n) => `line ${n + 1}`).join('\n'),
    restoreBookmarks: bookmarks, onBookmarksChange: (_, values) => saved.push(values),
    onStatus: () => {}, onSaveAsNeeded: () => {}, onSaved: () => {}, onReady: ready,
  });
  await gate;
  return { v, saved, line: () => v.view.state.doc.lineAt(v.view.state.selection.main.head).number };
}

describe('002 编辑面导航回归', () => {
  it('草稿同步就绪时直接收到可用实例，不依赖构造赋值后的闭包', () => {
    let received: EditView | undefined;
    const v = new EditView(document.createElement('div'), {
      path: null, initialDoc: '草稿', language: null, encoding: 'UTF-8',
      onStatus: () => {}, onSaveAsNeeded: () => {}, onSaved: () => {},
      onReady: view => { received = view; view.goToLine(1); },
    });
    expect(received).toBe(v);
    expect(received?.view.state.doc.toString()).toBe('草稿');
    v.destroy();
  });
  it('销毁后复用宿主不会触发旧右键和滚轮监听', async () => {
    const host = document.createElement('div');
    const menu = vi.fn();
    const font = vi.fn();
    let ready!: () => void;
    const gate = new Promise<void>(resolve => { ready = resolve; });
    const view = new EditView(host, {
      path: 'old.txt', initialDoc: 'old', language: null, encoding: 'UTF-8',
      onStatus: () => {}, onSaveAsNeeded: () => {}, onSaved: () => {}, onReady: ready,
      onContextMenu: menu, onFontSize: font,
    });
    await gate;
    view.view.dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(menu).toHaveBeenCalledTimes(1);
    view.destroy();
    host.replaceChildren(document.createElement('div'));
    host.firstElementChild!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    host.firstElementChild!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, ctrlKey: true, deltaY: 100 }));
    expect(menu).toHaveBeenCalledTimes(1);
    expect(font).not.toHaveBeenCalled();
  });
  it('书签随插入映射，下一书签环绕并持久化', async () => {
    const { v, saved, line } = await editor([10, 30]);
    v.goToLine(15);
    v.nextBookmark();
    expect(line()).toBe(30);
    v.view.dispatch({ changes: { from: 0, insert: 'new\n' } });
    expect(saved[saved.length - 1]).toEqual([11, 31]);
    v.nextBookmark();
    expect(line()).toBe(11);
    v.toggleBookmark();
    expect(saved[saved.length - 1]).toEqual([31]);
    v.destroy();
  });
  it('跳行前后退、编辑位置映射和分支历史', async () => {
    const { v, line } = await editor();
    v.goToLine(10);
    v.goToLine(40);
    v.historyBack();
    expect(line()).toBe(10);
    v.view.dispatch({ changes: { from: 0, insert: 'new\n' } });
    v.historyForward();
    expect(line()).toBe(41);
    v.historyBack();
    v.goToLine(20);
    v.historyForward();
    expect(line()).toBe(20);
    v.historyBack();
    expect(line()).toBe(11);
    v.destroy();
  });
});

describe('009 异步图片目标', () => {
  it('上传期间前部输入后仍替换原引用，目标被改写则失效', () => {
    const view = new EditorView({ state: EditorState.create({ doc: 'abc image.png xyz' }) });
    const target = trackImageTarget(view, 4, 13);
    view.dispatch({ changes: { from: 0, insert: 'prefix ' } });
    expect(target.range()).toEqual({ from: 11, to: 20 });
    view.dispatch({ changes: { from: 12, to: 13, insert: 'Q' } });
    expect(target.range()).toBeNull();
    target.dispose();
    view.destroy();
  });
  it('切换文档销毁视图后不能回填，空插入点随继续输入向后映射', () => {
    const view = new EditorView({ state: EditorState.create({ doc: 'abc' }) });
    const target = trackImageTarget(view, 3);
    view.dispatch({ changes: { from: 3, insert: 'def' } });
    expect(target.range()).toEqual({ from: 6, to: 6 });
    view.destroy();
    expect(target.range()).toBeNull();
    target.dispose();
  });
});
