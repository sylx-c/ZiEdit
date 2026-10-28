import type { HeadingItem } from '../markdown-view/headings';

// headings（markdown-it + @lezer/markdown，静态渲染栈的重依赖）随首用动态加载——
// outline 自身保持轻量进入首屏 chunk。
type HeadingsModule = typeof import('../markdown-view/headings');

/** 依赖就绪屏障：小文档路径先过「模块加载 + FC 就绪语义」两道闸再解析——
 *  不依赖「模块恰好已随渲染栈加载」的时序假设（冷启动直接打开大纲侧栏即为该场景）。
 *  FC 收口 1 约定（headings.ts）：异步调用方走 extractHeadingsReady(text)——其内部先等
 *  md.ts 共享 markdown-it 就绪再同步提取，冷启动首解析不再撞未初始化解析器。
 *  加载 Promise 全局单例去重，失败不驻留（下次调用重试）。 */
let headingsModule: Promise<HeadingsModule> | null = null;
const ensureHeadings = (): Promise<HeadingsModule> => {
  if (!headingsModule) {
    headingsModule = import('../markdown-view/headings');
    headingsModule.catch(() => { headingsModule = null; }); // 失败不驻留，下次重试
  }
  return headingsModule;
};

/** Markdown 编辑面读取当前缓冲，大文档解析不得阻塞主线程。 */
export function parseOutlineHeadings(text: string): { result: Promise<HeadingItem[]>; cancel(): void } {
  if (text.length <= 256 * 1024) {
    return {
      result: ensureHeadings().then(m => {
        const ready = (m as HeadingsModule & { extractHeadingsReady?: (t: string) => Promise<HeadingItem[]> }).extractHeadingsReady;
        return ready ? ready(text) : m.extractHeadings(text);
      }),
      cancel() {},
    };
  }
  let cancel = () => {};
  const result = new Promise<HeadingItem[]>((resolve, reject) => {
    const worker = new Worker(new URL('../markdown-view/headings-worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { clearTimeout(timer); worker.terminate(); };
    const timer = setTimeout(() => { finish(); reject(new Error('Markdown outline timed out')); }, 15000);
    cancel = () => { finish(); resolve([]); };
    worker.onmessage = (event: MessageEvent<{ headings: HeadingItem[] }>) => { finish(); resolve(event.data.headings); };
    worker.onerror = () => { finish(); reject(new Error('Markdown outline worker failed')); };
    worker.postMessage({ text, version: 0 });
  });
  return { result, cancel: () => cancel() };
}

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
