import type { ScrollAnchor } from '../common/scroll-anchor';
import type { OverviewSample, ScrollLayoutSnapshot, ScrollSurfaceAdapter } from '../common/scroll-surface';
import type { MarkdownBlock } from './document-model';
import { markUserScroll } from '../common/user-scroll';

interface ReadingBlock { block: MarkdownBlock; element: HTMLElement }
const surfaces = new WeakMap<HTMLElement, ReadingSurface>();
export const readingSurface = (host: HTMLElement): ReadingSurface | undefined => surfaces.get(host);

/** 阅读正文唯一的位置与高度适配器。源码序和显示序独立，脚注可位于文末。 */
export class ReadingSurface implements ScrollSurfaceAdapter {
  private blocks: ReadingBlock[] = [];
  private navigation: ReadingBlock[] = [];
  private nested = new Map<HTMLElement, { parent: HTMLElement; relative: number }>();
  private source: ReadingBlock[] = [];
  private byId = new Map<string, ReadingBlock>();
  private version = 0;
  private lines = 1;
  private anchor: ScrollAnchor | null = null;
  private pendingAnchor: { anchor: ScrollAnchor; element: HTMLElement } | null = null;
  /** capture() 同帧记忆（见 capture 注释）；滚动或布局版本变化即失效。 */
  private captureCache: { top: number; version: number; anchor: ScrollAnchor } | null = null;
  private restoredElement: HTMLElement | null = null;
  private visual: { element: Element; range?: Range; top: number } | null = null;
  private visualScrollTop = 0;
  private frame = 0;
  private dead = false;
  private observer?: ResizeObserver;
  private assetObserver?: MutationObserver;
  private assetFrame = 0;
  private assets = new Map<HTMLImageElement, number>();
  private observed = new Set<HTMLElement>();
  private texts = new WeakMap<HTMLElement, { text: string; kind: string }>();
  private geometry = new Map<HTMLElement, { top: number; height: number }>();
  private heights = new Map<HTMLElement, number>();
  private pages = new Map<HTMLElement, number>();
  private pinnedPages = new Set<HTMLElement>();
  private entries = new WeakMap<HTMLElement, ReadingBlock>();
  private indices = new WeakMap<HTMLElement, number>();
  private origin = 0;
  private input = 0;
  private pointer = false;
  private programTop: number | undefined;
  private rootSize = { width: -1, height: -1 };
  constructor(readonly element: HTMLElement, readonly root: HTMLElement) {
    surfaces.set(element, this);
    // 原生锚定在图片固有尺寸参与布局时、绘制前生效；禁用它会先闪移一帧，
    // 等 load/RO 通知后才补偿。下面的文字锚只修正原生锚定尚未处理的差值。
    element.style.overflowAnchor = 'auto';
    element.addEventListener('scroll', this.scrolled, { passive: true });
    for (const event of ['wheel', 'touchstart', 'keydown']) element.addEventListener(event, this.userInput, { passive: true });
    element.addEventListener('pointerdown', this.pointerDown);
    document.addEventListener('pointerup', this.pointerUp);
    root.addEventListener('load', this.assetLoaded, true);
    root.addEventListener('error', this.assetLoaded, true);
    // 固有尺寸可在 load/RO 交付前生效。只在当前正文有待加载图片时，
    // 由同一锚管理器在绘制前检查；完成两帧后停止，不为普通正文常驻轮询。
    this.assetObserver = new MutationObserver(records => {
      if (this.dead) return;
      for (const record of records) {
        if (record.target instanceof HTMLImageElement) this.watchAsset(record.target);
        for (const node of record.addedNodes) if (node instanceof Element) {
          if (node instanceof HTMLImageElement) this.watchAsset(node);
          else for (const image of node.querySelectorAll('img')) this.watchAsset(image);
        }
      }
    });
    this.assetObserver.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'sizes', 'width', 'height'] });
    for (const image of root.querySelectorAll('img')) this.watchAsset(image);
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(entries => {
        let changed = false, changedFrom = this.blocks.length;
        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          this.texts.delete(element);
          const box = this.geometry.get(element);
          const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          if (element === root) {
            const width = entry.contentRect.width;
            changed ||= width !== this.rootSize.width || height !== this.rootSize.height;
            if (width !== this.rootSize.width) changedFrom = 0;
            this.rootSize = { width, height };
          } else if (this.pages.has(element)) {
            if (height > 0 && height !== this.pages.get(element)) { this.pages.set(element, height); changed = true; changedFrom = Math.min(changedFrom, this.indices.get(element) ?? 0); }
          } else if (box && (height > 0 || !box.height) && height !== this.heights.get(element)) {
            this.heights.set(element, height); changed = true; changedFrom = Math.min(changedFrom, this.indices.get(element) ?? 0);
          }
        }
        if (!changed || !this.element.clientHeight && !this.element.isConnected) return;
        this.measureNested(new Set(entries.map(entry => entry.target as HTMLElement)));
        if (changedFrom < this.blocks.length) this.reindex(changedFrom);
        this.layoutChanged();
      });
      this.observer.observe(root);
    }
  }
  get inputVersion(): number { return this.input; }
  private userInput = (event?: Event): void => {
    if (event) markUserScroll(this.element);
    this.input++; this.anchor = null; this.visual = null; this.pendingAnchor = null; this.restoredElement = null; this.programTop = undefined;
    this.element.dispatchEvent(new Event('md-user-input'));
  };
  private writeScroll(top: number): void {
    this.element.scrollTop = top;
    this.programTop = this.element.scrollTop;
    this.visualScrollTop = this.programTop;
  }
  private pointerDown = (event: Event): void => { this.pointer = true; this.userInput(event); };
  private pointerUp = (): void => { this.pointer = false; this.scrolled(); };
  private scrolled = (): void => {
    if (this.frame || this.dead) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.dead) return;
      // 上一轮锚定的 scroll 回声可能晚于下一次图片/字体布局。
      // 此时重记基线会把尚未补偿的位移当成用户的新阅读位置。
      if (this.programTop === undefined || Math.abs(this.element.scrollTop - this.programTop) > .5) {
        this.programTop = undefined;
        // 自然滚动也须固定当前组与邻组，再读文字锚。否则反向滚动恰逢异步公式
        // 换件时，WebView2 的可访问性遍历可能与 auto 子树的跳过/展开交错。
        const current = this.atY(this.element.scrollTop);
        if (current) this.activate(current.element);
        this.rememberAnchor();
      }
      const viewport = this.element.getBoundingClientRect(), margin = this.element.clientHeight * 2;
      for (const page of this.pinnedPages) {
        const box = page.getBoundingClientRect();
        if (!page.isConnected || box.bottom < viewport.top - margin || box.top > viewport.bottom + margin) {
          page.style.removeProperty('content-visibility'); this.pinnedPages.delete(page);
        }
      }
    });
  };
  private rememberAnchor(): void {
    if (this.pendingAnchor) return;
    this.anchor = this.capture(); this.visual = null;
    this.visualScrollTop = this.element.scrollTop;
    const column = this.root.getBoundingClientRect(), viewport = this.element.getBoundingClientRect();
    if (this.restoredElement?.isConnected) {
      const rect = this.restoredElement.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom >= viewport.top && rect.top <= viewport.bottom) {
        // 恢复目标可能位于标题上边距内；命中测试会选到前一块的图片/文字。
        // 后续异步高度交付仍锚定已恢复的块，不能悄悄改换阅读目标。
        this.visual = { element: this.restoredElement, top: rect.top }; return;
      }
      this.restoredElement = null;
    }
    const x = Math.max(viewport.left+1, Math.min(viewport.right-1, column.left+Math.min(70,column.width/2)));
    const y = viewport.top + Math.min(24, this.element.clientHeight/2);
    const caret = (document as Document & { caretRangeFromPoint?: (x:number,y:number)=>Range|null }).caretRangeFromPoint?.(x,y);
    if (caret && caret.startContainer.nodeType === Node.TEXT_NODE && this.root.contains(caret.startContainer) && caret.getClientRects().length) {
      this.visual = { element:caret.startContainer.parentElement!, range:caret, top:caret.getBoundingClientRect().top };
    } else {
      const hit = document.elementFromPoint?.(x,y)?.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,.md-code-chunk,pre');
      const target = hit ?? this.atY(this.element.scrollTop + y - viewport.top)?.element;
      if (target && this.root.contains(target) && (hit || target.textContent?.trim())) {
        // 命中段间空隙时 caret 可能落在容器而非文字。保留邻近正文的首字符，
        // 字号变化会改变段落内边距，不能只用外框作为阅读内容的基线。
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode();
        const range = text ? document.createRange() : undefined;
        if (range && text) { range.setStart(text, 0); range.setEnd(text, Math.min(1, text.textContent?.length ?? 0)); }
        const measured = range && typeof range.getClientRects === 'function' && range.getClientRects().length ? range : undefined;
        this.visual = { element:target, range:measured, top:(measured ?? target).getBoundingClientRect().top };
      }
    }
  }
  private layoutChanged(): void {
    if (this.dead) return;
    this.version++;
    if (!this.pointer) {
      if (this.pendingAnchor?.element.isConnected) {
        this.restorePosition(this.pendingAnchor.anchor, 'start', false);
        if (!this.unsettled(this.pendingAnchor.element)) { this.pendingAnchor = null; this.rememberAnchor(); }
      } else if (this.visual?.element.isConnected) {
        const top = (this.visual.range ?? this.visual.element).getBoundingClientRect().top;
        this.writeScroll(this.element.scrollTop + top - this.visual.top);
      } else if (this.anchor) this.restorePosition(this.anchor, 'start', false);
    }
    this.element.dispatchEvent(new Event('md-layout'));
    this.scrolled();
  }
  /** 派生内容交付后立即由同一负责人锚定，不能等到下一轮尺寸观察才修正。 */
  contentChanged(): void { this.layoutChanged(); }
  private watchAsset(image: HTMLImageElement): void {
    if (!this.root.contains(image)) return;
    this.assets.set(image, 2);
    if (!this.assetFrame) this.assetFrame = requestAnimationFrame(this.checkAssets);
  }
  private checkAssets = (): void => {
    this.assetFrame = 0;
    if (this.dead) return;
    for (const [image, remaining] of this.assets) {
      if (!this.root.contains(image) || image.complete && remaining <= 1) this.assets.delete(image);
      else this.assets.set(image, image.complete ? remaining - 1 : 2);
    }
    // 原生滚动可能已提交，但记锚的 rAF 尚未执行；不能把新滚动补偿回去。
    if (Math.abs(this.element.scrollTop - this.visualScrollTop) > .5) this.scrolled();
    else if (this.visual?.element.isConnected && Math.abs((this.visual.range ?? this.visual.element).getBoundingClientRect().top - this.visual.top) > .5) this.layoutChanged();
    if (this.assets.size) this.assetFrame = requestAnimationFrame(this.checkAssets);
  };
  private assetLoaded = (event: Event): void => {
    // 原生图片尺寸可能先于下一轮 RO 交付；只通知当前锚管理器，
    // 不保存或写回加载开始时的位置。新输入和销毁仍取消旧锚。
    if (event.target instanceof HTMLImageElement && this.root.contains(event.target)) { this.watchAsset(event.target); this.contentChanged(); }
  };
  update(blocks: ReadingBlock[], lines: number, append = false): void {
    const visible = blocks.filter(entry => !entry.element.hidden);
    if (append && !visible.length) { this.lines = lines; return; }
    for (const entry of visible) this.entries.set(entry.element, entry);
    const previousLength = this.blocks.length;
    if (!append) this.indices = new WeakMap();
    visible.forEach((entry, index) => {
      const position = (append ? previousLength : 0) + index;
      this.indices.set(entry.element, position);
      const page = entry.element.parentElement;
      if (page?.classList.contains('md-reading-page') && !this.indices.has(page)) this.indices.set(page, position);
    });
    if (append) {
      this.blocks.push(...visible);
      for (const entry of visible) {
        let lo = 0, hi = this.source.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.source[mid]!.block.from <= entry.block.from) lo = mid + 1; else hi = mid; }
        this.source.splice(lo, 0, entry); this.byId.set(entry.block.id, entry);
      }
    } else {
      this.blocks = visible;
      this.source = [...visible].sort((a, b) => a.block.from - b.block.from || a.block.to - b.block.to);
      this.byId = new Map(visible.map(entry => [entry.block.id, entry]));
      const next = new Set(visible.map(entry => entry.element));
      for (const { element } of visible) if (element.parentElement?.classList.contains('md-reading-page')) next.add(element.parentElement);
      for (const element of this.observed) if (!next.has(element)) { this.observer?.unobserve(element); this.observed.delete(element); }
      for (const page of this.pages.keys()) if (!next.has(page)) this.pages.delete(page);
      for (const page of this.pinnedPages) if (!next.has(page)) { page.style.removeProperty('content-visibility'); this.pinnedPages.delete(page); }
    }
    for (const { element } of visible) if (!this.observed.has(element)) {
      // 组外盒负责离屏占位，不能为登记子块而强制展开该组；真实高度由 RO 在布局时交付。
      const estimate = parseFloat(element.style.containIntrinsicSize.split(' ')[1] ?? '');
      const height = Number.isFinite(estimate) ? estimate : element.offsetHeight;
      this.geometry.set(element, { top: 0, height });
      this.heights.set(element, height);
      this.observer?.observe(element); this.observed.add(element);
    }
    for (const { element } of visible) {
      const page = element.parentElement;
      if (page?.classList.contains('md-reading-page') && !this.pages.has(page)) {
        this.pages.set(page, page.getBoundingClientRect().height || page.offsetHeight);
        this.observer?.observe(page); this.observed.add(page);
      }
    }
    if (!append) for (const element of this.geometry.keys()) if (!this.observed.has(element)) this.geometry.delete(element);
    if (!append) for (const element of this.heights.keys()) if (!this.observed.has(element)) this.heights.delete(element);
    if (!append || !previousLength) this.origin = this.measureOrigin();
    this.navigation = this.blocks;
    if (!append || this.nested.size || visible.some(entry => entry.block.sourceRanges)) this.indexGenerated();
    this.reindex(append ? previousLength : 0);
    this.lines = lines; this.version++;
    if (!append || !previousLength) this.rememberAnchor();
    this.element.dispatchEvent(new Event('md-layout'));
  }
  snapshot(): ScrollLayoutSnapshot {
    return { version: this.version, top: this.element.scrollTop, height: this.element.scrollHeight, viewport: this.element.clientHeight };
  }
  /** 显式测量供无 ResizeObserver 的宿主使用；滚动热路径只查询已交付的布局。 */
  measure(): void {
    for (const { element } of this.blocks) this.heights.set(element, element.getBoundingClientRect().height || element.offsetHeight);
    for (const page of this.pages.keys()) this.pages.set(page, page.getBoundingClientRect().height || page.offsetHeight);
    this.measureNested();
    this.origin = this.measureOrigin();
    this.reindex(); this.version++;
  }
  private reindex(from = 0): void {
    // 冷构建只在尾部追加。仅重新索引接收新块的最后一组，保留前面组的几何。
    let startIndex = Math.min(from, this.blocks.length - 1);
    if (startIndex < 0) return;
    const firstPage = this.blocks[startIndex]!.element.parentElement;
    if (firstPage && this.pages.has(firstPage)) while (startIndex > 0 && this.blocks[startIndex-1]!.element.parentElement === firstPage) startIndex--;
    const preceding = startIndex ? this.geometry.get(this.blocks[startIndex-1]!.element) : undefined;
    let top = preceding ? preceding.top + preceding.height : this.origin;
    for (let index = startIndex; index < this.blocks.length;) {
      const page = this.blocks[index]!.element.parentElement;
      let end = index + 1;
      if (page && this.pages.has(page)) while (end < this.blocks.length && this.blocks[end]!.element.parentElement === page) end++;
      let natural = 0;
      for (let i = index; i < end; i++) natural += this.heights.get(this.blocks[i]!.element) ?? 0;
      // 跳过布局的组使用浏览器当前占位高度；子块按分类估计/实测比例分配。
      // 不能累加离屏子块的旧高度，否则页面实际位置与定位索引会逐组分离。
      const height = page && this.pages.has(page) ? this.pages.get(page)! : natural;
      const scale = natural > 0 ? height / natural : 0;
      const start = top;
      for (let i = index; i < end; i++) {
        const element = this.blocks[i]!.element, box = this.geometry.get(element);
        if (box) { box.top = top; box.height = natural ? (this.heights.get(element) ?? 0) * scale : height / (end-index); top += box.height; }
      }
      top = start + height; index = end;
    }
    for (const [element, nested] of this.nested) {
      const box = this.geometry.get(element), parent = this.geometry.get(nested.parent);
      if (box && parent) box.top = parent.top + nested.relative;
    }
  }
  private measureOrigin(): number {
    const first = this.blocks[0]?.element;
    return first ? first.getClientRects().length ? first.getBoundingClientRect().top - this.element.getBoundingClientRect().top + this.element.scrollTop : first.offsetTop : 0;
  }
  private indexGenerated(): void {
    this.nested.clear();
    this.navigation = this.blocks.flatMap(entry => {
      if (!entry.block.sourceRanges) return [entry];
      return entry.block.sourceRanges.flatMap(range => {
        const element = entry.element.querySelector<HTMLElement>('[id="' + range.target + '"]');
        if (!element) return [];
        this.nested.set(element, { parent:entry.element, relative:0 });
        this.geometry.set(element, { top:0, height:element.offsetHeight });
        this.heights.set(element, element.offsetHeight);
        this.observer?.observe(element); this.observed.add(element);
        const nested = { element, block:{ ...entry.block, ...range, id:entry.block.id + ':' + range.key, kind:'FootnoteDefinition', sourceRanges:undefined } };
        this.entries.set(element, nested);
        return [nested];
      });
    });
    this.measureNested();
    this.source = [...this.navigation].sort((a,b)=>a.block.from-b.block.from);
    this.byId = new Map(this.navigation.map(entry=>[entry.block.id,entry]));
  }
  private measureNested(dirty?: Set<HTMLElement>): void {
    if (!this.nested.size) return;
    let pairs = [...this.nested];
    if (dirty) {
      // 脏区间：嵌套目标只随自身或同父兄弟的布局变化而移动；其余父块维持已交付的 relative。
      const dirtyParents = new Set<HTMLElement>();
      for (const [, nested] of this.nested) if (dirty.has(nested.parent)) dirtyParents.add(nested.parent);
      for (const element of dirty) { const nested = this.nested.get(element); if (nested) dirtyParents.add(nested.parent); }
      if (!dirtyParents.size) return;
      pairs = pairs.filter(([, nested]) => dirtyParents.has(nested.parent));
    }
    // 父盒一次性读取：同一父块的多个嵌套目标共享一次 getBoundingClientRect。
    const parentTops = new Map<HTMLElement, number>();
    for (const [element, nested] of pairs) {
      let parentTop = parentTops.get(nested.parent);
      if (parentTop === undefined) { parentTop = nested.parent.getBoundingClientRect().top; parentTops.set(nested.parent, parentTop); }
      nested.relative = element.getBoundingClientRect().top - parentTop;
      const box = this.geometry.get(element); if (box) { box.height = element.offsetHeight; this.heights.set(element, box.height); }
    }
  }
  private atY(y: number): ReadingBlock | undefined {
    let lo = 0, hi = this.navigation.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.geometry.get(this.navigation[mid]!.element)?.top ?? 0) <= y) lo = mid; else hi = mid;
    }
    return this.navigation[lo];
  }
  /** 只在当前可见组内读真实块坐标；组外盒查询不会展开离屏的正文子树。 */
  private renderedAt(top: number): ReadingBlock | undefined {
    if (!this.element.clientHeight) return undefined;
    const y = this.element.getBoundingClientRect().top + top - this.element.scrollTop;
    const at = (children: HTMLCollection): HTMLElement | undefined => {
      let lo = 0, hi = children.length;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >>> 1;
        if (children[mid]!.getBoundingClientRect().top <= y + 1) lo = mid; else hi = mid;
      }
      let element = children[lo] as HTMLElement | undefined;
      while (element?.hidden) element = element.previousElementSibling as HTMLElement | undefined;
      if (!element) { element = children[lo] as HTMLElement | undefined; while (element?.hidden) element = element.nextElementSibling as HTMLElement | undefined; }
      return element;
    };
    let element = at(this.root.children);
    if (element?.classList.contains('md-reading-page')) element = at(element.children);
    return element ? this.entries.get(element) : undefined;
  }
  /**
   * 同帧复用：reading-surface 自身的滚动 rAF（rememberAnchor）与分屏同步协调器
   * 会先后读取同一位置的阅读锚。按 (scrollTop, layoutVersion) 记忆化，避免每帧
   * 重复做 binary search + 多段 getBoundingClientRect，把同步帧压回预算内。
   * 任何滚动写入或布局版本变化都会自然失效。
   */
  capture(): ScrollAnchor {
    const top = this.element.scrollTop;
    const cached = this.captureCache;
    if (cached && cached.top === top && cached.version === this.version) return cached.anchor;
    const anchor = this.captureUncached();
    this.captureCache = { top, version: this.version, anchor };
    return anchor;
  }

  private captureUncached(): ScrollAnchor {
    if (this.pendingAnchor) {
      if (this.pendingAnchor.element.isConnected && this.unsettled(this.pendingAnchor.element)) return this.pendingAnchor.anchor;
      this.pendingAnchor = null;
    }
    const entry = this.renderedAt(this.element.scrollTop);
    if (!entry || entry.block.sourceRanges) return this.atPosition(this.element.scrollTop);
    const box = entry.element.getBoundingClientRect();
    if (!box.height) return this.atPosition(this.element.scrollTop);
    const offset = this.element.getBoundingClientRect().top - box.top;
    const fraction = Math.min(1, Math.max(0, offset / box.height));
    return { line: Math.min(this.lines, entry.block.startLine + 1 + fraction * (entry.block.endLine - entry.block.startLine)),
      surface: 'preview', blockId: entry.block.id, offset, blockHeight: box.height };
  }
  visibleLines(): { first: number; last: number } {
    return { first: this.capture().line, last: this.atPosition(this.element.scrollTop + this.element.clientHeight).line };
  }
  private atPosition(top: number): ScrollAnchor {
    const entry = this.atY(top);
    if (!entry) return { line: 1, surface: 'preview' };
    const { block, element } = entry;
    const box = this.geometry.get(element)!;
    const offset = top - box.top;
    const fraction = box.height ? Math.min(1, Math.max(0, offset / box.height)) : 0;
    return { line: Math.min(this.lines, block.startLine + 1 + fraction * (block.endLine - block.startLine)),
      surface: 'preview', blockId: block.id, offset, blockHeight: box.height };
  }
  restore(anchor: ScrollAnchor, align: 'start' | 'center' = 'start'): void {
    this.userInput();
    const entry = this.restorePosition(anchor, align);
    this.restoredElement = entry?.element ?? null;
    if (align === 'start' && entry && this.unsettled(entry.element)) this.pendingAnchor = { anchor, element: entry.element };
    this.rememberAnchor();
  }
  private unsettled(element: HTMLElement): boolean {
    return !!element.querySelector('.md-render-target:not([data-render-done])')
      || [...element.querySelectorAll('img')].some(image => !image.complete);
  }
  private restorePosition(anchor: ScrollAnchor, align: 'start' | 'center' = 'start', expand = true): ReadingBlock | undefined {
    const same = anchor.blockId ? this.byId.get(anchor.blockId) : undefined;
    let entry = same, fraction = 0;
    if (!entry) {
      const line = Math.max(0, anchor.line - 1);
      let lo = 0, hi = this.source.length;
      while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (this.source[mid]!.block.startLine <= line) lo = mid; else hi = mid; }
      entry = this.source[lo]; if (!entry) return;
      fraction = Math.min(1, Math.max(0, (line - entry.block.startLine) / Math.max(1, entry.block.endLine - entry.block.startLine)));
    }
    // 尺寸交付只校正当前阅读锚。RO 内展开相邻离屏页会产生更浅层的新尺寸通知，
    // 浏览器须推迟它并报告循环；显式导航才需要预先展开目的页与邻页。
    if (expand) this.activate(entry.element);
    const cached = this.geometry.get(entry.element)!;
    const rect = this.element.clientHeight ? entry.element.getBoundingClientRect() : undefined;
    const top = rect?.height ? rect.top - this.element.getBoundingClientRect().top + this.element.scrollTop : cached.top;
    const height = rect?.height || cached.height;
    const offset = same && anchor.offset !== undefined
      ? anchor.blockHeight && anchor.offset >= 0 ? anchor.offset / anchor.blockHeight * height : anchor.offset : fraction * height;
    const y = top + offset;
    this.writeScroll(Math.max(0, y - (align === 'center' ? this.element.clientHeight / 2 : 0)));
    return entry;
  }
  private activate(element: HTMLElement): void {
    const page = element.closest<HTMLElement>('.md-reading-page');
    // 快跳之前显式展开目的组。WebView2 的 AX 树在跳到被 auto 跳过的组时可能崩溃；
    // 同时需要目的块的真实高度，不能以旧占位比例恢复源码位置。
    for (const candidate of [page?.previousElementSibling, page, page?.nextElementSibling]) {
      if (candidate instanceof HTMLElement && candidate.classList.contains('md-reading-page') && !this.pinnedPages.has(candidate)) {
        candidate.style.contentVisibility = 'visible'; this.pinnedPages.add(candidate);
      }
    }
  }
  scrollTo(top: number): void {
    this.userInput();
    const entry = this.atY(top); if (entry) this.activate(entry.element);
    this.writeScroll(Math.max(0, top));
    this.rememberAnchor();
  }
  reveal(target: Element, align: 'start' | 'center' = 'start'): void {
    if (!this.root.contains(target)) return;
    this.activate(target as HTMLElement);
    const top = target.getBoundingClientRect().top - this.element.getBoundingClientRect().top + this.element.scrollTop;
    this.scrollTo(top - (align === 'center' ? this.element.clientHeight / 2 : 0));
    this.element.dispatchEvent(new Event('md-navigate'));
  }
  overview(count: number, snapshot: ScrollLayoutSnapshot): OverviewSample[] {
    return Array.from({ length: count }, (_, index) => {
      const y = ((index + .5) / count) * snapshot.height, entry = this.atY(y);
      if (!entry) return { text: '' };
      const { block, element } = entry;
      let sample = this.texts.get(element);
      if (!sample) {
        const text = element.textContent ?? '';
        const image = !text.trim() && element.querySelector('img');
        sample = { text: image ? '[image]' : text, kind: image ? 'Image' : block.kind };
        this.texts.set(element, sample);
      }
      const { text, kind } = sample;
      const box = this.geometry.get(element)!;
      const ratio = box.height ? Math.min(.999, Math.max(0, (y - box.top) / box.height)) : 0;
      const start = Math.floor(ratio * Math.max(0, text.length - 80));
      return { text: text.slice(start, start + 100).replace(/\s+/g, ' '), kind };
    });
  }
  destroy(): void {
    this.dead = true; cancelAnimationFrame(this.frame); cancelAnimationFrame(this.assetFrame); this.observer?.disconnect(); this.assetObserver?.disconnect(); this.assets.clear();
    this.geometry.clear(); this.heights.clear(); this.pages.clear(); this.observed.clear();
    for (const page of this.pinnedPages) page.style.removeProperty('content-visibility');
    this.pinnedPages.clear(); this.entries = new WeakMap(); this.indices = new WeakMap();
    this.nested.clear(); this.byId.clear(); this.blocks = []; this.navigation = []; this.source = []; this.visual = null; this.anchor = null; this.pendingAnchor = null; this.restoredElement = null;
    this.element.removeEventListener('scroll', this.scrolled);
    this.root.removeEventListener('load', this.assetLoaded, true);
    this.root.removeEventListener('error', this.assetLoaded, true);
    for (const event of ['wheel', 'touchstart', 'keydown']) this.element.removeEventListener(event, this.userInput);
    this.element.removeEventListener('pointerdown', this.pointerDown); document.removeEventListener('pointerup', this.pointerUp);
    if (surfaces.get(this.element) === this) surfaces.delete(this.element);
  }
}
