// tailboard —— 日志尾随台（002 规则 27，差异化）
// 多文件并行 tail 聚合视图：来源色标签、级别过滤着色（ERROR/WARN/INFO 正则）；
// 轮询复用 text_refresh 通道（单文件 TailMode 语义不变），新行按序追加，上限 2000 行。
import { textLines, textOpen, textRefresh, type TextLine } from '../common/ipc';
import { t } from '../common/i18n';

const MAX_ROWS = 2000;
const TAIL_FETCH = 60;

/** 级别规则（可后续进设置自定义） */
function levelOf(text: string): 'err' | 'warn' | 'info' | null {
  if (/\b(ERROR|FATAL|CRITICAL)\b/i.test(text)) return 'err';
  if (/\b(WARN|WARNING)\b/i.test(text)) return 'warn';
  if (/\bINFO\b/.test(text)) return 'info';
  return null;
}

interface Source {
  path: string;
  name: string;
  colorIdx: number;
  lastLine: number; // 已输出的最后行号（0 = 未初始化）
  // text_refresh 判定变更后行索引在后台异步重建（text.rs:849 spawn）——期间 textOpen
  // 返回旧 totalLines，新行拿不到；changed 标志已被消费，下轮 poll 会提前返回。
  // 挂起标记：变更已见但行未到 → 下一轮强制再取，直到行到达或重试上限（大文件 L-5 根修）。
  pendingIndex: boolean;
  pendingTries: number;
}

export interface TailStatus {
  sources: number;
  rows: number;
}

export class TailBoard {
  private host: HTMLElement;
  private list!: HTMLDivElement;
  private chips!: HTMLDivElement;
  private sources: Source[] = [];
  private rows = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private colorSeq = 0;
  private paused = false;
  private levelFilter = new Set<string>();

  constructor(
    host: HTMLElement,
    private opts: {
      onPick: () => Promise<string | null>; // 添加日志（文件选择对话框）
      intervalMs: number;
      onStatus: (s: TailStatus) => void;
    }
  ) {
    this.host = host;
    this.buildDom();
    this.timer = setInterval(() => this.pollAll(), Math.max(400, opts.intervalMs));
  }

