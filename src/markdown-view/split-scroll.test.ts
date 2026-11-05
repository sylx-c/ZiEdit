// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { SplitScrollCoordinator } from './split-scroll';
import type { ScrollSurfaceAdapter } from '../common/scroll-surface';

it('分屏到顶、到底同步到真实文档边界', () => {
  let frame!: FrameRequestCallback;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  let left = 900, right = 20;
  const surface = (side: 'left' | 'right'): ScrollSurfaceAdapter => ({
    element: document.createElement('div'),
    snapshot: () => ({ version: 1, top: side === 'left' ? left : right, height: side === 'left' ? 1000 : 2000, viewport: 100 }),
    capture: () => ({ line: 30, surface: 'source' }), restore: () => { throw new Error('boundary must use actual height'); },
    scrollTo: y => { if (side === 'left') left = Math.min(900, y); else right = Math.min(1900, y); }, overview: () => [],
  });
  const surfaces = { left: surface('left'), right: surface('right') };
  const sync = new SplitScrollCoordinator(side => surfaces[side]);
  try {
    sync.scrolled('left'); frame(0); expect(right).toBe(1900);
    sync.claim('right'); right = 0; sync.scrolled('right'); frame(16); expect(left).toBe(0);
  } finally { sync.destroy(); vi.unstubAllGlobals(); }
});
