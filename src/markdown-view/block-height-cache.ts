import { Facet, type ChangeDesc } from '@codemirror/state';
import { type EditorView } from '@codemirror/view';

export interface RowHeightSnapshot { cols: number; width: number; heights: number[]; measured: boolean[] }
export interface HeightEntry { height: number; bytes: number; snapshot?: RowHeightSnapshot }
export interface HeightIdentity { key: string; from: number; to: number; token: object; kind: string; inset: number; quoted: number }

/** (2026-10-29 高度预言机) 内容 LRU 与坐标绑定分离，撤销可复用旧内容。 */
export class BlockHeightCache {
  private entries = new Map<string, HeightEntry>();
  private bindings = new Map<number, HeightIdentity>();
  private pending = new Map<number, () => HeightIdentity | undefined>();
  private bytes = 0;
  private bindingBytes = 0;
  private signature = '';
  private layoutPending = false;
  generation = 0;
  bound(kind: string, inset: number, quoted: number, from: number, to: number): HeightIdentity | undefined {
    const resolve = this.pending.get(from);
    if (resolve) { this.pending.delete(from); resolve(); }
    const old = this.bindings.get(from);
    return old?.to === to && old.kind === kind && old.inset === inset && old.quoted === quoted ? old : undefined;
  }
  defer(from: number, resolve: () => HeightIdentity | undefined): void {
    this.pending.set(from, resolve);
    if (this.pending.size > 1024) this.pending.delete(this.pending.keys().next().value!);
  }
  identity(kind: string, source: string, inset: number, quoted: number, from: number, to: number): HeightIdentity | undefined {
    // 用 UTF-16 存储量保守限额，避免仅为大小判断分配整段 UTF-8 缓冲。
    // ASCII 会较早跳过；不再精确计算混合文本的 UTF-8 字节数。
    if (source.length > 32768) return;
    const key = JSON.stringify([kind, source, inset, quoted]);
    const old = this.bindings.get(from);
    if (old?.key === key && old.to === to) return old;
    const identity = { key, from, to, token: {}, kind, inset, quoted };
    if (old) this.bindingBytes -= old.key.length * 2 + 64;
    this.bindings.delete(from); this.bindings.set(from, identity);
    this.bindingBytes += key.length * 2 + 64;
    // 内容键也会被位置绑定持有，单独限额以免已淘汰高度的源码继续膨胀内存。
    while (this.bindings.size > 1024 || this.bindingBytes > 1024 * 1024) {
      const start = this.bindings.keys().next().value!;
      this.bindingBytes -= this.bindings.get(start)!.key.length * 2 + 64; this.bindings.delete(start);
    }
    return identity;
  }
  valid(identity: HeightIdentity): boolean { return this.bindings.get(identity.from)?.token === identity.token; }
  map(changes: ChangeDesc): void {
    this.pending.clear();
    const next = new Map<number, HeightIdentity>();
    for (const identity of this.bindings.values()) {
      let touched = false;
      changes.iterChangedRanges((from, to) => { if (from <= identity.to && to >= identity.from) touched = true; });
      if (touched) continue;
      identity.from = changes.mapPos(identity.from, 1); identity.to = changes.mapPos(identity.to, -1);
      next.set(identity.from, identity);
    }
    this.bindings = next;
    this.bindingBytes = [...next.values()].reduce((bytes, identity) => bytes + identity.key.length * 2 + 64, 0);
  }
  layout(signature: string): void {
    this.layoutPending = false;
    if (signature === this.signature) return;
    this.signature = signature; this.clear();
  }
  clear(): void { this.entries.clear(); this.bytes = 0; this.generation++; }
  /** 几何通知到统一读阶段之间禁止用旧布局预测，但不淘汰仅高度变化的记录。 */
  invalidateLayout(): void { this.layoutPending = true; this.generation++; }
  get(identity?: HeightIdentity): number | undefined {
    if (!identity || this.layoutPending || !this.signature || !this.valid(identity)) return;
    const entry = this.entries.get(identity.key);
    if (!entry) return;
    this.entries.delete(identity.key); this.entries.set(identity.key, entry);
    return Number.isFinite(entry.height) ? entry.height : undefined;
  }
  rows(identity: HeightIdentity | undefined, cols: number, width: number): RowHeightSnapshot | undefined {
    if (!identity || this.layoutPending || !this.valid(identity)) return;
    const snapshot = this.entries.get(identity.key)?.snapshot;
    return snapshot?.cols === cols && snapshot.width === width ? snapshot : undefined;
  }
  putRows(identity: HeightIdentity, snapshot: RowHeightSnapshot, generation = this.generation): void {
    if (this.layoutPending || generation !== this.generation || !this.valid(identity)) return;
    const previous = this.entries.get(identity.key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(identity.key); }
    const bytes = identity.key.length * 2 + 64 + snapshot.heights.length * 16;
    // 超预算不得保留与快照不同版本的整块高度；明确回退默认行高。
    if (bytes + this.bindingBytes > 2 * 1024 * 1024) return;
    this.entries.set(identity.key, { height: NaN, bytes, snapshot: {
      ...snapshot, heights: snapshot.heights.slice(), measured: snapshot.measured.slice(),
    } });
    this.bytes += bytes;
    while (this.entries.size > 1024 || this.bytes + this.bindingBytes > 2 * 1024 * 1024) {
      const key = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(key)!.bytes; this.entries.delete(key);
    }
  }
  put(identity: HeightIdentity, height: number, generation = this.generation): void {
    if (this.layoutPending || !this.signature || generation !== this.generation || !this.valid(identity) || !Number.isFinite(height) || height <= 0) return;
    const previous = this.entries.get(identity.key);
    if (previous && Math.abs(previous.height - height) < .5) return;
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(identity.key); }
    const bytes = previous?.bytes ?? identity.key.length * 2 + 64;
    this.entries.set(identity.key, { height, bytes, snapshot: previous?.snapshot }); this.bytes += bytes;
    while (this.entries.size > 1024 || this.bytes + this.bindingBytes > 2 * 1024 * 1024) {
      const key = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(key)!.bytes; this.entries.delete(key);
    }
  }
}
export const blockHeightCache = Facet.define<BlockHeightCache, BlockHeightCache | undefined>({ combine: values => values[0] });

