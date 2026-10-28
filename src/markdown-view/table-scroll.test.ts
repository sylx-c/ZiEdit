// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { TableViewport } from './table-viewport';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('defers per-row geometry reads until scrolling has been quiet for 100ms', () => {
  vi.useFakeTimers(); vi.stubGlobal('ResizeObserver', undefined);
  const scrollDOM = document.createElement('div'), box = document.createElement('div'), table = document.createElement('table');
  box.append(table); scrollDOM.append(box); document.body.append(scrollDOM);
  const rect = { top: 0, height: 200 } as DOMRect;
  table.getBoundingClientRect = () => rect;
  scrollDOM.getBoundingClientRect = () => rect;
  let measure: { read: () => unknown; write: (measurement: never) => void } | undefined;
  const view = { scrollDOM, requestMeasure: (request: typeof measure) => { measure = request; } } as unknown as EditorView;
  const rowRead = vi.fn(() => ({ height: 32 }) as DOMRect);
  const viewport = new TableViewport(view, box, table, 300, 1, () => {
    const row = document.createElement('tr'); row.insertCell().textContent = 'cell';
    row.getBoundingClientRect = rowRead; return row;
  }, () => null, () => {});
  try {
    scrollDOM.dispatchEvent(new Event('scroll'));
    measure!.read();
    expect(rowRead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    measure!.read();
    expect(rowRead).not.toHaveBeenCalled();
    // 连续滚动延后校准，不让首次事件的定时器穿透。
    scrollDOM.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(99);
    measure!.read();
    expect(rowRead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    measure!.read();
    expect(rowRead).toHaveBeenCalled();
    rowRead.mockClear();
    scrollDOM.dispatchEvent(new Event('scroll'));
    viewport.destroy();
    measure = undefined;
    vi.advanceTimersByTime(100);
    expect(measure).toBeUndefined();
  } finally { viewport.destroy(); }
});
