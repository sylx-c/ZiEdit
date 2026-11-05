// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditView } from '../src/text-view/edit';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
const views: EditView[] = [];
function editor(doc = 'alpha bravo charlie\nsecond line\nthird line\nfourth line') {
  const host = document.body.appendChild(document.createElement('div'));
  const v = new EditView(host, { path: null, language: null, encoding: 'UTF-8', initialDoc: doc,
    onStatus: () => {}, onSaveAsNeeded: () => {}, onSaved: () => {} });
  views.push(v);
  return v;
}
afterEach(() => { views.splice(0).forEach(v => v.destroy()); document.body.replaceChildren(); });

describe('自由选字与列选区键盘交互', () => {
  it.each([false, true])('列模式/Alt 拖选同一行保留所选文字（columnMode=%s）', columnMode => {
    const v = editor();
    if (columnMode) v.toggleColumnMode();
    vi.spyOn(v.view, 'posAtCoords').mockImplementation(coords => Math.round(coords.x / 10));
    vi.spyOn(v.view, 'coordsAtPos').mockImplementation(pos => ({ left: pos * 10, right: pos * 10, top: 0, bottom: 20 }));
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 60, clientY: 10, altKey: !columnMode });
    v.view.contentDOM.dispatchEvent(down);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 110, clientY: 10, buttons: 1 }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 110, clientY: 10 }));
    const sel = v.view.state.selection.main;
    expect(v.view.state.sliceDoc(sel.from, sel.to)).toBe('bravo');
    expect(v.hasColumnRect()).toBe(false);
  });

  it('反向拖选同一行不会松手后退成光标', () => {
    const v = editor(); v.toggleColumnMode();
    vi.spyOn(v.view, 'posAtCoords').mockImplementation(coords => Math.round(coords.x / 10));
    vi.spyOn(v.view, 'coordsAtPos').mockImplementation(pos => ({ left: pos * 10, right: pos * 10, top: 0, bottom: 20 }));
    v.view.contentDOM.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 110, clientY: 10 }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 60, clientY: 10 }));
    expect(v.view.state.selection.main.anchor).toBe(11);
    expect(v.view.state.selection.main.head).toBe(6);
  });

  it('从中间行向上扩展可继续向上，反向可缩回原点', () => {
    const v = editor();
    const pos = v.view.state.doc.line(3).from + 2;
    v.view.dispatch({ selection: { anchor: pos } });
    v.growColumnRect(-1); v.growColumnRect(-1);
    expect(v.view.state.selection.ranges).toHaveLength(3);
    expect(v.view.state.doc.lineAt(v.view.state.selection.main.head).number).toBe(1);
    v.growColumnRect(1); v.growColumnRect(1);
    expect(v.view.state.selection.ranges).toHaveLength(1);
    expect(v.view.state.selection.main.head).toBe(pos);
  });

  it('水平扩展可缩为零宽并穿过起点，首按不额外选中下一行', () => {
    const v = editor(); v.view.dispatch({ selection: { anchor: 6 } });
    v.growColumnHorizontal(1);
    expect(v.view.state.selection.ranges).toHaveLength(1);
    expect(v.view.state.selection.main.from).toBe(6);
    expect(v.view.state.selection.main.to).toBe(7);
    v.growColumnHorizontal(-1);
    expect(v.view.state.selection.main.empty).toBe(true);
    v.growColumnHorizontal(-1);
    expect(v.view.state.selection.main.from).toBe(5);
    expect(v.view.state.selection.main.to).toBe(6);
  });

  it('Escape 后再次扩展从当前光标开始，不恢复旧的固定端点', () => {
    const v = editor();
    v.view.dispatch({ selection: { anchor: v.view.state.doc.line(3).from + 2 } });
    v.growColumnRect(-1); v.growColumnRect(-1);
    v.escapeColumnRect();
    v.growColumnRect(1);
    expect(v.view.state.selection.ranges.map(r => v.view.state.doc.lineAt(r.from).number)).toEqual([1, 2]);
  });

  it('列输入改变宽度后继续扩选使用新的矩形边界', () => {
    const v = editor(); v.view.dispatch({ selection: { anchor: 1 } });
    v.growColumnRect(1); v.growColumnHorizontal(1);
    expect(v.typeInColumn('ZZ')).toBe(true);
    v.growColumnHorizontal(1);
    const first = v.view.state.selection.ranges[0];
    expect(v.view.state.sliceDoc(first.from, first.to)).toBe('ZZp');
  });
});
