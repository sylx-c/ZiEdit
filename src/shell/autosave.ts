// autosave —— 自动保存与恢复快照调度（ADR 012 v2；H-5 T1/T10 自 app.ts 拆出）
// 目标模式（设置项 autoSaveTarget）：
// - 'sidecar'（出厂）：自动保存只写恢复快照旁路文件（recovery/），原文件仅在
// Ctrl+S / 切换标签三键确认 / 关闭确认时写——外部工具（git diff、构建 watcher）不会看到半成品
// - 'file'：自动保存直写原文件（v1 旧行为，显式选项）
import type { Settings } from '../common/ipc';

/** 关标签/退出共用：save 后必须等待既有 saveNow/text_save，false（含取消另存）中止关闭。
 * saveSucceeded 仅在保存完成后传入；不绕过只读限制，也不影响托盘隐藏或切标签确认。 */
export function closeActionFor(
  dirty: boolean, closeAutoSave = false, saveSucceeded?: boolean,
): 'close' | 'confirm' | 'save' | 'abort' {
  if (saveSucceeded === false) return 'abort';
  if (!dirty || saveSucceeded === true) return 'close';
  return closeAutoSave ? 'save' : 'confirm';
}

/** 调度上下文（app 闭包注入；无 DOM 依赖，便于单测） */
export interface AutosaveCtx {
  getSettings(): Pick<Settings, 'autoSaveSec' | 'autoSaveTarget'>;
  /** 活动标签路径信息（伪标签/不可编辑返回 null，不参与调度） */
  activeInfo(): { path: string; draft: boolean } | null;
  /** 当前视图是否脏（EditView.dirty || IR dirty） */
  isDirty(): boolean;
  /** 当前视图全文（快照内容）；允许分段取值，把大文档复制拆到多个事件循环。 */
  content(): string | Promise<string>;
  /** 内容版本；快照让出主线程后用它拒绝过期内容覆盖较新的编辑。 */
  contentRevision?(): number;
  /** 当前路径保存代际；保存成功后递增，拒绝保存前发起的快照。 */
  saveEpoch?(): number;
  /** 当前内容体量的廉价估计（字符数，无序列化；P2：大文档快照降频的判据，缺省按小文档） */
  sizeHint?(): number;
  /** 写恢复快照（内存 pending + 盘 recovery/；mtime/size 基线由实现方取） */
  snapshot(path: string, content: string, draft: boolean): void;
  /** 显式落盘（'file' 模式的自动保存；成功返回 true） */
  saveNow(): Promise<boolean>;
  onFileSaved(): void;
  onSaveFailed(): void;
  /** R5 IR 三键确认挂起中（挂起期间暂停，防止架空「放弃修改」） */
  isSwitchPending(): boolean;
}

/** 自动保存决策（纯函数，T6 单测口径）：
 *  'skip'=不脏或关闭；'snapshot'=sidecar 旁路；'file'=直写原文件 */
export function autosaveAction(settings: Pick<Settings, 'autoSaveSec' | 'autoSaveTarget'>, dirty: boolean): 'skip' | 'snapshot' | 'file' {
  if (!settings.autoSaveSec) return 'skip';
  if (!dirty) return 'skip';
  return settings.autoSaveTarget === 'file' ? 'file' : 'snapshot';
}

/**
 * 启动两个调度定时器（1.5s 心跳）：
 * 1. 自动保存：脏满 autoSaveSec 秒后按 autosaveAction 执行（sidecar=快照静默、file=落盘+提示；
 *    保存失败下次心跳重试，连续三次失败提示并暂停至转净）
 * 2. 恢复快照：脏持续时按 min(autoSaveSec,10)s 节拍写盘（sidecar 模式的实际承载；file 模式兜底）
 * 返回停止函数（单测/卸载用）。
 */
