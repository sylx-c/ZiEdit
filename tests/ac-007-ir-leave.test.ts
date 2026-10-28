// 007 R5 v0.46：三键决策只适用于关闭/退出；普通切换直通见 switch-silent 测试。
// 关闭取消/保存失败不得执行 commit，放弃先弃快照再关闭。
import { describe, expect, it, vi } from 'vitest';
import { gateCloseWysiwyg, type LeaveCtx } from '../src/shell/wysiwyg-leave';

interface Harness {
  ctx: LeaveCtx<string>;
  commit: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  discard: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
  pending: () => boolean;
}

function harness(over: Partial<LeaveCtx<string>> = {}): Harness {
  let pending = false;
  const commit = vi.fn(() => 'committed');
  const confirm = vi.fn(() => Promise.resolve<'save' | 'discard' | 'cancel'>('cancel'));
  const save = vi.fn(() => Promise.resolve());
  const discard = vi.fn();
  const onCancel = vi.fn();
  const ctx: LeaveCtx<string> = {
    dirtyIr: true,
    stillOpen: true,
    pending: false,
    confirm,
    save,
    stillDirty: () => true,
    discard,
    commit,
    onCancel,
    setPending: v => {
      pending = v;
    },
    ...over,
  };
  return { ctx, commit, confirm, save, discard, onCancel, pending: () => pending };
}

const flush = () => Promise.resolve().then(() => Promise.resolve());

describe('AC-007 关闭 IR 的前置决策（gateCloseWysiwyg）', () => {
  it('非脏 IR / 非 IR：直接变更，不弹确认', async () => {
    const h = harness({ dirtyIr: false });
    expect(gateCloseWysiwyg(h.ctx)).toBe('committed');
    await flush();
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('标签已关闭（关闭守卫已决策）：直接放行', async () => {
    const h = harness({ stillOpen: false });
    gateCloseWysiwyg(h.ctx);
    await flush();
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('取消：状态一次都不变更（commit 不调用），并复位挂起标记', async () => {
    const h = harness();
    const ret = gateCloseWysiwyg(h.ctx);
    expect(ret).toBeUndefined(); // 决策挂起：本次意图无同步结果
    expect(h.pending()).toBe(true);
    await flush();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    expect(h.pending()).toBe(false);
  });

  it('放弃修改：先弃（清脏 + 弃恢复快照）再变更', async () => {
    const h = harness({ confirm: vi.fn(() => Promise.resolve('discard' as const)) });
    gateCloseWysiwyg(h.ctx);
    await flush();
    expect(h.discard).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.discard.mock.invocationCallOrder[0]).toBeLessThan(h.commit.mock.invocationCallOrder[0]);
  });

  it('保存：落盘成功后才变更', async () => {
    const h = harness({
      confirm: vi.fn(() => Promise.resolve('save' as const)),
      stillDirty: () => false,
    });
    gateCloseWysiwyg(h.ctx);
    await flush();
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledTimes(1);
  });

  it('保存失败（仍脏）：留在 IR，不变更', async () => {
    const h = harness({
      confirm: vi.fn(() => Promise.resolve('save' as const)),
      stillDirty: () => true,
    });
    gateCloseWysiwyg(h.ctx);
    await flush();
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('确认已挂起：本次关闭意图丢弃（不重复弹窗、不变更）', async () => {
    const h = harness({ pending: true });
    expect(gateCloseWysiwyg(h.ctx)).toBeUndefined();
    await flush();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('同步关闭路径透传 commit 结果', () => {
    const h = harness({ dirtyIr: false });
    expect(gateCloseWysiwyg(h.ctx)).toBe('committed');
  });
});
