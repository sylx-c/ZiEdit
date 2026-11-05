// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { dispatchIrLayout } from './ir-layout';

afterEach(() => vi.restoreAllMocks());
function fixture(text = 'lead\n\nnext paragraph\n') {
  const scroller = document.createElement('div'); scroller.scrollTop = 120;
  Object.defineProperties(scroller, { clientHeight: { value: 600 }, scrollHeight: { value: 2000 } });
  scroller.getBoundingClientRect = () => ({ top: 100, bottom: 700, left: 10, right: 810 }) as DOMRect;
  const view = { scrollDOM: scroller, documentTop: -20, state: EditorState.create({ doc: text }),
    lineBlockAtHeight: () => ({ from: 5, to: 5 }),
    coordsAtPos: vi.fn(() => ({ top: 113, bottom: 133, left: 30, right: 31 })), dispatch: vi.fn(),
  } as unknown as EditorView;
  return { view, scroller };
}

it('keeps the visible text after a shrinking blank line through the same CM transaction', () => {
  const { view, scroller } = fixture();
  const effect = StateEffect.define<null>().of(null), scroll = vi.spyOn(EditorView, 'scrollIntoView');
  dispatchIrLayout(view, effect);
  expect(scroll).toHaveBeenCalledWith(6, { y: 'start', yMargin: 13, xMargin: 0 });
  expect(view.dispatch).toHaveBeenCalledWith({ effects: [effect, scroll.mock.results[0]!.value] });
  expect(scroller.scrollTop).toBe(120);
  expect(view.state.selection.main.head).toBe(0);
});

it.each(['content', 'bottom', 'horizontal', 'offscreen'])('preserves the native anchor for %s', reason => {
  const { view, scroller } = fixture();
  if (reason === 'content') vi.spyOn(view, 'lineBlockAtHeight').mockReturnValue({ from: 6, to: 20 } as any);
  if (reason === 'bottom') scroller.scrollTop = 1400;
  if (reason === 'horizontal') vi.mocked(view.coordsAtPos).mockReturnValue({ top: 113, bottom: 133, left: -40, right: -39 });
  if (reason === 'offscreen') vi.mocked(view.coordsAtPos).mockReturnValue(null);
  const effect = StateEffect.define<null>().of(null), scroll = vi.spyOn(EditorView, 'scrollIntoView');
  dispatchIrLayout(view, effect);
  expect(scroll).not.toHaveBeenCalled();
  expect(view.dispatch).toHaveBeenCalledWith({ effects: effect });
});
