// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { requestIrFrame, cancelIrFrame, measureAfterRender } from './frame-work';
import { hasPendingInput } from '../common/input-pending';

afterEach(() => { if (vi.isFakeTimers()) vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('settles each editor transaction before admitting another transaction for the same surface', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let next!: FrameRequestCallback;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { next = callback; return 1; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const editor = {}, other = {}, order: string[] = [];
  requestIrFrame(() => { order.push('first'); measureAfterRender(editor, () => order.push('first measured')); }, false, editor);
  requestIrFrame(() => { order.push('second'); measureAfterRender(editor, () => order.push('second measured')); }, false, editor);
  requestIrFrame(() => { order.push('other surface'); }, false, other);
  next(0); vi.runOnlyPendingTimers();
  expect(order).toEqual(['first', 'other surface', 'first measured']);
  next(16); vi.runOnlyPendingTimers();
  expect(order).toEqual(['first', 'other surface', 'first measured', 'second', 'second measured']);
});

it('finishes pending surface layout before admitting background parsing on a later frame', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let next!: FrameRequestCallback;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { next = callback; return 1; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const owner = {}, order: string[] = [];
  requestIrFrame(() => { order.push('parse'); }, true);
  requestIrFrame(() => { order.push('write'); measureAfterRender(owner, () => order.push('layout')); });
  next(0); vi.runOnlyPendingTimers();
  expect(order).toEqual(['write', 'layout']);
  next(16); vi.runOnlyPendingTimers();
  expect(order).toEqual(['write', 'layout', 'parse']);
});

it('measures a surface once after its writes and reserves room in the shared budget', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let next!: FrameRequestCallback, now = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { next = callback; return 1; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const owner = {}, order: string[] = [];
  requestIrFrame(() => { order.push('inline'); measureAfterRender(owner, () => order.push('measure')); now += 3; });
  requestIrFrame(() => { order.push('block'); measureAfterRender(owner, () => order.push('measure')); now += 3; });
  const later = requestIrFrame(() => { order.push('later'); });
  next(0); vi.runOnlyPendingTimers();
  expect(order).toEqual(['inline', 'block', 'measure']);
  next(16); vi.runOnlyPendingTimers();
  expect(order).toEqual(['inline', 'block', 'measure', 'later']);
  cancelIrFrame(later);
});

it('lets queued continuous input run before background work while keeping visible work available', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let next!: FrameRequestCallback, pending = true;
  const scheduling = { isInputPending: vi.fn((options: { includeContinuous: boolean }) => pending && options.includeContinuous) };
  const original = Object.getOwnPropertyDescriptor(navigator, 'scheduling');
  Object.defineProperty(navigator, 'scheduling', { configurable: true, value: scheduling });
  try {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { next = callback; return 1; });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const order: string[] = [];
    const background = requestIrFrame(() => { order.push('background'); }, true);
    requestIrFrame(() => { order.push('visible'); });
    expect(hasPendingInput()).toBe(true);
    next(0); vi.runOnlyPendingTimers(); expect(order).toEqual(['visible']);
    pending = false;
    next(16); vi.runOnlyPendingTimers(); expect(order).toEqual(['visible', 'background']);
    expect(scheduling.isInputPending).toHaveBeenCalledWith({ includeContinuous: true });
    cancelIrFrame(background);
  } finally {
    if (original) Object.defineProperty(navigator, 'scheduling', original);
    else Reflect.deleteProperty(navigator, 'scheduling');
  }
});

it('lets background microtasks finish before spending the rest of the frame budget', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let next!: FrameRequestCallback;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { next = callback; return 1; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const order: number[] = [];
  const first = new Promise<void>(resolve => requestIrFrame(resolve, true)).then(() => { order.push(1); now += 3; });
  const second = new Promise<void>(resolve => requestIrFrame(resolve, true)).then(() => { order.push(2); now += 6; });
  const third = new Promise<void>(resolve => requestIrFrame(resolve, true)).then(() => { order.push(3); });
  next(0); vi.runOnlyPendingTimers(); await first;
  expect(order).toEqual([1]);
  // 在独立宏任务继续，计入上一片微任务中的实际耗时。
  vi.runOnlyPendingTimers(); await second;
  expect(order).toEqual([1, 2]);
  vi.runOnlyPendingTimers();
  expect(order).toEqual([1, 2]);
  next(16); vi.runOnlyPendingTimers(); await third;
  expect(order).toEqual([1, 2, 3]);
  vi.runOnlyPendingTimers();
});

it('admits a newly queued background slice but yields to new input before the next slice', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let next!: FrameRequestCallback, pending = false, now = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { next = callback; return 1; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const original = Object.getOwnPropertyDescriptor(navigator, 'scheduling');
  Object.defineProperty(navigator, 'scheduling', { configurable: true, value: { isInputPending: () => pending } });
  const order: number[] = [];
  let last = 0;
  try {
    const first = new Promise<void>(resolve => requestIrFrame(resolve, true)).then(() => {
      order.push(1); now += 2;
      last = requestIrFrame(() => order.push(2), true);
    });
    next(0); vi.runOnlyPendingTimers(); await first;
    expect(order).toEqual([1]);
    pending = true;
    vi.runOnlyPendingTimers();
    expect(order).toEqual([1]);
    pending = false;
    next(16); vi.runOnlyPendingTimers();
    expect(order).toEqual([1, 2]);
  } finally {
    cancelIrFrame(last);
    if (original) Object.defineProperty(navigator, 'scheduling', original);
    else Reflect.deleteProperty(navigator, 'scheduling');
  }
});

it('delivers visible work before earlier background parsing within the same budget', () => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let next: FrameRequestCallback | undefined, now = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { next = callback; return 1; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const order: string[] = [];
  const background = requestIrFrame(() => { order.push('parse'); }, true);
  requestIrFrame(() => { order.push('visible'); now += 8; });
  next!(0); vi.runOnlyPendingTimers();
  expect(order).toEqual(['visible']);
  next!(8); vi.runOnlyPendingTimers();
  expect(order).toEqual(['visible', 'parse']);
  cancelIrFrame(background);
});

it('shares the 8ms budget and runs newly queued continuation work on a later frame', () => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const frames = new Map<number, FrameRequestCallback>(); let serial = 0, now = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++serial, callback); return serial; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const run = () => { const frame = [...frames][0]!; frames.delete(frame[0]); frame[1](now); };
  const order: string[] = [];
  requestIrFrame(() => { order.push('inline'); now += 8; requestIrFrame(() => { order.push('continuation'); }); });
  const block = requestIrFrame(() => { order.push('block'); });
  run();
  expect(order).toEqual([]); // 不在 rAF 中写高度，留给下一帧的 CM 测量完成后再绘制。
  vi.runOnlyPendingTimers();
  expect(order).toEqual(['inline']);
  run();
  vi.runOnlyPendingTimers();
  expect(order).toEqual(['inline', 'block', 'continuation']);
  cancelIrFrame(block);
  const cancelled = requestIrFrame(() => { throw new Error('destroyed work'); });
  cancelIrFrame(cancelled);
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
