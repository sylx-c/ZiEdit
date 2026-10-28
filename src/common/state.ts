// TabStore —— 标签页状态机（纯逻辑，持久化经构造注入，便于单测）
// 001 子 PRD：重复打开激活已有标签；会话序列化/恢复
import type { SessionState, TabState } from './ipc';

declare module './ipc' {
  interface TabState {
    /** 草稿正文随会话保存；真实文件不保存正文。 */
    draftContent?: string;
  }
}

export type OpenResult = 'new' | 'activated';

/** 路径归一化：统一分隔符，避免树（反斜杠）与旧会话（混合）判定为不同文件 */
function normalizePath(p: string): string {
  if (/^[A-Za-z]:[\\/]/.test(p)) return p.replace(/\//g, '\\');
  return p;
}

export class TabStore {
  tabs: TabState[] = [];
  activeIndex = 0;
  private saveHandler?: (s: SessionState) => void;
  private notifyChanged?: () => void;

  constructor(opts?: { onSave?: (s: SessionState) => void; onChanged?: () => void }) {
    this.saveHandler = opts?.onSave;
    this.notifyChanged = opts?.onChanged;
  }

  /** 打开（或激活已存在）标签 —— 001-AC-2。
   *  null = 决策挂起（shell 层把它包装为「离开 IR 的三键确认」入口：确认未定时不得变更状态）。 */
  open(tab: TabState): OpenResult | null {
    const path = normalizePath(tab.path);
    tab = { ...tab, path };
    const existing = this.tabs.findIndex(t => t.path === path);
    if (existing >= 0) {
      this.activeIndex = existing;
      this.emit();
      return 'activated';
    }
    this.tabs.push(tab);
    this.activeIndex = this.tabs.length - 1;
    this.emit();
    return 'new';
  }

  close(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    this.tabs.splice(index, 1);
    if (this.tabs.length === 0) {
      this.activeIndex = 0;
    } else if (this.activeIndex >= this.tabs.length) {
      this.activeIndex = this.tabs.length - 1;
    } else if (index < this.activeIndex) {
      this.activeIndex -= 1;
    }
    this.emit();
  }

  /** 按 path 关闭（P0-2/Z2-31）：关闭守卫的确认是异步对话框，期间标签数组可能变动——
   *  确认时按 path 重解索引，保证「确认谁关谁」；path 已不在（被其它路径关闭）则空操作。 */
  closeByPath(path: string): boolean {
    const i = this.tabs.findIndex(t => t.path === path);
    if (i < 0) return false;
    this.close(i);
    return true;
  }

  activate(index: number): void {
    if (index >= 0 && index < this.tabs.length && index !== this.activeIndex) {
      this.activeIndex = index;
      this.emit();
    }
  }

  active(): TabState | null {
    return this.tabs[this.activeIndex] ?? null;
  }

  /** 更新标签滚动位置：只触发持久化，不触发界面重渲染 */
  setScroll(path: string, scroll: number): void {
    const t = this.tabs.find(t => t.path === path);
    if (t && t.scroll !== scroll) {
      t.scroll = scroll;
      this.saveHandler?.(this.session());
    }
  }

  /** 更新书签（002 规则 9：随会话保存）：只触发持久化 */
  setBookmarks(path: string, bookmarks: number[]): void {
    const t = this.tabs.find(t => t.path === path);
    if (t) {
      const next = [...bookmarks].sort((a, b) => a - b);
      if (JSON.stringify(t.bookmarks ?? []) !== JSON.stringify(next)) {
        t.bookmarks = next;
        this.saveHandler?.(this.session());
      }
    }
  }

  /** 视图路由强制切换（菜单/工具栏"文本/图片"，001 规则 19）：路由变更触发重渲染 */
  setRoute(path: string, route: 'text' | 'image'): void {
    const t = this.tabs.find(t => t.path === normalizePath(path));
    if (t && t.route !== route) {
      t.route = route;
      t.scroll = 0;
      this.emit();
    }
  }

  /** 更新标签语言；草稿格式切换会触发重渲染，自动与空值归一为无语言。 */
  setTabLanguage(path: string, language: string | null): void {
    const t = this.tabs.find(t => t.path === normalizePath(path));
    const next = !language || language === 'auto' ? null : language;
    if (t && t.language !== next) {
      t.language = next;
      this.emit();
    }
  }

  /** 标签拖拽排序（001 v0.6：定稿卡片标签行为）：移动后保持激活标签跟随 */
  move(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.tabs.length || to >= this.tabs.length) return;
    const active = this.active();
    const [t] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, t);
    this.activeIndex = active ? Math.max(0, this.tabs.indexOf(active)) : 0;
    this.emit();
  }

  /** 文件/目录改名后迁移已打开标签，保留标签身份、顺序和状态。 */
  renamePath(from: string, to: string): void {
    from = normalizePath(from);
    to = normalizePath(to);
    for (const tab of this.tabs) {
      if (tab.path === from || tab.path.startsWith(from + '\\') || tab.path.startsWith(from + '/')) {
        tab.path = to + tab.path.slice(from.length);
      }
    }
    this.emit();
  }

  session(): SessionState {
    return { tabs: this.tabs.map(t => ({ ...t })), activeIndex: this.activeIndex };
  }

  /** 恢复会话 —— 001-AC-3：返回恢复的标签数（非法输入恢复 0 个）。
   *  规则 5「打开的标签列表」不挑路由（F001-02：修前漏 image，图片标签重启即被
   *  静默丢弃）；image 之外的任何路由值一律按 text 收编。 */
  restore(s: SessionState | null | undefined): number {
    if (!s || !Array.isArray(s.tabs)) return 0;
    const valid = s.tabs.filter(t => t && typeof t.path === 'string' && typeof t.route === 'string');
    this.tabs = valid.map(t => ({
      path: normalizePath(t.path),
      route: t.route === 'image' ? 'image' : 'text',
      language: t.language ?? null,
      scroll: typeof t.scroll === 'number' ? t.scroll : 0,
      ...(t.path.startsWith('draft://') && typeof t.draftContent === 'string'
        ? { draftContent: t.draftContent } : {}),
      bookmarks: Array.isArray(t.bookmarks)
        ? t.bookmarks.filter(b => typeof b === 'number' && b > 0)
        : [],
    }));
    this.activeIndex =
      typeof s.activeIndex === 'number' && s.activeIndex >= 0 && s.activeIndex < this.tabs.length
        ? s.activeIndex
        : 0;
    this.emit();
    return this.tabs.length;
  }

  private emit(): void {
    this.notifyChanged?.();
    this.saveHandler?.(this.session());
  }
}
