// common/user-scroll —— 区分「用户滚动」与「内容高度变化引起的滚动」。
// CM6 的滚动锚在块高度变化后会自己改 scrollTop，浏览器照样派发 scroll 事件；即时渲染若把这类
// scroll 当作用户在滚，就会进入滚动占位模式 → 换占位改变高度 → 锚点再补偿 → 再派发 scroll……
// 停手后视口来回弹（2026-10-30 真机门 gate-ir-settle 实测每 ~340ms 一轮 ±25~180px 往复）。
// 用户意图只来自输入事件，或由程序化滚动的发起方（缩略图、自绘滚动条）显式登记。
const marks = new WeakMap<Element, number>();
const versions = new WeakMap<Element, number>();

/** 登记一次用户发起的滚动（缩略图点击/拖动、自绘滚动条在写 scrollTop 前调用） */
export function markUserScroll(el: Element): void {
  marks.set(el, performance.now());
  versions.set(el, (versions.get(el) ?? 0) + 1);
}

/** 区分一次恢复之后的新导航与恢复之前已有的滚动记录。 */
export function userScrollVersion(el: Element): number { return versions.get(el) ?? 0; }

/** 新布局或停滚结算接管后，旧输入不能把程序性高度校正再解释为用户滚动。 */
export function clearUserScroll(el: Element): void { marks.delete(el); }

/** 最近 ms 内是否有用户滚动意图 */
export function userScrolledRecently(el: Element, ms = 300): boolean {
  return performance.now() - (marks.get(el) ?? -Infinity) < ms;
}

const NAV_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar']);

/** 监听滚动容器上的输入事件（滚轮、触摸、导航键、指针按下——含原生滚动条拖动），返回卸载函数 */
export function trackUserScroll(el: HTMLElement): () => void {
  const mark = (): void => markUserScroll(el);
  const key = (event: KeyboardEvent): void => { if (NAV_KEYS.has(event.key)) mark(); };
  el.addEventListener('wheel', mark, { passive: true });
  el.addEventListener('touchmove', mark, { passive: true });
  el.addEventListener('pointerdown', mark, { passive: true });
  el.addEventListener('keydown', key, { passive: true });
  return () => {
    el.removeEventListener('wheel', mark);
    el.removeEventListener('touchmove', mark);
    el.removeEventListener('pointerdown', mark);
    el.removeEventListener('keydown', key);
  };
}
