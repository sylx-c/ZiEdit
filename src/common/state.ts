// TabStore —— 标签页状态机（纯逻辑，持久化经构造注入，便于单测）
// 001 子 PRD：重复打开激活已有标签；会话序列化/恢复
import type { SessionState, TabState } from './ipc';

declare module './ipc' {
  interface TabState {
    /** 草稿正文随会话保存；真实文件不保存正文。 */
    draftContent?: string;
    /** 用户经视图菜单显式选择的路由（批 6 复验 L9）：重开/自动写入（回退、
     *  探测刷新）不得覆盖；随会话持久化。 */
    routeLocked?: boolean;
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
      const t = this.tabs[existing]!;
      // 批 5 缺陷修复：激活已存在标签时以**本次打开的探测路由**刷新——否则富预览
      // 一次回退（或旧会话污染）写入的 route 永久压过「Word 默认富预览」。
      // 路由变化才重置滚动（同路由激活保持位置）；语言不动（草稿格式切换走 setTabLanguage）。
      // 批 6 复验 L9：用户显式锁定（routeLocked）的路由不被探测刷新——修前无条件
      // 覆盖，用户选定的 text 投影重开即回 rich 且滚动清零。
      if (t.route !== tab.route && !t.routeLocked) {
        t.route = tab.route;
        t.scroll = 0;
      }
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

  /** 视图路由强制切换（菜单/工具栏"文本/图片"，001 规则 19）：路由变更触发重渲染。
   *  opts.lock = 用户显式选择（视图菜单）：写入并标记 routeLocked，且不受既有
   *  锁限制；无 opts = 自动写入（富预览回退等）——已锁定的路由让位不写。 */
  setRoute(path: string, route: TabState['route'], opts?: { lock?: boolean }): void {
    const t = this.tabs.find(t => t.path === normalizePath(path));
    if (!t) return;
    if (t.routeLocked && !opts?.lock) return;
    // 锁先落状态再持久化：修前 emit() 发生在写锁之前，会话快照里没有 routeLocked；
    // 路由未变时也不触发任何持久化（审查 H1 的 TS 侧）
    const newlyLocked = opts?.lock === true && t.routeLocked !== true;
    if (newlyLocked) t.routeLocked = true;
    if (t.route !== route) {
      t.route = route;
      t.scroll = 0;
      this.emit();
    } else if (newlyLocked) {
      this.saveHandler?.(this.session()); // 仅锁状态变化：免重渲染，直接存盘
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
   *  静默丢弃）；(2026-10-29 ac-011) 保留 pdf，未知路由值按 text 收编。 */
  restore(s: SessionState | null | undefined): number {
    if (!s || !Array.isArray(s.tabs)) return 0;
    const valid = s.tabs.filter(t => t && typeof t.path === 'string' && typeof t.route === 'string');
    this.tabs = valid.map(t => {
      let draft = t.path.startsWith('draft://') && typeof t.draftContent === 'string'
        ? t.draftContent : undefined;
      // SEC-13：与编辑缓冲 10MB 上限自动转查看态一致，恢复草稿不得绕过上限。
      if (draft !== undefined && draft.length > 10 * 1024 * 1024) {
        console.warn('Discarding session draft exceeding the 10MB editing limit');
        draft = '';
      }
      return {
      path: normalizePath(t.path),
      route: t.route === 'image' || t.route === 'pdf' || t.route === 'rich' ? t.route : 'text',
      routeLocked: t.routeLocked === true ? true : undefined,
      language: t.language ?? null,
      scroll: typeof t.scroll === 'number' ? t.scroll : 0,
      ...(draft !== undefined ? { draftContent: draft } : {}),
      bookmarks: Array.isArray(t.bookmarks)
        ? t.bookmarks.filter(b => typeof b === 'number' && b > 0)
        : [],
      };
    });
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
