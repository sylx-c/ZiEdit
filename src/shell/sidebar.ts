// sidebar —— 侧栏信息架构（001 规则 20 v1.1：[文件][大纲][最近][收藏] 四页签 + 面板头 ˅/×）
// 大纲页签置灰规则见 006 规则 6；最近面板支持单条 ×/批量勾选/清空；收藏面板支持当前文件直接收藏与分组。
import { icon } from './chrome';
import { L } from './chrome';
import { t, tf } from '../common/i18n';

export type SidebarPane = 'files' | 'outline' | 'recent' | 'fav';

export interface RecentItem {
  path: string;
  isDir: boolean;
}

export interface FavGroupData {
  name: string;
  items: RecentItem[];
}

export interface SidebarOpts {
  /** 大纲是否可用于当前标签（006 规则 6：TXT/CSV 等置灰） */
  outlineAvailable: () => boolean;
  /** 渲染大纲内容到宿主（文件树切换回来时清空） */
  renderOutline: (host: HTMLElement) => void;
  onOpenPath: (path: string, isDir: boolean) => void;
  /** 返回上级文件夹（文件树重根；盘符根/无根时由 app 侧守卫，按钮由 app 控制可见性） */
  onUpRoot?: () => void;
  onHide: () => void;
  /** 最近：单条/批量移除与清空 */
  onRemoveRecents: (paths: string[]) => void;
  onClearRecents: () => void;
  /** 收藏：星标切换 / 收藏当前文件 / 分组管理 */
  onToggleFavorite: (path: string) => void;
  onFavoriteCurrent: () => void;
  onAddGroup: (name: string) => void;
  onRemoveGroup: (name: string) => void;
  onMoveFavorite: (path: string, group: string | null) => void;
  /** 统一右键菜单（app 侧实现） */
  showMenu: (items: Array<[string, () => void]>, x: number, y: number) => void;
  /** 文本输入对话框（Tauri webview 无 window.prompt，由 app 侧 dlgPrompt 提供） */
  promptText: (msg: string) => Promise<string | null>;
}

const SVG_X = '<svg class="ic s10" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const SVG_CHEVRON = '<svg class="ic s10" viewBox="0 0 16 16"><path d="M3.6 6l4.4 4.4L12 6"/></svg>';
const SVG_UP = '<svg class="ic s10" viewBox="0 0 16 16"><path d="M8 12.5V4M4.2 7.8L8 4l3.8 3.8"/></svg>';

export class SidebarCtl {
  readonly filesHost: HTMLElement; // 文件树挂载点（FileTree 宿主）
  /** 返回上级文件夹按钮（2026-10 反馈：树根随文件钻入子目录后无返回入口）；可见性由 app 侧控制 */
  readonly upRootBtn: HTMLButtonElement;
  private outlineHost: HTMLElement;
  private recentHost: HTMLElement;
  private favHost: HTMLElement;
  private seg: HTMLElement;
  private body: HTMLElement;
  private tabFiles!: HTMLButtonElement;
  private tabOutline!: HTMLButtonElement;
  private tabRecent!: HTMLButtonElement;
  private tabFav!: HTMLButtonElement;
  private pane: SidebarPane = 'files';
  /** 面板一次只露两页签：左 [文件,大纲] / 右 [最近,收藏]；⇄ 切换两套 */
  private side: 'left' | 'right' = 'left';
  private recents: RecentItem[] = [];
  private favPaths: ReadonlySet<string> = new Set();
  private favUngrouped: RecentItem[] = [];
  private favGroups: FavGroupData[] = [];
  private manageMode = false; // 最近面板批量管理模式
  private checked = new Set<string>(); // 管理模式勾选
  private collapsedGroups = new Set<string>();

