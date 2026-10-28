// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { TableViewport } from './table-viewport';

it('settled table measurements compensate at most once despite alternating row heights', async () => {
  vi.useFakeTimers();
  const scrollDOM = document.createElement('div'), box = document.createElement('div'), table = document.createElement('table');
  box.append(table); document.body.append(box);
  let measure: any, height = 40;
  const view = { scrollDOM, requestMeasure: (request: unknown) => { measure = request; } } as unknown as EditorView;
  vi.spyOn(scrollDOM, 'getBoundingClientRect').mockReturnValue({ top: 640, height: 320 } as DOMRect);
  vi.spyOn(table, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
  const viewport = new TableViewport(view, box, table, 300, 1, row => {
    const tr = document.createElement('tr'); tr.dataset.mdRow = String(row); tr.insertCell();
    tr.getBoundingClientRect = () => ({ height } as DOMRect); return tr;
  }, () => null, () => {});
  const positions: number[] = [];
  try {
    scrollDOM.scrollTop = 640; scrollDOM.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(100);
    for (height of [40, 24, 44, 28]) {
      measure.write(measure.read()); positions.push(scrollDOM.scrollTop);
      scrollDOM.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(100);
    }
    const corrections = positions.filter((top, i) => top !== (i ? positions[i - 1] : 640));
    expect(corrections.length, JSON.stringify(positions)).toBeLessThanOrEqual(1);
    expect(positions).toEqual([800, 800, 800, 800]);
  } finally { viewport.destroy(); box.remove(); vi.restoreAllMocks(); vi.useRealTimers(); }
});
