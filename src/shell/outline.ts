export interface OutlineRow {
  line: number;
  name: string;
  level?: number;
  showLine?: boolean;
}

/** 大纲只挂载可见行，标题数量不再决定 DOM 数量。 */
export function mountOutlineRows(host: HTMLElement, rows: OutlineRow[], onOpen: (index: number) => void) {
  const rowHeight = 24;
  // 侧栏实际由外层 body 滚动，内容宿主的高度包含全部标题。
  const scroller = host.closest<HTMLElement>('.sidebar-body') ?? host;
  const spacer = document.createElement('div');
  spacer.style.cssText = `height:${rows.length * rowHeight}px;position:relative`;
  const viewport = document.createElement('div');
  viewport.style.cssText = 'position:absolute;left:0;right:0;top:0';
  spacer.append(viewport);
  host.replaceChildren(spacer);
  let current = -1;
  let start = -1, end = -1;
  const paint = () => {
    const from = Math.max(0, Math.floor(scroller.scrollTop / rowHeight) - 6);
    const to = Math.min(rows.length, from + Math.ceil((scroller.clientHeight || 640) / rowHeight) + 12);
    if (from === start && to === end) {
      for (const child of viewport.children) child.classList.toggle('cur', Number((child as HTMLElement).dataset.index) === current);
      return;
    }
    start = from; end = to;
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) {
      const row = rows[i]!;
      const el = document.createElement('div');
      el.className = 'sym-item' + (i === current ? ' cur' : '');
      el.style.cssText = `height:${rowHeight}px;box-sizing:border-box`;
      if (row.level) el.style.paddingLeft = `${(row.level - 1) * 12 + 8}px`;
      el.dataset.line = String(row.line);
      el.dataset.index = String(i);
      if (row.showLine) {
        const line = document.createElement('span'); line.className = 'sym-ln'; line.textContent = String(row.line); el.append(line);
      }
      const name = document.createElement('span'); name.className = 'sym-name'; name.textContent = row.name;
      el.append(name); el.title = row.name;
      el.addEventListener('click', () => onOpen(i));
      frag.append(el);
    }
    viewport.style.transform = `translateY(${from * rowHeight}px)`;
    viewport.replaceChildren(frag);
  };
  scroller.addEventListener('scroll', paint, { passive: true });
  const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(paint) : null;
  resize?.observe(scroller);
  paint();
  return {
    setCurrent(line: number) {
      let lo = 0, hi = rows.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid]!.line <= line) lo = mid + 1; else hi = mid; }
      const next = lo - 1;
      if (next !== current) { current = next; paint(); }
    },
    dispose() { scroller.removeEventListener('scroll', paint); resize?.disconnect(); },
  };
}