export function startAutosaveTimers(
  ctx: AutosaveCtx,
  timers: { setInterval(fn: () => void, ms: number): unknown; clearInterval(id: unknown): void } = {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: id => clearInterval(id as ReturnType<typeof setInterval>),
  }
): () => void {
  let dirtySince = 0;
  let snapSince = 0;
  const failures = new Map<string, number>();
  let saveInFlight = false;
  let snapshotPath: string | null = null;
  let snapshotInFlight = false;
  const id1 = timers.setInterval(() => {
    const st = ctx.getSettings();
    const info = ctx.activeInfo();
    const dirty = !!info && ctx.isDirty();
    if (info && !dirty) failures.delete(info.path);
    const failed = info ? failures.get(info.path) ?? 0 : 0;
    const pending = dirty && !ctx.isSwitchPending() && failed < 3;
    const action = autosaveAction(st, pending);
    // sidecar 统一由下方快照时钟调度，避免双时钟重复写且绕过大文档30秒间隔。
    if (action === 'skip' || action === 'snapshot' || !info) {
      dirtySince = 0;
      return;
    }
    if (!dirtySince) dirtySince = Date.now();
    if (!saveInFlight && (failed > 0 || Date.now() - dirtySince >= (st.autoSaveSec ?? 15) * 1000)) {
      dirtySince = 0;
      const path = info.path;
      if (action === 'file') {
        saveInFlight = true;
        const finish = (ok: boolean): void => {
          saveInFlight = false;
          if (ok) {
            failures.delete(path);
            ctx.onFileSaved();
          } else {
            const count = (failures.get(path) ?? 0) + 1;
            failures.set(path, count);
            if (count === 3) ctx.onSaveFailed();
          }
        };
        try { void ctx.saveNow().then(finish, () => finish(false)); }
        catch { finish(false); }
      }
    }
  }, 1500);
  const id2 = timers.setInterval(() => {
    const st = ctx.getSettings();
    // F9（2026-10 审计）：autoSaveSec=0 即「自动保存关闭」——sidecar 模式下快照时钟就是自动保存
    // 的载体，一并停写（修前 min(0,10)||10 会把间隔兜成 10s 继续落盘）。
    if (!st.autoSaveSec) {
      snapSince = 0;
      snapshotPath = null;
      return;
    }
    const info = ctx.activeInfo();
    const dirty = !!info && ctx.isDirty();
    if (!dirty || !info || ctx.isSwitchPending()) {
      snapSince = 0;
      snapshotPath = null;
      return;
    }
    if (snapshotPath !== info.path) {
      snapshotPath = info.path;
      snapSince = 0;
    }
    if (!snapSince) snapSince = Date.now();
    // P2（007 规则 22）：快照要 ctx.content() 全文序列化——IR 大文档（>1MB）每 10s 一次
    // 会叠加可感迟滞，节拍升到 max(autoSaveSec,30)s（崩丢窗口换流畅，ADR 012 权衡记录）。
    // 体量探测走 sizeHint（无序列化的廉价估计）——决不在 1.5s 心跳里调 content()
    const big = ctx.sizeHint ? ctx.sizeHint() > 1_048_576 : false;
    let sec = Math.min(st.autoSaveSec ?? 15, 10) || 10;
    if (big) sec = Math.max(st.autoSaveSec ?? 15, 30);
    if (Date.now() - snapSince >= sec * 1000 && !snapshotInFlight) {
      snapSince = Date.now();
      const path = info.path;
      const revision = ctx.contentRevision?.();
      const epoch = ctx.saveEpoch?.();
      snapshotInFlight = true;
      const finish = (content: string): void => {
        const current = ctx.activeInfo();
        const stillCurrent = !!current && current.path === path && ctx.isDirty()
          && ctx.saveEpoch?.() === epoch
          && (revision === undefined || ctx.contentRevision?.() === revision);
        if (stillCurrent) ctx.snapshot(path, content, info.draft);
        else snapSince = 0;
        snapshotInFlight = false;
      };
      try {
        const value = ctx.content();
        if (typeof value === 'string') {
          finish(value);
        } else {
          void value.then(finish).catch(() => {
            // 视图销毁或读取失败时保留脏状态，下一次节拍重试。
            snapSince = 0;
            snapshotInFlight = false;
          });
        }
      } catch {
        snapSince = 0;
        snapshotInFlight = false;
      }
    }
  }, 1500);
  return () => {
    timers.clearInterval(id1);
    timers.clearInterval(id2);
  };
}