  constructor(
    container: HTMLElement,
    private opts: SidebarOpts
  ) {
    container.innerHTML = '';
    // ---- 面板头：标题 + ˅ 折叠 + × 关闭（定稿 demo） ----
    const head = document.createElement('div');
    head.className = 'panel-head';
    const title = document.createElement('span');
    title.className = 'panel-title';
    title.textContent = L('sidebar.title');
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'pa-btn pa-collapse';
    collapseBtn.title = L('sidebar.collapse');
    collapseBtn.innerHTML = SVG_CHEVRON;
    collapseBtn.addEventListener('click', () => {
      const collapsed = container.classList.toggle('collapsed');
      collapseBtn.title = L(collapsed ? 'sidebar.expand' : 'sidebar.collapse');
    });
    const closeBtn = document.createElement('button');
    closeBtn.className = 'pa-btn';
    closeBtn.title = L('sidebar.close');
    closeBtn.innerHTML = SVG_X;
    closeBtn.addEventListener('click', opts.onHide);
    // 返回上级文件夹（2026-10 反馈）：树根随打开文件钻入子目录后，面板内原本没有任何返回入口
    this.upRootBtn = document.createElement('button');
    this.upRootBtn.className = 'pa-btn pa-up';
    this.upRootBtn.title = L('sidebar.upRoot');
    this.upRootBtn.innerHTML = SVG_UP;
    this.upRootBtn.style.display = 'none'; // 默认隐藏，app 侧在 rebuildTree 按可上行性控制
    this.upRootBtn.addEventListener('click', () => opts.onUpRoot?.());
    head.append(title, this.upRootBtn, collapseBtn, closeBtn);
    container.appendChild(head);

    // ---- 页签行：左右两套页签按 side 切换；末尾 ⇄ 整体翻转（设计 demo 图1）----
    this.seg = document.createElement('div');
    this.seg.className = 'panel-seg';
    this.tabFiles = this.makeTab(L('sidebar.files'), 'files');
    this.tabOutline = this.makeTab(L('sidebar.outline'), 'outline');
    this.tabRecent = this.makeTab(L('sidebar.recent'), 'recent');
    this.tabFav = this.makeTab(L('sidebar.favorites'), 'fav');
    const swapBtn = document.createElement('button');
    swapBtn.className = 'sidebar-swap';
    swapBtn.title = L('sidebar.swap');
    swapBtn.innerHTML = '<svg class="ic s10" viewBox="0 0 16 16"><path d="M3 5.4h8.6"/><path class="solid" d="M11.4 3.2l2.4 2.2-2.4 2.2z"/><path class="sec" d="M13 10.6H4.4"/><path class="solid" d="M4.6 8.4l-2.4 2.2 2.4 2.2z"/></svg>';
    swapBtn.addEventListener('click', () => this.swapSide());
    this.seg.append(this.tabFiles, this.tabOutline, this.tabRecent, this.tabFav, swapBtn);
    container.appendChild(this.seg);

    // ---- 主体 ----
    this.body = document.createElement('div');
    this.body.className = 'sidebar-body';
    const mainPane = document.createElement('div');
    this.filesHost = document.createElement('div');
    this.outlineHost = document.createElement('div');
    this.outlineHost.style.display = 'none';
    mainPane.append(this.filesHost, this.outlineHost);
    this.recentHost = document.createElement('div');
    this.recentHost.style.display = 'none';
    this.favHost = document.createElement('div');
    this.favHost.style.display = 'none';
    this.body.append(mainPane, this.recentHost, this.favHost);
    container.appendChild(this.body);

    this.apply();
  }

