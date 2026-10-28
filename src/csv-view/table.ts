// csv-view —— CSV 表格视图（007 子 PRD P2）：表头网格 + 虚拟滚动
// 批 D-3：数据层改走 Rust 记录级解析（csv_records），引号内嵌换行不再拆碎记录
// ipc 改回静态 import（此前的动态 import 与其他模块的静态 import
// 并存，构建期恒报 INEFFECTIVE_DYNAMIC_IMPORT，动态化无收益）
import * as ipc from '../common/ipc';
import type { CsvRecordsResult } from '../common/ipc';
import { t, tf } from '../common/i18n';

export const CSV_ROW_HEIGHT = 24;

// 每帧最多补 16 列，避免宽表一次创建数万格阻塞标签切换。
export const CSV_COLUMN_BATCH = 16;
export function renderColumnBatches(total: number, render: (from: number, to: number) => void,
  active: () => boolean = () => true): void {
  let from = 0;
  const step = () => {
    if (!active()) return;
    const to = Math.min(total, from + CSV_COLUMN_BATCH);
    render(from, to);
    from = to;
    if (from < total) requestAnimationFrame(step);
  };
  step();
}

export interface TableRecordProvider {
  readonly supportsDelimiter: boolean;
  readonly supportsSource: boolean;
  readonly firstRowHeader: boolean;
  records(path: string, from: number, to: number, delim: string, encoding: string): Promise<CsvRecordsResult>;
}
export const csvRecordProvider: TableRecordProvider = {
  supportsDelimiter: true,
  supportsSource: true,
  firstRowHeader: true,
  records: (path, from, to, delim, encoding) => ipc.csvRecords(path, from, to, delim, encoding),
};
export function xlsxRecordProvider(sheet = 0): TableRecordProvider {
  return {
    supportsDelimiter: false,
    supportsSource: false,
    firstRowHeader: false,
    records: async (path, from, to) => ({ ...await ipc.xlsxRecords(path, sheet, from, to), delimiter: '' }),
  };
}

/** 字号基准：settings.fontSize 出厂 12（此时表格继承 body 13px，观感锚点） */
export const CSV_BASE_FS = 12;

/** 行高随字号派生（001 规则 31 v2.5 / 002 规则 12 v2.5：CSV 行高派生；基准 24px@fs12，取整） */
export function csvRowHeight(fs: number): number {
  return Math.round((CSV_ROW_HEIGHT * fs) / CSV_BASE_FS);
}

/** 表格正文字号（继承 body 13px@fs12：+1 偏移，出厂观感不变；styles.css 不动，行内覆盖） */
export function csvFontPx(fs: number): number {
  return fs + 1;
}

