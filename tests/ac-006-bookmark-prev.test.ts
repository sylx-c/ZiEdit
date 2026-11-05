// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { EditView } from '../src/text-view/edit';
import { TextView } from '../src/text-view/view';

describe('006 书签双向环绕', () => {
  it('EditView 空书签与多书签', () => {
    const v = Object.create(EditView.prototype) as any;
    let marks: number[] = [];
    v.view = { state: { field: () => marks, selection: { main: { head: 5 } } } };
    v.navigateTo = vi.fn();
    v.prevBookmark(); v.nextBookmark();
    expect(v.navigateTo).not.toHaveBeenCalled();
    marks = [2, 5, 9];
    v.prevBookmark(); expect(v.navigateTo).toHaveBeenLastCalledWith(2);
    v.nextBookmark(); expect(v.navigateTo).toHaveBeenLastCalledWith(9);
    v.view.state.selection.main.head = 2;
    v.prevBookmark(); expect(v.navigateTo).toHaveBeenLastCalledWith(9);
    v.view.state.selection.main.head = 9;
    v.nextBookmark(); expect(v.navigateTo).toHaveBeenLastCalledWith(2);
  });
  it('TextView 空书签与多书签', () => {
    const v = Object.create(TextView.prototype) as any;
    v.bookmarks = new Set();
    let cur = 5;
    v.currentLine = () => cur;
    v.goToLine = vi.fn();
    v.prevBookmark(); v.nextBookmark();
    expect(v.goToLine).not.toHaveBeenCalled();
    v.bookmarks = new Set([9, 2, 5]);
    v.prevBookmark(); expect(v.goToLine).toHaveBeenLastCalledWith(2, undefined, true);
    v.nextBookmark(); expect(v.goToLine).toHaveBeenLastCalledWith(9, undefined, true);
    cur = 2;
    v.prevBookmark(); expect(v.goToLine).toHaveBeenLastCalledWith(9, undefined, true);
    cur = 9;
    v.nextBookmark(); expect(v.goToLine).toHaveBeenLastCalledWith(2, undefined, true);
  });
});
