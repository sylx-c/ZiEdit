// parse-warmup —— CM6 语法树解析预热（007 规则 22 滚动零长帧口径）
// 背景：@codemirror/language 6.13 的后台解析单片预算硬编码 100ms（Work.Slice，
// 公开接口不可调），且只解析到视口+100KB。大文档首次跳转/滚动到未解析区域时，
// 补解析以 ~100ms 长帧形式落在主线程（v0.18 登记的"IR 滚动 74ms 长任务"同源）。
// 预热经应用渲染队列，用 ≤8ms 预算推进全文；单次解析 advance 仍可能不可抢占。
// 只使用公开 API（ensureSyntaxTree/forceParsing）；isInputPending 时让出。
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, forceParsing, language, syntaxTreeAvailable } from '@codemirror/language';
import { requestIrFrame, cancelIrFrame, remainingRenderBudget } from './render-queue';
import { hasPendingInput } from './input-pending';
import { userScrolledRecently } from './user-scroll';

/** 小于该体量的文档自带调度已够快，预热无收益 */
const WARMUP_MIN = 64 * 1024;
/** 超过该体量不做全文预热（防御：日志等超大文件不做全量后台解析；对齐 IR 上限 9MiB 留余量） */
const WARMUP_MAX = 10 * 1024 * 1024;
/** 单片预算 */
const SLICE_MS = 8;

/**
 * 挂载后启动预热；返回停止函数（视图销毁时调用）。
 * 无语言（纯文本等）或体量窗口外时为空操作。
 */
export function startParseWarmup(view: EditorView, isAlive: () => boolean): () => void {
  if (view.state.doc.length < WARMUP_MIN || view.state.doc.length > WARMUP_MAX) return () => {};
  if (!view.state.facet(language)) return () => {};
  let cancelled = false;
  let frame = 0;
  let primed = false;
  const schedule = (): void => {
    frame = requestIrFrame(step, true);
  };
  const step = (): void => {
    frame = 0;
    if (cancelled || !isAlive()) return;
    if (syntaxTreeAvailable(view.state, view.state.doc.length)) return;
    const ahead = Math.min(view.state.doc.length, view.viewport.to + 100_000);
    const needsAhead = !syntaxTreeAvailable(view.state, ahead);
    // 首段先覆盖 CM 的视口前瞻，避免默认 idle 解析接管长片；之后连续
    // 滚轮之间只补齐变化后的视口前瞻。块解析会扩大 viewport.to，不能
    // 认为首次前瞻就绪后一直安全，否则默认解析器会再次接管 100ms 长片。
    if (hasPendingInput() || (primed && !needsAhead && userScrolledRecently(view.scrollDOM, 100))) {
      schedule();
      return;
    }
    // 先发布视口及其后 100KB，覆盖 CM 默认后台解析的前瞻范围。
    // 仅在全文完成时发布，会让默认 idle 解析器趁预热未完成再占用一个长片。
    // 前瞻扩展时才发布新的范围；其余保留在途解析至全文完成。
    const target = !primed || needsAhead ? ahead : view.state.doc.length;
    let reached = false;
    try {
      reached = !!ensureSyntaxTree(view.state, target, Math.min(SLICE_MS, remainingRenderBudget()));
      if (reached) {
        forceParsing(view, target, 0);
        primed = true;
      }
    } catch {
      cancelled = true; // 视图已销毁或语言被移除：停止，不再调度
      return;
    }
    if (reached && target === view.state.doc.length) return;
    schedule();
  };
  schedule();
  return () => {
    cancelled = true;
    cancelIrFrame(frame);
  };
}
