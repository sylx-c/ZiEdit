// common/scroll-anchor —— 跨形态统一的滚动位置语言：「视口顶对应的源码行」。
// 源码 / 即时渲染 / 渲染预览三种形态的像素高度互不相同，像素 scrollTop 跨形态没有意义
// （修前切形态/切标签回来位置漂移或回顶的根因）。这里统一用源码行（1 起，小数部分 = 块内比例）
// 记录位置；同一形态往返另带 CM6 原生 scrollSnapshot（行锚 + 像素偏移，精确还原含横向位置）。
import { EditorView } from '@codemirror/view';
import type { StateEffect } from '@codemirror/state';
import { userScrollVersion } from './user-scroll';

function scrollerDOMRectTop(view: EditorView): number { return view.scrollDOM.getBoundingClientRect().top; }

/** 位置所属的高度模型：同模型才可用像素级快照还原 */
export type ScrollSurface = 'source' | 'ir' | 'preview';

export interface ScrollAnchor {
  /** 视口顶源码行（1 起，可含小数） */
  line: number;
  surface: ScrollSurface;
  /** CM6 scrollSnapshot：仅在同 surface、同文档还原时使用 */
  snapshot?: StateEffect<unknown>;
  /** 阅读面同块恢复；跨显示面仍使用源码行锚。 */
  blockId?: string;
  offset?: number;
  blockHeight?: number;
}

/** 文档坐标（高度图）→ 滚动坐标的偏移：内容区上方的 padding 等 */
function docOffset(view: EditorView): number {
  return view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop;
}

/** 文档高度 h 处对应的源码行（块级替换件跨多行时按块内比例插值） */
function lineAtHeight(view: EditorView, h: number): number {
  const doc = view.state.doc;
  const block = view.lineBlockAtHeight(Math.max(0, h));
  const first = doc.lineAt(block.from).number;
  const last = doc.lineAt(Math.max(block.from, block.to)).number;
  const frac = block.height > 0 ? Math.min(1, Math.max(0, (h - block.top) / block.height)) : 0;
  return Math.min(doc.lines, first + frac * (last - first + 1));
}

/** 视口顶对应的源码行 */
export function cmTopLine(view: EditorView): number {
  return lineAtHeight(view, view.scrollDOM.scrollTop - docOffset(view));
}

/** 视口覆盖的源码行区间（缩略图视口框按行比例绘制，与条纹同一坐标） */
export function cmVisibleLines(view: EditorView): { first: number; last: number } {
  const top = view.scrollDOM.scrollTop - docOffset(view);
  return { first: lineAtHeight(view, top), last: lineAtHeight(view, top + view.scrollDOM.clientHeight) };
}

/** 取不到（视图正处于 CM6 更新阶段、禁止读布局）时返回 undefined，调用方退回像素兜底 */
export function cmCaptureAnchor(view: EditorView, surface: ScrollSurface): ScrollAnchor | undefined {
  try {
    return { line: cmTopLine(view), surface, snapshot: view.scrollSnapshot() };
  } catch {
    return undefined;
  }
}

/** 还原效果：同 surface 用快照（精确到像素与横向位置），跨 surface 把锚行滚到视口顶。
 *  效果交给 CM6 在测量完成后执行，挂载时块高度尚是估计值也不会落错位置。 */
export function cmRestoreEffect(view: EditorView, anchor: ScrollAnchor, surface: ScrollSurface): StateEffect<unknown> {
  if (anchor.snapshot && anchor.surface === surface) return anchor.snapshot;
  const doc = view.state.doc;
  const line = doc.line(Math.min(doc.lines, Math.max(1, Math.floor(anchor.line))));
  return EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 0 });
}

/** 将源码行及块内比例换算到 CM 当前高度图。调用方须在布局读取阶段使用。 */
function cmLineTop(view: EditorView, line: number, align: 'center' | 'start'): number {
  const doc = view.state.doc;
  const target = doc.line(Math.min(doc.lines, Math.max(1, Math.floor(line))));
  const block = view.lineBlockAt(target.from);
  const first = doc.lineAt(block.from).number, last = doc.lineAt(block.to).number;
  const fraction = Math.min(1, Math.max(0, (line - first) / (last - first + 1)));
  const top = block.top + docOffset(view) + fraction * block.height;
  return Math.max(0, align === 'center' ? top + block.height / 2 - view.scrollDOM.clientHeight / 2 : top);
}

export interface CmRestoreOptions {
  /** 渲染面在目标块进入高度图后才交付块内位置。 */
  ready?: (view: EditorView, line: number) => boolean;
}
interface PendingRestore { cancel: () => void; notify: () => void }
const pendingRestores = new WeakMap<EditorView, PendingRestore>();
/** 新导航或视图销毁时作废尚未交付的跨形态恢复。 */
export function cancelCmRestore(view: EditorView): void { pendingRestores.get(view)?.cancel(); }
/** 渲染面交付新布局时唤醒等待目标块的恢复；没有待恢复位置时不做任何工作。 */
export function notifyCmRestoreLayout(view: EditorView): void { pendingRestores.get(view)?.notify(); }