  private buildDom(): void {
    this.host.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'csv-bar';
    const addBtn = document.createElement('button');
    addBtn.textContent = t('tail.add');
    addBtn.addEventListener('click', () => void this.addViaDialog());
    const clearBtn = document.createElement('button');
    clearBtn.textContent = t('tail.clear');
    clearBtn.addEventListener('click', () => {
      this.list.innerHTML = '';
      this.rows = 0;
      this.report();
    });
    const pauseBtn = document.createElement('button');
    pauseBtn.textContent = t('tail.pauseToggle');
    pauseBtn.addEventListener('click', () => {
      this.paused = !this.paused;
      pauseBtn.textContent = this.paused ? t('tail.resume') : t('tail.pause');
    });
    const mkLevel = (lv: 'err' | 'warn' | 'info', label: string) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = 'tb-lv-' + lv;
      b.style.opacity = this.levelFilter.has(lv) ? '0.4' : '1';
      b.title = t('tail.toggleLevel');
      b.addEventListener('click', () => {
        if (this.levelFilter.has(lv)) this.levelFilter.delete(lv);
        else this.levelFilter.add(lv);
        b.style.opacity = this.levelFilter.has(lv) ? '0.4' : '1';
        this.list.querySelectorAll(`[data-lv="${lv}"]`).forEach(el => {
          (el as HTMLElement).style.display = this.levelFilter.has(lv) ? 'none' : '';
        });
      });
      return b;
    };
    bar.append(addBtn, mkLevel('err', 'ERROR'), mkLevel('warn', 'WARN'), mkLevel('info', 'INFO'), pauseBtn, clearBtn);
    this.chips = document.createElement('div');
    this.chips.className = 'tb-chips';
    const listWrap = document.createElement('div');
    listWrap.style.cssText = 'position:absolute;inset:72px 0 0 0;overflow:auto';
    this.list = document.createElement('div');
    this.list.className = 'tb-list';
    listWrap.appendChild(this.list);
    this.host.append(bar, this.chips, listWrap);
  }

  async addViaDialog(): Promise<void> {
    const p = await this.opts.onPick();
    if (p) this.addSource(p);
  }

  addSource(path: string): void {
    if (this.sources.some(s => s.path === path)) return;
    const src: Source = {
      path,
      name: path.replace(/\\/g, '/').split('/').pop() ?? path,
      colorIdx: this.colorSeq++ % 6,
      lastLine: 0,
      pendingIndex: false,
      pendingTries: 0,
    };
    this.sources.push(src);
    this.renderChips();
    void this.poll(src);
  }

  private removeSource(src: Source): void {
    this.sources = this.sources.filter(s => s !== src);
    this.renderChips();
    this.list.querySelectorAll(`[data-src="${CSS.escape(src.path)}"]`).forEach(e => e.remove());
    this.report();
  }

  private renderChips(): void {
    this.chips.innerHTML = '';
    for (const s of this.sources) {
      const chip = document.createElement('span');
      chip.className = 'tb-chip';
      chip.title = s.path;
      const dot = document.createElement('span');
      dot.className = `tb-src tb-src-${s.colorIdx}`;
      const name = document.createElement('span');
      name.textContent = s.name;
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = t('tail.removeSource');
      x.addEventListener('click', () => this.removeSource(s));
      chip.append(dot, name, x);
      this.chips.appendChild(chip);
    }
  }

  private async pollAll(): Promise<void> {
    if (this.paused) return;
    for (const s of [...this.sources]) await this.poll(s);
  }

  private async poll(src: Source): Promise<void> {
    if (this.destroyed) return;
    try {
      const r = await textRefresh(src.path);
      if (!r.changed && src.lastLine > 0 && !src.pendingIndex) return;
      const open = await textOpen(src.path);
      const total = open.totalLines || 0;
      if (total <= src.lastLine && src.lastLine > 0) {
        // 变更已判定但行号未涨：索引仍在后台重建（或文件被截短）——挂起待下轮（上限 20 轮防死循环）
        if ((r.changed || src.pendingIndex) && src.pendingTries < 20) {
          src.pendingIndex = true;
          src.pendingTries++;
        } else {
          src.pendingIndex = false;
          src.pendingTries = 0;
        }
        return;
      }
      src.pendingIndex = false;
      src.pendingTries = 0;
      const from = Math.max(1, src.lastLine + 1);
      if (from > total) return;
      const upto = Math.min(total, from + TAIL_FETCH - 1);
      const lines: TextLine[] = await textLines(src.path, from, upto);
      // 轮询间隔内新增超过 TAIL_FETCH：只显示尾部一批，行号对齐
      if (total - src.lastLine > TAIL_FETCH) {
        const tailFrom = Math.max(1, total - TAIL_FETCH + 1);
        const tailLines = await textLines(src.path, tailFrom, total);
        this.appendLines(src, tailLines);
      } else {
        this.appendLines(src, lines);
      }
      src.lastLine = total;
    } catch {
      /* 文件被轮换/删除：保留已有输出不打扰 */
    }
  }

  private appendLines(src: Source, lines: TextLine[]): void {
    const frag = document.createDocumentFragment();
    const stick = this.list.parentElement!.scrollTop + this.list.parentElement!.clientHeight >= this.list.parentElement!.scrollHeight - 40;
    for (const l of lines) {
      const row = document.createElement('div');
      row.className = 'tb-row';
      row.dataset.src = src.path;
      const lv = levelOf(l.text);
      if (lv) {
        row.dataset.lv = lv;
        row.classList.add('tb-lv-' + lv + '-text');
        if (this.levelFilter.has(lv)) row.style.display = 'none';
      }
      const dot = document.createElement('span');
      dot.className = `tb-src tb-src-${src.colorIdx}`;
      const name = document.createElement('span');
      name.className = 'tb-src-name';
      name.textContent = src.name;
      const no = document.createElement('span');
      no.className = 'tb-src-no';
      no.textContent = String(l.no);
      const tx = document.createElement('span');
      tx.textContent = l.text;
      row.append(dot, name, no, tx);
      frag.appendChild(row);
      this.rows++;
    }
    this.list.appendChild(frag);
    // 上限裁剪
    while (this.rows > MAX_ROWS && this.list.firstElementChild) {
      this.list.firstElementChild.remove();
      this.rows--;
    }
    if (stick) this.list.parentElement!.scrollTop = this.list.parentElement!.scrollHeight;
    this.report();
  }

  private report(): void {
    this.opts.onStatus({ sources: this.sources.length, rows: this.rows });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.host.innerHTML = '';
  }
}
