import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeActionFor, startAutosaveTimers, type AutosaveCtx } from '../src/shell/autosave';
import { INITIAL_SNAP_HINTS, snapshotHint } from '../src/shell/recovery-hints';

afterEach(() => { vi.useRealTimers(); });

describe('关闭保存判决', () => {
  it('默认确认；启用静默保存；净缓冲直接关闭', () => {
    expect(closeActionFor(true)).toBe('confirm');
    expect(closeActionFor(true, false)).toBe('confirm');
    expect(closeActionFor(true, true)).toBe('save');
    expect(closeActionFor(false, false)).toBe('close');
    expect(closeActionFor(false, true)).toBe('close');
    expect(closeActionFor(true, true, true)).toBe('close');
    expect(closeActionFor(true, true, false)).toBe('abort');
    expect(closeActionFor(false, true, false)).toBe('abort');
  });
});

describe('自动保存重试', () => {
  function setup(saveNow: AutosaveCtx['saveNow']) {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let dirty = true;
    const failed = vi.fn();
    const saved = vi.fn();
    const stop = startAutosaveTimers({
      getSettings: () => ({ autoSaveSec: 1, autoSaveTarget: 'file' }),
      activeInfo: () => ({ path: '/a.txt', draft: false }),
      isDirty: () => dirty, content: () => '', snapshot: () => {},
      saveNow, onFileSaved: saved, onSaveFailed: failed, isSwitchPending: () => false,
    });
    return { failed, saved, stop, clean: () => { dirty = false; }, dirty: () => { dirty = true; } };
  }

  it('失败下个心跳重试，共三次后只提示一次并停；转净重置', async () => {
    const save = vi.fn(async () => false);
    const ctx = setup(save);
    await vi.advanceTimersByTimeAsync(3000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(ctx.failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(3);
    expect(ctx.failed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(save).toHaveBeenCalledTimes(3);
    ctx.clean();
    await vi.advanceTimersByTimeAsync(1500);
    ctx.dirty();
    await vi.advanceTimersByTimeAsync(3000);
    expect(save).toHaveBeenCalledTimes(4);
    ctx.stop();
  });

  it('拒绝也计失败，成功清连续失败计数', async () => {
    const save = vi.fn<AutosaveCtx['saveNow']>()
      .mockRejectedValueOnce(new Error('disk'))
      .mockResolvedValueOnce(true).mockResolvedValue(false);
    const ctx = setup(save);
    await vi.advanceTimersByTimeAsync(4500);
    expect(ctx.saved).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(ctx.failed).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(5);
    ctx.stop();
  });

  it('未完成的保存不重复启动', async () => {
    const save = vi.fn(() => new Promise<boolean>(() => {}));
    const ctx = setup(save);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(save).toHaveBeenCalledTimes(1);
    ctx.stop();
  });
});

describe('大文档提示去重窗口', () => {
  it('持续超限每 60s 提醒，成功写快照复位', () => {
    const out = { skipped: true, evicted: 0 };
    const first = snapshotHint(out, INITIAL_SNAP_HINTS, 0);
    expect(first.key).toBe('msg.snapSkip');
    expect(snapshotHint(out, first.state, 59_999).key).toBeNull();
    const next = snapshotHint(out, first.state, 60_000);
    expect(next.key).toBe('msg.snapSkip');
    expect(snapshotHint(out, next.state, 60_001).key).toBeNull();
    const reset = snapshotHint({ skipped: false, evicted: 2 }, next.state, 61_000);
    expect(reset.key).toBe('msg.snapEvict');
    expect(snapshotHint(out, reset.state, 61_001).key).toBe('msg.snapSkip');
    expect(INITIAL_SNAP_HINTS).toEqual({ skipNotified: false });
  });
});
