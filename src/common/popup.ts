// popup —— 弹层定位单一实现（P2，001/007：按锚点自动上/下翻转 + 双侧防越界）。
// 修前两套口径各修一半：menu() 只防底部越界（顶部锚点的下拉上沿被裁也不翻转——工具栏
// 「标题 ▾」只显示 H3/H4 的根因）；popupAbove 恒 bottom 锚定向上生长（为底部状态栏设计，
// 用在顶部工具栏锚点上整菜单伸出视口顶端）。调用方在菜单 append 后调用本函数定位。
// 纯 DOM 度量，无 IPC 依赖。

/** 按锚点定位弹层：下方空间够（或不小于上方）→ 向下弹并钳底；否则向上弹并钳顶；
 *  水平双侧钳制（左不越 4px，右不越视口-4px）。gap 为菜单与锚点的间距（px）。 */
export function placePopup(anchor: HTMLElement, m: HTMLElement, gap = 2): void {
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  m.style.top = '';
  m.style.bottom = '';
  const roomBelow = vh - r.bottom;
  const roomAbove = r.top;
  let top: number;
  if (roomBelow >= mh || roomBelow >= roomAbove) {
    top = Math.min(r.bottom + gap, Math.max(4, vh - mh - 4));
  } else {
    top = Math.max(4, r.top - mh - gap);
  }
  m.style.top = `${top}px`;
  m.style.left = `${Math.min(Math.max(4, r.left), Math.max(4, vw - mw - 4))}px`;
}

/** 子菜单优先向右展开，空间不足时向左；靠底时上移，超高菜单可滚动。 */
export function placeSubmenu(anchor: HTMLElement, m: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  m.style.position = 'fixed';
  m.style.maxHeight = `${Math.max(0, window.innerHeight - 8)}px`;
  m.style.overflowY = 'auto';
  const width = m.offsetWidth;
  const height = m.offsetHeight;
  const left = r.right - 4 + width <= window.innerWidth - 4 ? r.right - 4 : r.left - width + 4;
  m.style.left = `${Math.max(4, Math.min(left, window.innerWidth - width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(r.top - 5, window.innerHeight - height - 4))}px`;
}