/** 先由 CM 定位源码行，再在高度图稳定后补足多行替换块内的比例。 */
export function cmRestoreAnchor(view: EditorView, anchor: ScrollAnchor, surface: ScrollSurface, options?: CmRestoreOptions): void {
  cancelCmRestore(view);
  view.dispatch({ effects: cmRestoreEffect(view, anchor, surface) });
  if (anchor.surface === surface && anchor.snapshot) return;
  const scroller = view.scrollDOM, doc = view.state.doc;
  const inputVersion = userScrollVersion(scroller);
  let active = true, frame = 0, layoutVersion = 0;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    if (!active) return;
    if ((globalThis as { __ANC__?: boolean }).__ANC__) {
      // eslint-disable-next-line no-console
      console.log('[anchor:cancel]', new Error('stack').stack?.split('\n').slice(1, 4).join(' | '));
    }
    active = false; cancelAnimationFrame(frame); clearTimeout(quietTimer);
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) scroller.removeEventListener(event, cancel);
    if (pendingRestores.get(view)?.cancel === cancel) pendingRestores.delete(view);
  };
  // REQ-014 P6：selection 不参与存活判定——装饰交付期拉长了恢复存活期，切形态后的光标
  // 恢复事务会改 selection 而不改行几何，旧守卫会把仍在等待的恢复静默取消（死锁在钳制位）。
  // 文档变更/用户滚动/断连仍即时取消。
  const current = (): boolean => active && view.dom.isConnected && scroller.clientHeight > 0 && view.state.doc === doc
    && userScrollVersion(scroller) === inputVersion;
  // REQ-014 P6：挂载态装饰（空行折叠/表格件）与 CM6 卸载区缺省行高估计不一致——视口裁剪后的
  // 再估计可能晚于首次写入到达。写入后保留注册：晚到的布局通知（notifyCmRestoreLayout）触发
  // 一次安静复核，无漂移即取消（安静期零工作），有漂移写回并继续（≤5 轮 + 3s 无通知终止）。
  let rechecks = 0;
  let nullStreak = 0;
  const rekick = (): void => {
    // REQ-014 P6：初始滚动被 DOM 高度钳制或切片窗未达目标时 ready 永假。null 连续即重派
    // 行级 scrollIntoView（CM 原生按高度图解析，切片落位后可落准），最多补踢 3 次。
    if (nullStreak >= 1 && rechecks < 6) {
      rechecks += 2;
      nullStreak = 0;
      view.dispatch({ effects: cmRestoreEffect(view, anchor, surface) });
    }
  };
  const measure = (): void => {
    const version = layoutVersion;
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
      frame = 0;
      if (!current()) { cancel(); return; }
      view.requestMeasure({
        read: v => {
          if (!current()) {
            if ((globalThis as { __ANC__?: boolean }).__ANC__) {
              // eslint-disable-next-line no-console
              console.log('[anchor:read-cancel]', 'active=', active, 'connected=', view.dom.isConnected,
                'clientH=', scroller.clientHeight, 'docSame=', view.state.doc === doc,
                'usv=', userScrollVersion(scroller), 'usv0=', inputVersion);
            }
            cancel(); return null;
          }
          try {
            if (options?.ready && !options.ready(v, anchor.line)) return null;
            return cmLineTop(v, anchor.line, 'start');
          } catch { cancel(); return null; }
        },
        write: top => {
          // 新布局或新输入使这次测量过期；下次有效布局通知会重新调度。
          if (!current()) { cancel(); return; }
          if ((globalThis as { __ANC__?: boolean }).__ANC__) {
            // eslint-disable-next-line no-console
            console.log('[anchor]', 'top=', top, 'scrollTop=', scroller.scrollTop, 'docTop=', view.documentTop,
              'rectTop=', scrollerDOMRectTop(view), 'line=', anchor.line, 'null=', top === null, 'ver=', version === layoutVersion);
          }
          if (top === null || version !== layoutVersion) {
            // REQ-014 P6：null（ready 未就绪）路径同样自排程重测——切片窗未达目标时无布局
            // 通知可等，不排程即死锁在初始钳制位（实测漂移 372 行）。有界：≤6 轮。
            if (top === null) {
              nullStreak++; rekick();
              if (++rechecks < 6) {
                clearTimeout(quietTimer);
                quietTimer = setTimeout(() => { quietTimer = undefined; if (active) measure(); }, 400);
              } else cancel();
            }
            return;
          }
          nullStreak = 0;
          const drifted = Math.abs(scroller.scrollTop - top) > .5;
          if (drifted) scroller.scrollTop = top;
          // REQ-014 P6：写入后追加分阶段终检——装饰交付期的 map/DOM 短暂失同步会让早期
          // 写入落在错位（漂移 372 行实测）；静定后按稳定高度图再校，无漂移即终止。
          if (!drifted) cancel();
          else if (++rechecks >= 6) cancel();
          else {
            clearTimeout(quietTimer);
            quietTimer = setTimeout(() => { quietTimer = undefined; if (active) measure(); }, 400);
          }
        },
      });
    }); });
  };
  const schedule = (): void => {
    if (!active) return;
    layoutVersion++;
    cancelAnimationFrame(frame); frame = 0;
    clearTimeout(quietTimer);
    if (options?.ready) {
      // 初始 scrollIntoView 先显示目标。待连续布局更新停下，再检查版本、
      // 目标装饰和高度图并恢复比例；任何新布局或用户输入均使旧任务失效。
      quietTimer = setTimeout(() => { quietTimer = undefined; if (active) measure(); }, 250);
    } else measure();
  };
  pendingRestores.set(view, { cancel, notify: schedule });
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) scroller.addEventListener(event, cancel, { passive: true });
  schedule();
}

/** 只滚动、不动光标与横向位置：把源码行滚到视口中央（缩略图点击/拖动用）。 */
export function cmScrollToLine(view: EditorView, line: number, align: 'center' | 'start' = 'center'): void {
  cancelCmRestore(view);
  view.scrollDOM.scrollTop = cmLineTop(view, line, align);
}