/** 单行 CSV 解析（带引号支持，纯函数供单测） */
export function parseCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === delim) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function sniffDelim(header: string): string {
  const counts: Array<[string, number]> = [',', ';', '\t'].map(d => [d, parseCsvLine(header, d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

export class CsvView {
  private scroller!: HTMLDivElement;
  private sizer!: HTMLDivElement;
  private body!: HTMLDivElement;
  private header: string[] = [];
  private delim = ',';
  /** 用户经工具栏「分隔符」显式选择的分隔符（H-6h）：嗅探只是初始猜测，
   *  重挂载（setDelim → mount）时显式选择必须压过嗅探，否则选了永远被弹回。 */
  private delimOverride: string | null = null;
  private total = 0;
  /** 渲染列数（007 边界表：列数不齐按最大列数渲染缺位为空；随滚动单调扩列不回缩，防表头/网格跳动） */
  private maxCols = 0;
  private renderedKey = '';
  /** 字号消费（001 规则 31 v2.5）：行高/虚拟滚动随 fs 重派生；mount 前调用仅记录，挂载时生效 */
  private fontSize = CSV_BASE_FS;
  private rowH = CSV_ROW_HEIGHT;
  private headerRow: HTMLDivElement | null = null;
  private renderFn: (() => Promise<void>) | null = null;
  private generation = 0;

  constructor(
    private host: HTMLElement,
    private path: string,
    private encoding: string,
    private onBack: () => void,
    delimiter?: string,
    private provider: TableRecordProvider = csvRecordProvider
  ) {
    this.delimOverride = delimiter ?? null;
  }

  async mount(): Promise<void> {
    const generation = ++this.generation;
    this.host.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'csv-bar';
    const back = document.createElement('button');
    back.textContent = t('csv.backToSource');
    back.addEventListener('click', this.onBack);
    back.hidden = !this.provider.supportsSource;
    const info = document.createElement('span');
    bar.append(back, info);
    this.host.appendChild(bar);

    const wrap = document.createElement('div');
    wrap.className = 'csv-wrap';
    this.scroller = document.createElement('div');
    this.scroller.className = 'csv-scroller';
    // 001 规则 31 v2.5：字号落表格正文（行内覆盖 body 继承；出厂 fs12 → 13px 观感不变）；
    // 重挂（setDelim）路径同样经过这里，显式字号不被重挂弹回
    this.scroller.style.fontSize = `${csvFontPx(this.fontSize)}px`;
    this.sizer = document.createElement('div');
    this.body = document.createElement('div');
    this.sizer.appendChild(this.body);
    this.scroller.appendChild(this.sizer);
    wrap.appendChild(this.scroller);
    this.host.appendChild(wrap);

    // Rust 按完整首记录识别，表头引号内换行不能被首物理行截断。
    const firstBatch = await this.provider.records(this.path, 1, 40, this.delimOverride ?? '', this.encoding).catch(err => {
      const msg = String(err);
      info.textContent = msg === 'TOO_LARGE' ? t('csv.tooLarge') : tf('err.readFail', msg);
      return null;
    });
    if (generation !== this.generation) return;
    if (!firstBatch || firstBatch.records.length === 0) {
      if (!info.textContent) info.textContent = t('csv.empty');
      return;
    }
    this.delim = firstBatch.delimiter;
    this.header = this.provider.firstRowHeader ? firstBatch.records[0].cells :
      Array.from({ length: Math.max(...firstBatch.records.map(r => r.cells.length)) }, (_, i) => {
        let label = ''; let n = i + 1;
        while (n) { n--; label = String.fromCharCode(65 + n % 26) + label; n = Math.floor(n / 26); }
        return label;
      });
    this.total = Math.max(firstBatch.total, 1);
    this.maxCols = this.header.length;
    info.textContent = tf('csv.info', this.delim === '\t' ? 'Tab' : this.delim, this.maxCols);
    const headerRow = document.createElement('div');
    headerRow.className = 'csv-header';
    headerRow.style.fontSize = `${csvFontPx(this.fontSize)}px`;
    this.headerRow = headerRow;
    wrap.insertBefore(headerRow, this.scroller);

    this.sizer.style.height = `${(this.total + 1) * this.rowH}px`;
    const cache = new Map<number, string[]>();
    const sizes = new Map<number, number>();
    let cacheBytes = 0;
    const cacheRecord = (no: number, cells: string[]) => {
      cacheBytes -= sizes.get(no) ?? 0;
      cache.delete(no);
      cache.set(no, cells);
      const bytes = cells.reduce((n, value) => n + value.length * 2, 0);
      sizes.set(no, bytes);
      cacheBytes += bytes;
      while (cacheBytes > 8 * 1024 * 1024 && cache.size > 1) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= sizes.get(oldest) ?? 0;
        cache.delete(oldest);
        sizes.delete(oldest);
      }
    };
    const firstRecord = this.provider.firstRowHeader ? 2 : 1;
    // 行 DOM 复用池：key = 记录号；每次 mount 私有（与 cache 同生命周期）
    const rowPool = new Map<number, HTMLDivElement>();
    for (const r of firstBatch.records) if (r.no >= firstRecord) cacheRecord(r.no, r.cells);
    let renderVersion = 0;
    const render = async () => {
      if (generation !== this.generation) return;
      const from = Math.max(firstRecord, Math.min(this.total, Math.floor(this.scroller.scrollTop / this.rowH)));
      const visible = Math.ceil(this.scroller.clientHeight / this.rowH) + 10;
      const to = Math.min(this.total, from + visible);
      const key = `${from}-${to}`;
      if (key === this.renderedKey) return;
      this.renderedKey = key;
      const version = ++renderVersion;
      const missing: number[] = [];
      for (let n = from; n <= to; n++) if (!cache.has(n)) missing.push(n);
      if (missing.length) {
        try {
          const got = await this.provider.records(this.path, missing[0], missing[missing.length - 1], this.delim, this.encoding);
          if (generation !== this.generation || version !== renderVersion) return;
          for (const r of got.records) cacheRecord(r.no, r.cells);
          if (got.total !== this.total) {
            this.total = got.total;
            this.sizer.style.height = `${(this.total + 1) * this.rowH}px`;
          }
          info.textContent = got.records.length && got.records[got.records.length - 1].no < missing[missing.length - 1]
            ? t('csv.windowLimited')
            : tf('csv.info', this.delim === '\t' ? 'Tab' : this.delim, this.maxCols);
        } catch (error) {
          if (generation !== this.generation || version !== renderVersion) return;
          this.renderedKey = '';
          info.textContent = tf('err.readFail', String(error));
          this.body.replaceChildren();
          return;
        }
      }
      // 007 边界表：列数不齐按当前窗口最大列数渲染（表头补空、窄行缺位为空）；
      // maxCols 单调扩列——滚出更宽行后再滚回不缩列，避免表头/网格反复跳动
      let windowCols = this.maxCols;
      for (let n = from; n <= to; n++) { const cs = cache.get(n); if (cs && cs.length > windowCols) windowCols = cs.length; }
      if (windowCols > this.maxCols) {
        this.maxCols = windowCols;
        info.textContent = tf('csv.info', this.delim === '\t' ? 'Tab' : this.delim, windowCols);
      }
      const cols = this.maxCols;
      // 行 DOM 复用池：按记录号 key 复用行元素，窗口平移时只更新
      // className/textContent（列结构稳定，格子增删到 cols 即可），不再整窗 createElement
      const frag = document.createDocumentFragment();
      const pending: Array<{ row: HTMLDivElement; cells: string[] }> = [];
      const keep = new Set<number>();
      for (let n = from; n <= to; n++) {
        if (!cache.has(n)) break;
        keep.add(n);
        const cells = cache.get(n)!;
        let row = rowPool.get(n);
        if (!row) {
          row = document.createElement('div');
          rowPool.set(n, row);
        }
        // xlsx 口径（firstRowHeader=false）：逻辑首记录即用户可见表头——按表头观感呈现（designer S2）
        row.className = n === firstRecord && !this.provider.firstRowHeader ? 'csv-row csv-first' : 'csv-row';
        // 行内覆盖 styles.css 24px 基准（行高随字号派生，001 规则 31 v2.5）
        row.style.height = `${this.rowH}px`;
        row.style.lineHeight = `${this.rowH}px`;
        row.replaceChildren();
        pending.push({ row, cells });
        frag.appendChild(row);
      }
      this.body.style.transform = `translateY(${(from - firstRecord) * this.rowH}px)`;
      this.body.replaceChildren(frag);
      headerRow.replaceChildren();
      renderColumnBatches(cols, (start, end) => {
        for (const { row, cells } of [{ row: headerRow, cells: this.header }, ...pending]) {
          const batch = document.createDocumentFragment();
          for (let c = start; c < end; c++) {
            const cell = document.createElement('div');
            cell.className = 'csv-cell';
            cell.textContent = cells[c] ?? '';
            batch.appendChild(cell);
          }
          row.appendChild(batch);
        }
      }, () => generation === this.generation && version === renderVersion);
      // 池有界：远端旧行淘汰（插入序最旧优先），上限约两窗口
      const poolCap = Math.max(keep.size * 2, 64);
      if (rowPool.size > poolCap) {
        for (const key of rowPool.keys()) {
          if (rowPool.size <= poolCap) break;
          if (!keep.has(key)) rowPool.delete(key);
        }
      }
    };
    // 滚动 rAF 节流：帧内首个 scroll 事件立即渲染（保交互即时性），
    // 同帧后续事件合并为帧尾一次补渲染——连续滚动时每帧至多两次 render 调用
    // （render 自带 renderedKey 去重，窗口未变即空转返回）。
    let scrollRenderQueued = false;
    let scrollRenderPending = false;
    const renderFromScroll = () => {
      if (scrollRenderQueued) {
        scrollRenderPending = true;
        return;
      }
      scrollRenderQueued = true;
      void render();
      requestAnimationFrame(() => {
        scrollRenderQueued = false;
        if (scrollRenderPending) {
          scrollRenderPending = false;
          renderFromScroll();
        }
      });
    };
    this.scroller.addEventListener('scroll', renderFromScroll);
    // H-6h：重挂路径（setDelim）会重建 body，renderedKey 必须一并失效——
    // 否则重挂后首个 render() 命中旧 key 直接跳过，表格只剩表头没有数据行
    this.renderedKey = '';
    // setFontSize 经此引用触发重渲染（render 是挂载点局部闭包，持 cache）
    this.renderFn = render;
    await render();
  }

  destroy(): void {
    this.generation++;
    this.renderFn = null;
  }

  /** 当前分隔符（H-2 工具栏「分隔符 ▾」显示用） */
  get delimiter(): string {
    return this.delim;
  }

  get supportsDelimiter(): boolean { return this.provider.supportsDelimiter; }

  /** 切换分隔符并整表重析（H-2 CSV 上下文组） */
  setDelim(delim: string): void {
    if (!this.supportsDelimiter) return;
    // H-6h：先记显式选择再重挂——此前只写 this.delim，mount() 开头的嗅探又把它盖回去，
    // 「分隔符▾」点什么都弹回嗅探值（实测逗号文件选分号后表头/列数纹丝不动）。
    this.delimOverride = delim;
    if (delim === this.delim) return;
    void this.mount();
  }

  /** 设置字号（001 规则 31 v2.5 / 002 规则 12 v2.5：CSV 行高派生）。
   *  行高/虚拟滚动（from/visible/translateY/sizer 总高）全部按新行高重算并重渲染；
   *  首可见记录号保持。幂等：重复同值调用无副作用；mount 前调用仅记录，挂载时生效。 */
  setFontSize(fs: number): void {
    const v = Math.min(18, Math.max(10, Math.round(fs))); // 与设置字号同域（10–18px）
    if (v === this.fontSize) return;
    const oldRowH = this.rowH;
    this.fontSize = v;
    this.rowH = csvRowHeight(v);
    if (!this.scroller) return; // 未挂载：mount 会按 this.fontSize/this.rowH 落地
    const firstRec = Math.floor(this.scroller.scrollTop / oldRowH);
    this.scroller.style.fontSize = `${csvFontPx(v)}px`;
    if (this.headerRow) this.headerRow.style.fontSize = `${csvFontPx(v)}px`;
    this.sizer.style.height = `${(this.total + 1) * this.rowH}px`;
    this.scroller.scrollTop = firstRec * this.rowH;
    this.renderedKey = ''; // 行内行高已变：即便 from/to 区间同值也必须重建行
    void this.renderFn?.();
  }
}