/** 每视图单一观察器，只排队批量读取；写回不派发事务、不修正滚动。 */
export class BlockHeightMeasurements {
  private nodes = new Map<HTMLElement, HeightIdentity>();
  private observer?: ResizeObserver;
  private dead = false;
  private fonts = 0;
  constructor(private view: EditorView, private cache: BlockHeightCache) {
    if (typeof ResizeObserver !== 'undefined') this.observer = new ResizeObserver(() => this.measure());
    this.observer?.observe(view.contentDOM);
    document.fonts?.addEventListener('loadingdone', this.fontLoaded);
  }
  private fontLoaded = (): void => { this.fonts++; this.cache.invalidateLayout(); this.measure(); };
  register(dom: HTMLElement, identity?: HeightIdentity): void {
    if (!identity) { this.unregister(dom); return; }
    this.nodes.set(dom, identity); this.observer?.observe(dom); this.measure();
  }
  unregister(dom: HTMLElement): void { this.nodes.delete(dom); this.observer?.unobserve(dom); }
  measure(): void {
    if (this.dead) return;
    this.view.requestMeasure({ key: this, read: () => {
      if (this.dead) return [];
      const content = this.view.contentDOM, style = getComputedStyle(content), root = document.documentElement;
      const width = content.getBoundingClientRect().width - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
      this.cache.layout(width > 0 ? JSON.stringify([width, style.fontFamily, style.fontSize, style.lineHeight, style.letterSpacing,
        style.getPropertyValue('--mono'), style.getPropertyValue('--md-fs-user'), root.className, root.dataset.tone, root.style.cssText, this.fonts]) : '');
      const generation = this.cache.generation;
      return [...this.nodes].map(([dom, identity]) => ({ dom, identity, generation, height: dom.getBoundingClientRect().height }));
    }, write: results => {
      for (const { dom, identity, generation, height } of results) {
        if (this.dead || !dom.isConnected || this.nodes.get(dom) !== identity || dom.querySelector('.cm-editor, .mdir-table-windowed, .md-render-target:not([data-render-state="ready"])') || dom.matches(':focus-within')) continue;
        if ([...dom.querySelectorAll('img')].some(img => !img.complete || !img.naturalHeight)) continue;
        const tools = dom.querySelector<HTMLElement>('.mdir-tabletools');
        if (tools && getComputedStyle(tools).display !== 'none') continue;
        this.cache.put(identity, height, generation);
      }
    } });
  }
  destroy(): void { this.dead = true; this.observer?.disconnect(); this.nodes.clear(); this.cache.clear(); document.fonts?.removeEventListener('loadingdone', this.fontLoaded); }
}
const measurements = new WeakMap<EditorView, BlockHeightMeasurements>();
export function heightMeasurements(view: EditorView): BlockHeightMeasurements | undefined {
  const cache = view.state.facet(blockHeightCache);
  if (!cache) return;
  let current = measurements.get(view);
  if (!current) { current = new BlockHeightMeasurements(view, cache); measurements.set(view, current); }
  return current;
}
