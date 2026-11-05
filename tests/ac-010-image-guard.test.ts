// tests/ac-010-image-guard.test.ts
import { describe, it, expect } from 'vitest';
import { shouldGuard, isProbeableImage, GUARD_MAX_SIDE, GUARD_MAX_PIXELS } from '../src/image-view/guard';

describe('shouldGuard 阈值（ac-010）', () => {
  it('16384 边长恰在限内不守护，16385 守护', () => {
    expect(shouldGuard(16384, 4000)).toBe(false);
    expect(shouldGuard(16385, 10)).toBe(true);
    expect(shouldGuard(10, 16385)).toBe(true);
  });
  it('像素超 66MP 守护，64MP 不守护', () => {
    expect(shouldGuard(8000, 8000)).toBe(false);          // 64MP
    expect(shouldGuard(8126, 8126)).toBe(true);            // ≈66.03MP
    expect(GUARD_MAX_PIXELS).toBe(66_000_000);
    expect(GUARD_MAX_SIDE).toBe(16384);
  });
});

describe('isProbeableImage 仅位图探测（ac-010）', () => {
  it('png/jpg/jpeg/webp/bmp 大小写不敏感', () => {
    for (const p of ['a.png', 'A.JPG', 'b.WebP', 'c.bmp', 'd.jpeg']) expect(isProbeableImage(p)).toBe(true);
  });
  it('svg/gif/无扩展名不探测', () => {
    for (const p of ['a.svg', 'a.gif', 'a.txt', 'noext']) expect(isProbeableImage(p)).toBe(false);
  });
});
