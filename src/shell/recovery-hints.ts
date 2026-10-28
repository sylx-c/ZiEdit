// 崩溃恢复快照的提示判决（P3-25 灾备可观测；纯函数，002 规则 29 v2.4）。
// 快照心跳按自动保存节拍触发（默认 15s），超限提示以 60s 窗口去重，
// 待快照恢复成功（文件缩小/内容不再超限）后复位，再次超限可再次提示；淘汰是低频事件，如实提示。
export interface SnapHintState {
  /** 已提示过「超限跳过」——心跳式快照不得反复刷屏 */
  skipNotified: boolean;
  lastSkipAt?: number;
}

export const INITIAL_SNAP_HINTS: SnapHintState = { skipNotified: false };

/** recovery_snapshot 的返回形状（与 Rust SnapshotOutcome 对齐；此处宽松以容忍旧后端） */
export interface SnapOutcome {
  skipped: boolean;
  evicted: number;
}

export interface SnapHint {
  /** 提示文案键；null = 本次不提示 */
  key: 'msg.snapSkip' | 'msg.snapEvict' | null;
  /** msg.snapEvict 的插值参数（淘汰份数） */
  arg?: number;
  /** 下次调用应持有的状态（纯函数：不原地改传入对象） */
  state: SnapHintState;
}

export function snapshotHint(out: SnapOutcome, st: SnapHintState, now = Date.now()): SnapHint {
  if (out.skipped) {
    return st.skipNotified && (st.lastSkipAt === undefined || now - st.lastSkipAt < 60_000)
      ? { key: null, state: st }
      : { key: 'msg.snapSkip', state: { skipNotified: true, lastSkipAt: now } };
  }
  const state: SnapHintState = { skipNotified: false }; // 写入成功：超限提示复位
  return out.evicted > 0
    ? { key: 'msg.snapEvict', arg: out.evicted, state }
    : { key: null, state };
}