  private makeTab(label: string, pane: SidebarPane): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'sidebar-tab';
    b.textContent = label;
    b.addEventListener('click', () => this.show(pane));
    return b;
  }

  show(pane: SidebarPane): void {
    if (pane === 'outline' && !this.opts.outlineAvailable()) return; // 置灰不可点
    this.pane = pane;
    // 把 pane 也归到当前 side（与显示页签保持一致）
    this.side = pane === 'recent' || pane === 'fav' ? 'right' : 'left';
    this.apply();
    if (pane === 'outline') this.opts.renderOutline(this.outlineHost);
  }

  /** 整体翻面：左[文件,大纲] ⇄ 右[最近,收藏]；若当前 pane 不在新侧则落到该侧第一项 */
  swapSide(): void {
    if (this.side === 'left') {
      this.side = 'right';
      if (this.pane !== 'recent' && this.pane !== 'fav') this.pane = 'recent';
    } else {
      this.side = 'left';
      if (this.pane !== 'files' && this.pane !== 'outline') this.pane = 'files';
      // 大纲置灰时落回文件
      if (this.pane === 'outline' && !this.opts.outlineAvailable()) this.pane = 'files';
    }
    this.apply();
    if (this.pane === 'outline') this.opts.renderOutline(this.outlineHost);
    if (this.pane === 'recent') this.renderRecent();
    if (this.pane === 'fav') this.renderFav();
  }

  /** 当前标签变化后刷新大纲可用性与内容 */
  refreshOutlineState(): void {
    this.apply();
    if (this.pane === 'outline') {
      if (this.opts.outlineAvailable()) this.opts.renderOutline(this.outlineHost);
      else this.show('files');
    }
  }

  isOutlineShown(): boolean {
    return this.pane === 'outline';
  }

  /** 大纲宿主（app 在 WYSIWYG 标题树变化时局部刷新用） */
  get outlineHostEl(): HTMLElement {
    return this.outlineHost;
  }

  /** 推数据渲染最近面板（favPaths 用于行尾星标状态） */
  setRecentData(recents: RecentItem[], favPaths?: ReadonlySet<string>): void {
    this.recents = recents;
    this.favPaths = favPaths ?? new Set();
    if (this.pane === 'recent') this.renderRecent();
  }

  /** 推数据渲染收藏面板（未分组 + 分组） */
  setFavData(ungrouped: RecentItem[], groups: FavGroupData[]): void {
    this.favUngrouped = ungrouped;
    this.favGroups = groups;
    if (this.pane === 'fav') this.renderFav();
  }

  // ---- 最近面板：单条 × / 批量管理 / 清空 ----
  private renderRecent(): void {
    const host = this.recentHost;
    host.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'rc-toolbar';
    const manageBtn = document.createElement('button');
    manageBtn.className = 'rc-tool' + (this.manageMode ? ' on' : '');
    manageBtn.textContent = this.manageMode ? t('sb.exitManage') : t('sb.manage');
    manageBtn.addEventListener('click', () => {
      this.manageMode = !this.manageMode;
      this.checked.clear();
      this.renderRecent();
    });
    const clearBtn = document.createElement('button');
    clearBtn.className = 'rc-tool';
    clearBtn.textContent = t('sb.clear');
    clearBtn.title = t('sb.clearTip');
    clearBtn.addEventListener('click', () => this.opts.onClearRecents());
    bar.append(manageBtn, clearBtn);
    if (this.manageMode) {
      const delSel = document.createElement('button');
      delSel.className = 'rc-tool danger';
      delSel.textContent = tf('sb.delSel', this.checked.size);
      delSel.addEventListener('click', () => {
        if (this.checked.size) this.opts.onRemoveRecents([...this.checked]);
        this.checked.clear();
        this.manageMode = false;
      });
      bar.appendChild(delSel);
    }
    host.appendChild(bar);

    if (this.recents.length === 0) {
      const e = document.createElement('div');
      e.className = 'rc-empty';
      e.textContent = t('sb.noRecent');
      host.appendChild(e);
      return;
    }
    for (const r of this.recents) host.appendChild(this.recentRow(r));
  }

  private recentRow(item: RecentItem): HTMLElement {
    const r = this.baseRow(item);
    if (this.manageMode) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.checked.has(item.path);
      cb.addEventListener('click', e => {
        e.stopPropagation();
        if (cb.checked) this.checked.add(item.path);
        else this.checked.delete(item.path);
        this.renderRecent();
      });
      r.prepend(cb);
      r.addEventListener('click', () => {
        cb.checked = !cb.checked;
        if (cb.checked) this.checked.add(item.path);
        else this.checked.delete(item.path);
        this.renderRecent();
      });
      return r;
    }
    const star = document.createElement('button');
    star.className = 'rc-fav' + (this.favPaths.has(item.path) ? ' on' : '');
    star.title = this.favPaths.has(item.path) ? t('sb.unfav') : t('sb.fav');
    star.innerHTML = icon('star', 's12');
    star.addEventListener('click', e => {
      e.stopPropagation();
      this.opts.onToggleFavorite(item.path);
    });
    const del = document.createElement('button');
    del.className = 'rc-del';
    del.title = t('sb.removeRec');
    del.innerHTML = SVG_X;
    del.addEventListener('click', e => {
      e.stopPropagation();
      this.opts.onRemoveRecents([item.path]);
    });
    r.append(star, del);
    r.addEventListener('click', () => this.opts.onOpenPath(item.path, item.isDir));
    return r;
  }

  // ---- 收藏面板：直接收藏当前文件 / 分组 ----
  private renderFav(): void {
    const host = this.favHost;
    host.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'rc-toolbar';
    const addCur = document.createElement('button');
    addCur.className = 'rc-tool';
    addCur.textContent = t('sb.favCurrent');
    addCur.addEventListener('click', () => this.opts.onFavoriteCurrent());
    const addGrp = document.createElement('button');
    addGrp.className = 'rc-tool';
    addGrp.textContent = t('sb.newGroup');
    addGrp.addEventListener('click', () => {
      void this.opts.promptText(t('sb.groupName')).then(name => {
        if (name?.trim()) this.opts.onAddGroup(name.trim());
      });
    });
    bar.append(addCur, addGrp);
    host.appendChild(bar);

    if (this.favUngrouped.length === 0 && this.favGroups.length === 0) {
      const e = document.createElement('div');
      e.className = 'rc-empty';
      e.textContent = t('sb.noFav');
      host.appendChild(e);
      return;
    }
    for (const g of this.favGroups) host.appendChild(this.groupBlock(g));
    if (this.favUngrouped.length) {
      const s = document.createElement('div');
      s.className = 'rc-section';
      s.innerHTML = icon('star', 's12');
      s.appendChild(document.createTextNode(this.favGroups.length ? t('sb.ungrouped') : t('sb.favorites')));
      host.appendChild(s);
      for (const it of this.favUngrouped) host.appendChild(this.favRow(it, null));
    }
  }

  private groupBlock(g: FavGroupData): HTMLElement {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'rc-section rc-group';
    const arrow = document.createElement('span');
    arrow.className = 'tr-arrow' + (this.collapsedGroups.has(g.name) ? ' collapsed' : '');
    arrow.innerHTML = '<svg class="ic s12" viewBox="0 0 16 16"><path d="M6 3.6l4.4 4.4L6 12.4"/></svg>';
    head.appendChild(arrow);
    head.insertAdjacentHTML('beforeend', icon('folder', 's12'));
    head.appendChild(document.createTextNode(tf('sb.groupNameCount', g.name, g.items.length)));
    const del = document.createElement('button');
    del.className = 'rc-del';
    del.title = t('sb.disband');
    del.innerHTML = SVG_X;
    del.addEventListener('click', e => {
      e.stopPropagation();
      this.opts.onRemoveGroup(g.name);
    });
    head.appendChild(del);
    head.addEventListener('click', () => {
      if (this.collapsedGroups.has(g.name)) this.collapsedGroups.delete(g.name);
      else this.collapsedGroups.add(g.name);
      this.renderFav();
    });
    wrap.appendChild(head);
    if (!this.collapsedGroups.has(g.name)) {
      for (const it of g.items) {
        const row = this.favRow(it, g.name);
        row.style.paddingLeft = '22px';
        wrap.appendChild(row);
      }
    }
    return wrap;
  }

  private favRow(item: RecentItem, group: string | null): HTMLElement {
    const r = this.baseRow(item);
    const star = document.createElement('button');
    star.className = 'rc-fav on';
    star.title = t('sb.unfav');
    star.innerHTML = icon('star', 's12');
    star.addEventListener('click', e => {
      e.stopPropagation();
      this.opts.onToggleFavorite(item.path);
    });
    r.appendChild(star);
    r.addEventListener('click', () => this.opts.onOpenPath(item.path, item.isDir));
    r.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      const items: Array<[string, () => void]> = this.favGroups
        .filter(g => g.name !== group)
        .map(g => [tf('sb.moveTo', g.name), () => this.opts.onMoveFavorite(item.path, g.name)]);
      if (group) items.push([t('sb.moveOut'), () => this.opts.onMoveFavorite(item.path, null)]);
      items.push([t('sb.unfav'), () => this.opts.onToggleFavorite(item.path)]);
      this.opts.showMenu(items, e.clientX, e.clientY);
    });
    return r;
  }

  private baseRow(item: RecentItem): HTMLElement {
    const r = document.createElement('div');
    r.className = 'rc-row';
    r.title = item.path;
    const ic = document.createElement('span');
    ic.className = 'rc-icon' + (item.isDir ? ' dir' : '');
    ic.innerHTML = item.isDir ? icon('folder', 's14') : icon('newFile', 's14');
    const name = document.createElement('span');
    name.className = 'rc-name';
    name.textContent = item.path.replace(/\\/g, '/').split('/').pop() ?? item.path;
    r.append(ic, name);
    return r;
  }

  private apply(): void {
    const avail = this.opts.outlineAvailable();
    // 只露当前 side 的两页签；另一对隐藏
    const showLeft = this.side === 'left';
    this.tabFiles.style.display = showLeft ? '' : 'none';
    this.tabOutline.style.display = showLeft ? '' : 'none';
    this.tabRecent.style.display = showLeft ? 'none' : '';
    this.tabFav.style.display = showLeft ? 'none' : '';
    this.tabFiles.classList.toggle('active', this.pane === 'files');
    this.tabOutline.classList.toggle('active', this.pane === 'outline');
    this.tabRecent.classList.toggle('active', this.pane === 'recent');
    this.tabFav.classList.toggle('active', this.pane === 'fav');
    this.tabOutline.classList.toggle('disabled', !avail);
    this.tabOutline.title = avail ? '' : t('sidebar.noOutline');
    const mainPane = this.filesHost.parentElement!;
    mainPane.style.display = this.pane === 'files' || this.pane === 'outline' ? '' : 'none';
    // 大纲页签激活时隐藏文件树（文件/大纲共用 mainPane，互斥展示，001 规则 20）
    this.filesHost.style.display = this.pane === 'files' ? '' : 'none';
    this.recentHost.style.display = this.pane === 'recent' ? '' : 'none';
    this.favHost.style.display = this.pane === 'fav' ? '' : 'none';
    if (this.pane !== 'outline') this.outlineHost.style.display = 'none';
    else if (avail) this.outlineHost.style.display = '';
    if (this.pane === 'recent') this.renderRecent();
    if (this.pane === 'fav') this.renderFav();
  }
}
