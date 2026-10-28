// 文件树 —— 懒加载目录树（001 子 PRD：目录优先排序，点击文件回调打开）
// 001 v0.9：目录跟随（规则 25）——reveal 逐级展开定位；无本地根时空态
// 换肤批：行结构按定稿 demo（.tr / .tr-group / .tr-children 参考线，kind 色图标）
import { listDir, fileStat, type DirEntry } from '../common/ipc';
import { t, tf } from '../common/i18n';

export interface TreeActions {
  onOpenFile: (path: string) => void;
  /** 过滤框粘贴路径：允许沿既有打开通道打开目录。 */
  onOpenPath?: (path: string, isDir: boolean) => void;
  /** 文件行右键；sel 为 Ctrl+多选集合（批 F #21：≥2 时右键可直达比较） */
  onContextFile?: (path: string, x: number, y: number, sel?: string[]) => void;
  /** 目录行右键（新建/重命名等轻量管理，001 规则 28） */
  onContextDir?: (path: string, x: number, y: number) => void;
}

export interface TreeRoot {
  label: string;
  path: string; // 本地路径
}

/** 扩展名 → 定稿文件类型色（data-kind 驱动 --kc） */
const KIND_BY_EXT: Record<string, string> = {
  rs: 'rs', ts: 'ts', tsx: 'ts', js: 'ts', mjs: 'ts', json: 'json', jsonc: 'json',
  md: 'md', markdown: 'md', bin: 'bin', dat: 'bin', exe: 'bin', dll: 'bin', so: 'bin',
  toml: 'toml', ini: 'toml', cfg: 'toml', yaml: 'toml', yml: 'toml',
};

export function kindOf(name: string): string | null {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return KIND_BY_EXT[ext] ?? null;
}

/**
 * filePath 相对 rootPath 的路径段（001 规则 25 目录跟随用）；不在根下返回 null。
 * Windows 路径统一反斜杠并不区分大小写比较；POSIX 保留原样。纯函数，便于单测。
 */
