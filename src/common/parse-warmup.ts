// parse-warmup —— CM6 语法树解析预热（007 规则 22 滚动零长帧口径）
// 背景：@codemirror/language 6.13 的后台解析单片预算硬编码 100ms（Work.Slice，
// 公开接口不可调），且只解析到视口+100KB。大文档首次跳转/滚动到未解析区域时，
// 补解析以 ~100ms 长帧形式落在主线程（v0.18 登记的"IR 滚动 74ms 长任务"同源）。
// 预热在挂载后用 ≤25ms 小片把解析推进到全文，消除后续跳转的补解析长帧。
// 只使用公开 API（forceParsing）；isInputPending 时让出，不与输入抢帧。
import { EditorView } from '@codemirror/view';
import { forceParsing, language } from '@codemirror/language';

/** 小于该体量的文档自带调度已够快，预热无收益 */
const WARMUP_MIN = 256 * 1024;
/** 超过该体量不做全文预热（防御：日志等超大文件不做全量后台解析；对齐 IR 上限 9MiB 留余量） */
const WARMUP_MAX = 10 * 1024 * 1024;
/** 单片预算与推进步长 */
const SLICE_MS = 25;
const STEP_CHARS = 16 * 1024;

/**
 * 挂载后启动预热；返回停止函数（视图销毁时调用）。
 * 无语言（纯文本等）或体量窗口外时为空操作。
 */
export function startParseWarmup(view: EditorView, isAlive: () => boolean): () => void {
  if ((globalThis as { __ZIEDIT_NO_WARMUP__?: boolean }).__ZIEDIT_NO_WARMUP__) return () => {};
  if (view.state.doc.length < WARMUP_MIN || view.state.doc.length > WARMUP_MAX) return () => {};
  if (!view.state.facet(language)) return () => {};
  let cancelled = false;
  let upto = Math.min(view.state.doc.length, view.viewport.to + STEP_CHARS);
  const schedule = (): void => {
    requestAnimationFrame(() => {
      if (cancelled || !isAlive()) return;
      if (typeof requestIdleCallback === 'function') requestIdleCallback(step, { timeout: 200 });
      else setTimeout(step, 32);
    });
  };
  const step = (): void => {
    if (cancelled || !isAlive()) return;
    const scheduling = (navigator as { scheduling?: { isInputPending?: () => boolean } }).scheduling;
    if (scheduling?.isInputPending?.()) {
      schedule();
      return;
    }
    let reached = false;
    try {
      reached = forceParsing(view, upto, SLICE_MS);
    } catch {
      cancelled = true; // 视图已销毁或语言被移除：停止，不再调度
      return;
    }
    if (reached) {
      if (upto >= view.state.doc.length) return; // 全文解析完成
      upto = Math.min(view.state.doc.length, upto + STEP_CHARS);
    }
    schedule();
  };
  schedule();
  return () => {
    cancelled = true;
  };
}
