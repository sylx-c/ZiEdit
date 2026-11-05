import type { ScrollAnchor } from '../common/scroll-anchor';
import { readingSurface } from './reading-surface';

type TopLine = (scroller: HTMLElement) => number | null;
type ScrollToLine = (scroller: HTMLElement, line: number) => void;

export function capturePreviewAnchor(scroller: HTMLElement | null, previewTopLine: TopLine): ScrollAnchor | undefined {
  if (scroller) { const surface = readingSurface(scroller); if (surface) return surface.capture(); }
  const line = scroller ? previewTopLine(scroller) : null;
  return line == null ? undefined : { line, surface: 'preview' };
}

/** 尺寸变化后的锚定由阅读面负责，恢复入口不留下定时写回。 */
export function restorePreviewAnchor(scroller: HTMLElement, anchor: ScrollAnchor, previewScrollToLine: ScrollToLine): void {
  const surface = readingSurface(scroller);
  if (surface) surface.restore(anchor);
  else previewScrollToLine(scroller, anchor.line);
}