export function relativeToRoot(rootPath: string, filePath: string): string[] | null {
  const norm = (p: string): string => {
    let s = p.trim();
    if (/^[A-Za-z]:[\\/]/.test(s)) s = s.replace(/\//g, '\\');
    if (s.length > 3) s = s.replace(/[\\/]+$/, '');
    return s;
  };
  const root = norm(rootPath);
  const file = norm(filePath);
  if (!root || !file) return null;
  const win = /^[A-Za-z]:\\/.test(root);
  const sep = win ? '\\' : '/';
  const low = (s: string): string => (win ? s.toLowerCase() : s);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (low(file) === low(root)) return [];
  if (!low(file).startsWith(low(prefix))) return null;
  return file.slice(prefix.length).split(/[\\/]+/).filter(Boolean);
}

const SVG_ARROW = '<svg class="ic s12" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.6l4.4 4.4L6 12.4"/></svg>';
const SVG_DIR = '<svg class="ic s14" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.9 3.9h4.7l1.5 1.9h6v8.3H1.9z"/><path class="sec" d="M1.9 7.1h12.2"/></svg>';
const SVG_FILE = '<svg class="ic s14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 1.9h5l3.2 3.1v9.1H4.2z"/><path class="fold" d="M9.2 1.9v3.1h3.2z"/></svg>';

export class FileTree {
  private expanded = new Set<string>();
  private cache = new Map<string, DirEntry[] | 'loading' | 'error'>();
  private filter = '';
  private preFilterCollapsed: Set<string> | null = null;
  private filterInput!: HTMLInputElement;
  private listHost!: HTMLDivElement;
  private allRows: Array<{ el: HTMLElement; name: string; isDir: boolean; key: string }> = [];
  /** 行索引（perf Pass 1 FB）：key → 行记录，applyFilter/setActive/reveal 复用免线性扫描 */
  private rowByKey = new Map<string, { el: HTMLElement; name: string; isDir: boolean; key: string }>();
  /** 组索引：目录 key → { group, row }；groupOrder 为创建序（父组必先于子组，逆序即自底向上） */
  private groupEls = new Map<string, { group: HTMLElement; row: HTMLElement }>();
  private groupOrder: string[] = [];
  /** 组 key → 直接子行 key（文件行 + 目录行；与物化 DOM 子节点一一对应） */
  private childRows = new Map<string, string[]>();
  /** 过滤防抖定时器（150ms，leading+trailing；清空即时恢复） */
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ctrl+多选集合（批 F #21：两个文件右键直达比较） */
  private multiSel = new Set<string>();
  private roots: TreeRoot[] = [];
  /** 渲染代际：render/refresh 递增；expandInto 的迟到续体（并发重建竞态）按代际弃置 */
  private renderGen = 0;

  constructor(
    private container: HTMLElement,
    rootPath: string | TreeRoot[],
    private actions: TreeActions
  ) {
    this.roots = Array.isArray(rootPath) ? rootPath : [{ label: 'Home', path: rootPath }];
  }

  async render(): Promise<void> {
    this.renderGen++;
    this.container.innerHTML = '';
    // 索引随树重建失效（perf Pass 1 FB：过滤索引与 DOM 同生命周期）
    if (this.filterTimer) { clearTimeout(this.filterTimer); this.filterTimer = null; }
    this.allRows = [];
    this.rowByKey.clear();
    this.groupEls.clear();
    this.groupOrder = [];
    this.childRows.clear();
    const filterWrap = document.createElement('div');
    filterWrap.className = 'tree-filter';
    this.filterInput = document.createElement('input');
    this.filterInput.placeholder = `${t('sidebar.filter')} / ${t('sidebar.filterPath')} ↵`;
    this.filterInput.title = `${t('sidebar.filter')} · ${t('sidebar.filterPathTitle')}`;
    this.filterInput.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const path = this.filterInput.value.trim().replace(/^"(.*)"$/, '$1');
      if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path)) return;
      e.preventDefault();
      // 不存在的路径仍留在过滤框；存在的文件复用文件树打开通道。
      void fileStat(path).then(stat => {
        if (this.actions.onOpenPath) this.actions.onOpenPath(path, stat.isDir);
        else if (!stat.isDir) this.actions.onOpenFile(path);
      }).catch(() => undefined);
    });
    this.filterInput.addEventListener('input', () => {
      const value = this.filterInput.value.trim().toLowerCase();
      if (!value) {
        // 清空即时恢复（不等防抖窗口）：保持「清空 = 立即还原」的既有交互语义
        if (this.filterTimer) { clearTimeout(this.filterTimer); this.filterTimer = null; }
        this.filter = '';
        this.applyFilter();
        return;
      }
      this.filter = value;
      if (this.filterTimer) clearTimeout(this.filterTimer);
      else this.applyFilter(); // 突发首个事件立即生效（leading）
      this.filterTimer = setTimeout(() => {
        this.filterTimer = null;
        this.applyFilter(); // 静默 150ms 后落最终值（trailing）
      }, 150);
    });
    filterWrap.appendChild(this.filterInput);
    this.container.appendChild(filterWrap);
    this.listHost = document.createElement('div');
    this.listHost.className = 'tree-list';
    this.container.appendChild(this.listHost);
    if (this.roots.length === 0) {
      // 空态（001 规则 25：无目录上下文时不列举任何文件）
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = t('tree.empty');
      this.listHost.appendChild(empty);
      return;
    }
    for (const root of this.roots) {
      const nodeKey = root.path;
      const rootNode = this.makeNode(nodeKey, root.label, true, 0, null);
      this.listHost.appendChild(rootNode);
      this.expanded.add(nodeKey);
      await this.expandInto(rootNode, nodeKey, 0);
    }
    this.applyFilter();
  }

  /** 重建（删除/新建/重命名文件后刷新用） */
  async refresh(roots?: TreeRoot[]): Promise<void> {
    if (roots) this.roots = roots;
    this.cache.clear();
    this.allRows = [];
    this.multiSel.clear();
    await this.render();
  }

  /**
   * 统一过滤（P2-17）：单一机制，渲染期生效。
   * - 文件行：按名命中显隐；
   * - 目录组：子树（已物化部分）内有命中则显示并自动展开，否则隐藏；
   *   目录名自身命中亦保留（便于定位未展开的目录）。
   * 懒加载限制：仅对已加载的行生效，不触发磁盘递归扫描（性能红线）。
   */
  private applyFilter(): void {
    const f = this.filter;
    if (!f) {
      for (const r of this.allRows) r.el.style.display = '';
      if (this.preFilterCollapsed) {
        for (const [path, g] of this.groupEls) {
          const collapsed = this.preFilterCollapsed.has(path);
          g.group.classList.toggle('collapsed', collapsed);
          g.row.querySelector('.tr-arrow')?.classList.toggle('collapsed', collapsed);
          if (collapsed) this.expanded.delete(path);
        }
        this.preFilterCollapsed = null;
      }
      return;
    }
    if (!this.preFilterCollapsed) {
      this.preFilterCollapsed = new Set(this.groupOrder.filter(path => {
        const g = this.groupEls.get(path)!;
        return g.group.classList.contains('collapsed') || !this.expanded.has(path);
      }));
    }
    for (const r of this.allRows) {
      if (!r.isDir) r.el.style.display = r.name.toLowerCase().includes(f) ? '' : 'none';
    }
    // 目录组自底向上：groupOrder 为创建序（父组创建必先于其子组），逆序即子先于父——
    // 每组只查 childRows 索引判断「有可见子行」，不再 querySelectorAll 全树遍历（perf Pass 1 FB）
    for (let i = this.groupOrder.length - 1; i >= 0; i--) {
      const path = this.groupOrder[i]!;
      const g = this.groupEls.get(path)!;
      const row = g.row;
      const kids = this.childRows.get(path);
      const anyVisible = !!kids && kids.some(k => (this.rowByKey.get(k)?.el.style.display ?? '') !== 'none');
      const name = (this.rowByKey.get(path)?.name ?? '').toLowerCase();
      row.style.display = anyVisible || name.includes(f) ? '' : 'none';
      if (anyVisible) {
        g.group.classList.remove('collapsed');
        row.querySelector('.tr-arrow')?.classList.remove('collapsed');
      }
    }
  }

  private nodePath(key: string, name: string): string {
    const sep = key.includes('\\') && !key.includes('/') ? '\\' : '/';
    return key.endsWith('/') || key.endsWith('\\') ? key + name : key + sep + name;
  }

  /** 高亮当前活动文件行（定稿 demo .tr.active；键 = 行 title 存的完整路径） */
  setActive(path: string | null): void {
    for (const r of this.allRows) r.el.classList.remove('active');
    if (!path) return;
    this.rowByKey.get(path)?.el.classList.add('active');
  }

  /**
   * 定位到文件（001 规则 25 目录跟随）：逐级展开祖先目录、滚动并高亮。
   * 返回 false 表示文件不在当前本地根之下（调用方据此换根重建后重试）；
   * 在根下则尽力而为（个别目录读取失败时仍返回 true，仅定位不到行）。
   */
  async reveal(filePath: string): Promise<boolean> {
    const root = this.roots[0];
    if (!root) return false;
    const segs = relativeToRoot(root.path, filePath);
    if (!segs || segs.length === 0) return false;
    // 清空过滤，避免目标行被过滤隐藏
    if (this.filter) {
      this.filter = '';
      this.filterInput.value = '';
      this.applyFilter();
    }
    let key = root.path;
    let depth = 0;
    for (let i = 0; i < segs.length - 1; i++) {
      key = this.nodePath(key, segs[i]!);
      depth += 1;
      const group = this.groupEls.get(key)?.group ?? null;
      if (!group) return true; // 祖先目录未物化（读取失败等）：尽力而为
      this.expanded.add(key);
      group.classList.remove('collapsed');
      group.querySelector(':scope > .tr .tr-arrow')?.classList.remove('collapsed');
      if (!group.querySelector(':scope > .tr-children')) {
        await this.expandInto(group, key, depth);
      }
    }
    const fileKey = this.nodePath(key, segs[segs.length - 1]!);
    const hit = this.rowByKey.get(fileKey);
    if (hit && !hit.isDir) {
      this.setActive(fileKey);
      hit.el.scrollIntoView({ block: 'nearest' });
    }
    return true;
  }

  /** 构造节点：目录返回 .tr-group（行 + 子容器），文件返回 .tr 行；parent=null 为根 */
  private makeNode(key: string, name: string, isDir: boolean, depth: number, parent: string | null): HTMLElement {
    const pad = 2 + depth * 18;
    const row = document.createElement('div');
    row.className = 'tr' + (isDir ? ' is-dir' : '');
    row.style.paddingLeft = `${pad}px`;
    row.title = key;
    const rec = { el: row, name, isDir, key };
    this.allRows.push(rec);
    this.rowByKey.set(key, rec);
    if (parent !== null) {
      const sibs = this.childRows.get(parent);
      if (sibs) sibs.push(key);
      else this.childRows.set(parent, [key]);
    }

    const arrow = document.createElement('span');
    arrow.className = 'tr-arrow';
    const icon = document.createElement('span');
    const label = document.createElement('span');
    label.className = 'tr-name';
    label.textContent = name;

    if (isDir) {
      arrow.innerHTML = SVG_ARROW;
      icon.className = 'tr-icon dir';
      icon.innerHTML = SVG_DIR;
      row.append(arrow, icon, label);
      row.addEventListener('click', e => {
        e.stopPropagation();
        void this.toggle(key, row);
      });
      row.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        this.actions.onContextDir?.(key, e.clientX, e.clientY);
      });
      const group = document.createElement('div');
      group.className = 'tr-group';
      group.dataset.path = key;
      group.appendChild(row);
      this.groupEls.set(key, { group, row });
      this.groupOrder.push(key);
      if (!this.childRows.has(key)) this.childRows.set(key, []);
      if (this.expanded.has(key)) group.appendChild(this.childrenHolder(key, pad));
      return group;
    }
    arrow.innerHTML = '';
    icon.className = 'tr-icon';
    icon.innerHTML = SVG_FILE;
    row.append(arrow, icon, label);
    const kind = kindOf(name);
    if (kind) row.dataset.kind = kind;
    row.addEventListener('click', e => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+点击多选（批 F #21）：不打开，切换选中态
        if (this.multiSel.has(key)) {
          this.multiSel.delete(key);
          row.classList.remove('msel');
        } else {
          this.multiSel.add(key);
          row.classList.add('msel');
        }
        return;
      }
      // 普通单击 = 打开：多选态随动作结束清空（验收缺陷 D4：残留 multiSel 使
      // 下次"比较选中文件"取到旧插入序前两个，打开了错误的一对）
      this.multiSel.clear();
      this.listHost.querySelectorAll('.msel').forEach(r => r.classList.remove('msel'));
      this.actions.onOpenFile(key);
    });
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      // 多于两个时取最近加入的一对（Set 插入序末两个），与用户"最后圈定的一对"直觉一致
      const arr = Array.from(this.multiSel);
      const sel = this.multiSel.has(key) && arr.length >= 2 ? arr.slice(-2) : undefined;
      this.actions.onContextFile?.(key, e.clientX, e.clientY, sel);
    });
    return row;
  }

  /** 子容器（带参考线 --gl）；层级：行缩进 pad，参考线 pad+14 */
  private childrenHolder(key: string, pad: number): HTMLDivElement {
    let holder = this.listHost.querySelector<HTMLDivElement>(
      `[data-children-of="${CSS.escape(key)}"]`
    );
    if (!holder) {
      holder = document.createElement('div');
      holder.className = 'tr-children';
      holder.dataset.childrenOf = key;
      holder.style.setProperty('--gl', `${pad + 14}px`);
    }
    return holder;
  }

  private async toggle(key: string, row: HTMLElement): Promise<void> {
    const group = row.closest('.tr-group');
    if (this.expanded.has(key)) {
      this.expanded.delete(key);
      group?.classList.add('collapsed');
      row.querySelector('.tr-arrow')?.classList.add('collapsed');
      return;
    }
    this.expanded.add(key);
    group?.classList.remove('collapsed');
    row.querySelector('.tr-arrow')?.classList.remove('collapsed');
    // 已有子容器说明子节点已物化，跳过 expandInto（避免重复追加行）
    if (group?.querySelector(':scope > .tr-children')) return;
    const depth = Math.max(0, Math.round((parseInt(row.style.paddingLeft, 10) - 2) / 18));
    await this.expandInto((group as HTMLElement | null) ?? row, key, depth);
  }

  private async expandInto(anchor: HTMLElement, key: string, depth: number): Promise<void> {
    const gen = this.renderGen; // 代际捕获：boot 双重建等并发场景下，迟到的续体其锚点已被新 render 清出 DOM
    let entries = this.cache.get(key);
    if (!entries) {
      this.cache.set(key, 'loading');
      try {
        entries = await listDir(key);
        this.cache.set(key, entries);
      } catch (err) {
        if (gen !== this.renderGen) return;
        this.cache.set(key, 'error');
        const errDiv = document.createElement('div');
        errDiv.className = 'tree-error';
        errDiv.textContent = tf('tree.readFail', String(err));
        this.appendChildren(anchor, key, [errDiv], depth);
        return;
      }
    }
    if (gen !== this.renderGen) return; // 弃置迟到行：挂到游离锚点会以影子行污染 allRows，setActive/reveal 的 find 会命中不可见行
    if (entries === 'loading' || entries === 'error') return;
    const frag = document.createDocumentFragment();
    for (const e of entries) {
      const childKey = this.nodePath(key, e.name);
      const node = this.makeNode(childKey, e.name, e.isDir, depth + 1, key);
      frag.appendChild(node);
    }
    this.appendChildren(anchor, key, [frag], depth);
    this.applyFilter(); // 统一过滤：新物化的子节点即时生效（P2-17）
  }

  private appendChildren(anchor: HTMLElement, key: string, nodes: Node[], depth: number): void {
    const row = anchor.classList?.contains('tr')
      ? anchor
      : (anchor.querySelector(':scope > .tr') as HTMLElement | null);
    const parent = row ?? anchor;
    const holder = this.childrenHolder(key, 2 + depth * 18);
    parent.insertAdjacentElement('afterend', holder);
    for (const n of nodes) holder.appendChild(n);
  }
}
