// 007 R5 v0.46：仅关闭/退出可请求三键决策；标签/打开/形态/路由切换不得使用。
// shell 实际关闭由 closeTabGuarded 与退出脏清单处理全部编辑缓冲。
// 保留关闭决策纯调度契约，DOM/IPC 经注入便于单测。
/** 三键确认结果：保存 / 放弃修改 / 取消 */
export type LeaveChoice = 'save' | 'discard' | 'cancel';

export interface LeaveCtx<T = void> {
  /** 当前视图是否为「脏的 IR」（非脏 / 非 IR 一律直接放行） */
  dirtyIr: boolean;
  /** 该标签是否仍在标签集中；已关闭说明关闭守卫已决策，直接放行 */
  stillOpen: boolean;
  /** 三键确认进行中：本次关闭意图丢弃（防重复弹窗） */
  pending: boolean;
  /** 弹出三键确认 */
  confirm: () => Promise<LeaveChoice>;
  /** 保存 IR 内容 */
  save: () => Promise<void>;
  /** 保存后是否仍然脏（保存失败 → 留在 IR 由用户处理） */
  stillDirty: () => boolean;
  /** 放弃修改：清脏标 + 弃恢复快照 */
  discard: () => void;
  /** 决策通过后执行关闭 */
  commit: () => T;
  /** 决议为取消时刷新状态栏（可能已被禁用的状态格恢复） */
  onCancel?: () => void;
  /** 置位/复位确认进行中标记 */
  setPending?: (v: boolean) => void;
}

/**
 * 执行一次关闭决策：commit 只在允许时调用一次；不可用于非破坏性切换。
 * 返回 commit 的结果；决策挂起（或取消/保存失败）时返回 undefined——
 * 调用方据此区分「已落状态」与「本次意图未生效」。
 */
export function gateCloseWysiwyg<T>(ctx: LeaveCtx<T>): T | undefined {
  if (!ctx.dirtyIr || !ctx.stillOpen) return ctx.commit();
  if (ctx.pending) return undefined;
  ctx.setPending?.(true);
  void ctx.confirm().then(async (choice: LeaveChoice) => {
    ctx.setPending?.(false);
    if (choice === 'cancel') {
      ctx.onCancel?.();
      return;
    }
    if (choice === 'save') {
      await ctx.save();
      if (ctx.stillDirty()) return;
    } else {
      ctx.discard();
    }
    ctx.commit();
  });
  return undefined;
}
