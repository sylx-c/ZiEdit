// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { requestIrFrame, cancelIrFrame } from './frame-work';

afterEach(() => vi.restoreAllMocks());

it('shares the 8ms budget and runs newly queued continuation work on a later frame', () => {
  const frames = new Map<number, FrameRequestCallback>(); let serial = 0, now = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++serial, callback); return serial; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const run = () => { const frame = [...frames][0]!; frames.delete(frame[0]); frame[1](now); };
  const order: string[] = [];
  requestIrFrame(() => { order.push('inline'); now += 8; requestIrFrame(() => { order.push('continuation'); }); });
  const block = requestIrFrame(() => { order.push('block'); });
  run();
  expect(order).toEqual(['inline']);
  run();
  expect(order).toEqual(['inline', 'block', 'continuation']);
  cancelIrFrame(block);
  const cancelled = requestIrFrame(() => { throw new Error('destroyed work'); });
  cancelIrFrame(cancelled);
  expect(frames.size).toBe(0);
});
