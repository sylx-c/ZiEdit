import { describe, expect, it } from 'vitest';
// @ts-expect-error Project-owned CommonJS adapter deliberately has no build dependency.
import stackback from '../tools/stackback-compat/index.cjs';

describe('project-owned diagnostic stack adapter', () => {
  it('returns actual CallSite objects and restores a prior global formatter', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    const previous = () => 'original formatter';
    Object.defineProperty(Error, 'prepareStackTrace', { configurable: true, writable: true, value: previous });
    try {
      const frames = stackback(new Error('fresh'));
      expect(frames.length).toBeGreaterThan(0);
      expect(typeof frames[0].getFileName).toBe('function');
      expect((Error as unknown as { prepareStackTrace: unknown }).prepareStackTrace).toBe(previous);
    } finally {
      if (descriptor) Object.defineProperty(Error, 'prepareStackTrace', descriptor);
      else Reflect.deleteProperty(Error, 'prepareStackTrace');
    }
  });
  it('handles a materialized string stack without treating it as CallSites', () => {
    const error = new Error('text');
    Object.defineProperty(error, 'stack', { value: 'text stack', configurable: true });
    expect(stackback(error)).toEqual([]);
    expect(stackback(null)).toEqual([]);
  });
  it('restores formatter even when obtaining stack throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    const error = new Error('throw');
    Object.defineProperty(error, 'stack', { get() { throw new Error('unreadable'); } });
    expect(() => stackback(error)).toThrow('unreadable');
    expect(Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')).toEqual(descriptor);
  });
});
