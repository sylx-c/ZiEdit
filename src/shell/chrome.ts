// chrome —— 定稿窗口 chrome 部件：动作注册表 / 菜单栏 / 工具栏 / 命令面板 / 主题 / 对话框
// （001 v0.6 规则 19-24，视觉与交互规格 docs/design/app/；决策 009）
// 约定：命令与菜单、工具栏、快捷键同源（ActionRegistry 单一事实来源）。

import { dict, t, tf } from '../common/i18n';
import { isCompositionKey } from './composition-key';

// 文案本地化：label 若是 i18n key 则翻译，否则原样返回。
// 这样 ActionDef.label 既可传 key 走多语言，也可传纯文本（如动态文件名）。
//
// 判据取自字典本身（键在 zh-CN/en-US 字典里就是 key），不再用「前缀白名单」：
// 白名单天然随命名空间漂移——H-6f 查实旧白名单 (act|menu|tb|ed|sidebar|st|cmd|common)
// 漏了 md.*，八个 Markdown 格式钮的悬停提示一路显示裸 key（title="md.bold"），
// 而它们可见文字走 short（tb.mdCode 等，恰在白名单内）因而是译好的，缺陷只在 title 上现形。
// 字典裁决没有这个缺口：新增命名空间无需再改本函数，且「缺 key」在 t() 里同样原样返回。
function isI18nKey(label: string): boolean {
  return label in dict('zh-CN') || label in dict('en-US');
}

export function L(label: string | undefined): string {
  if (!label) return '';
  // 动态会话：恢复会话：<名称>
  if (label.startsWith('act.restoreSession:')) {
    return tf('act.restoreSessionOf', label.slice('act.restoreSession:'.length));
  }
  return isI18nKey(label) ? t(label) : label;
}

// ── 图标库（定稿 16×16 网格，data 见 docs/design/app demo） ──
// H-2 重绘（审计 §3.1）：编辑/格式化/换行/文字/文本视图/列模式六枚改直角几何 + miter 连接，
// 不再引入斜线/弧线；实物工具语义保留（编辑=文档+光标、格式化=缩进阶梯、换行=直角折返）。
export const ICONS = {
  // 粗竖 + 阶梯双碗：右缘在腰部收进，避免读成表格网格。
  bold: '<path class="solid" d="M3 2h3v12H3z"/><path d="M6 3h4v1h1v2h-1v1H6M6 8h5v1h1v3h-1v1H6"/>',
  italic: '<path d="M6 2h7M3 14h7M10 2L6 14"/>',
  strike: '<path d="M12 3H5v1H4v2h1v1h6v2h1v3h-1v1H4"/><path class="sec" d="M2 8h12"/>',
  inlineCode: '<path d="M5 4L1 8l4 4M11 4l4 4-4 4M9 2L7 14"/>',
  codeBlock: '<path d="M2 2h12v12H2zM6 6L4 8l2 2M10 6l2 2-2 2"/>',
  link: '<path d="M7 5V2h7v7h-3M9 11v3H2V7h3M5 11l6-6"/>',
  table: '<path d="M2 2h12v12H2zM2 6h12M2 10h12M6 2v12M10 2v12"/>',
  heading: '<path d="M3 2v12M11 2v12M3 8h8M13 10h2v4"/>',
  tableRow: '<path d="M2 2h12v12H2zM2 6h12M2 10h12"/><path class="sec" d="M8 2v12"/>',
  tableColumn: '<path d="M2 2h12v12H2zM6 2v12M10 2v12"/><path class="sec" d="M2 8h12"/>',
  arrowUp: '<path d="M8 14V2M3 7l5-5 5 5"/>',
  arrowDown: '<path d="M8 2v12M3 9l5 5 5-5"/>',
  arrowLeft: '<path d="M14 8H2M7 3L2 8l5 5"/>',
  arrowRight: '<path d="M2 8h12M9 3l5 5-5 5"/>',
  newFile: '<path class="body" d="M4 1.8h5.2L13 5.6v8.6H4z"/><path class="solid" d="M9.2 1.8v3.8H13z"/><path class="sec" d="M6.4 8.2h3.2M6.4 10.4h3.2"/>',
  open: '<path class="body" d="M1.8 3.8h4.8l1.5 2h6.1v8.4H1.8z"/><path class="sec" d="M1.8 7.2h12.4"/>',
  save: '<path class="body" d="M2.4 2.4h8.6l2.6 2.6v8.6H2.4z"/><path class="solid" d="M5.2 2.4h5.4v3.4H5.2z"/><path class="sec" d="M4.6 13.6V9.4h6.8v4.2"/>',
  saveAs: '<path class="body" d="M2.4 2.4h8.6l2.6 2.6v8.6H2.4z"/><path class="solid" d="M5.2 2.4h5.4v3.4H5.2z"/><path class="sec" d="M4.6 13.6V9.4h4.4"/><path class="solid" d="M9.6 13.8l3-3 1.6 1.6-3 3h-1.6z"/>',
  undo: '<path class="solid" d="M6.8 2.4L2.4 6.6l4.4 4.2z"/><path d="M2.6 6.6h6.6a3.8 3.8 0 010 7.6H6.2"/>',
  redo: '<path class="solid" d="M9.2 2.4l4.4 4.2-4.4 4.2z"/><path d="M13.4 6.6H6.8a3.8 3.8 0 000 7.6h3"/>',
  cut: '<circle cx="4.2" cy="4.2" r="1.9"/><circle cx="4.2" cy="11.8" r="1.9"/><path class="sec" d="M5.7 5.4L13.8 12.2M5.7 10.6L13.8 3.8"/>',
  copy: '<path class="sec" d="M5.8 1.8h6.4v8.6H5.8z"/><path class="body" d="M3.8 5.6h6.4v8.6H3.8z"/>',
  paste: '<path class="body" d="M3 3.4h10v10.8H3z"/><path class="solid" d="M6 1.8h4v2.6H6z"/><path class="sec" d="M5.4 7.4h5.2M5.4 9.8h5.2M5.4 12.2h3.4"/>',
  find: '<circle class="body" cx="6.8" cy="6.8" r="4.2"/><path class="handle" d="M10.2 10.2L14 14"/>',
  replace: '<path d="M2.4 5.4h9.2"/><path class="solid" d="M11.4 3.2l2.4 2.2-2.4 2.2z"/><path class="sec" d="M13.6 10.6H4.4"/><path class="solid" d="M4.6 8.4l-2.4 2.2 2.4 2.2z"/>',
  goto: '<path class="sec" d="M2.2 3.4h11.6M2.2 7h11.6M2.2 10.6h6.2"/><path d="M12 9.2v4.6"/><path class="solid" d="M10.2 12l1.8 2.2 1.8-2.2z"/>',
  text: '<path class="body" d="M2.6 2.6h10.8v10.8H2.6z"/><path class="sec" d="M5 6h6M5 9.4h4.2"/>',
  grid: '<path d="M2.4 3.4h11.2v9.2H2.4z"/><path class="sec" d="M2.4 8h11.2M6.1 3.4v9.2M9.9 3.4v9.2"/>',
  column: '<path class="body" d="M3.2 2.6h3.6v10.8H3.2z"/><path class="sec" d="M8.4 3.6h4M8.4 6.2h3M8.4 8.8h4M8.4 11.4h3"/>',
  cmd: '<path d="M2.8 4.6l3.6 3.4-3.6 3.4"/><path class="sec" d="M8.6 12.4h4.6"/>',
  theme: '<circle cx="8" cy="8" r="5.4"/><path class="fill" d="M8 2.6a5.4 5.4 0 010 10.8z"/>',
  folder: '<path d="M1.9 3.9h4.7l1.5 1.9h6v8.3H1.9z"/><path class="sec" d="M1.9 7.1h12.2"/>',
  star: '<path d="M8 1.8l1.9 4 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2.1.7-4.3-3.1-3 4.3-.6z"/>',
  clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.6V8l2.4 1.6"/>',
  swap: '<path d="M3 5.4h8.6"/><path class="solid" d="M11.4 3.2l2.4 2.2-2.4 2.2z"/><path class="sec" d="M13 10.6H4.4"/><path class="solid" d="M4.6 8.4l-2.4 2.2 2.4 2.2z"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path class="sec" d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/>',
  // 视图模式/装饰图标（2026-10-14 整改：原先共用 text/find，命令面板不可辨）
  mdSource: '<path class="body" d="M4.2 1.9h5l3.2 3.1v9.1H4.2z"/><path class="fold" d="M9.2 1.9v3.1h3.2z"/><path class="sec" d="M6.2 8.8l-1.4 1.4 1.4 1.4M9.2 8.8l1.4 1.4-1.4 1.4"/>',
  mdSplit: '<path d="M2.2 3h11.6v10H2.2z"/><path class="sec" d="M8 3v10"/><path class="body" d="M3.4 5.4h3M3.4 7.4h2.2M9.2 5.4h3M9.2 7.4h2.2M9.2 9.4h2"/>',
  mdPreview: '<path class="body" d="M4.2 1.9h5l3.2 3.1v9.1H4.2z"/><path class="fold" d="M9.2 1.9v3.1h3.2z"/><path class="sec" d="M6 8.4h4M6 10.2h4"/><path class="solid" d="M6 12.4h2.6"/>',
  mdWysiwyg: '<path class="body" d="M4.2 1.9h5l3.2 3.1v9.1H4.2z"/><path class="fold" d="M9.2 1.9v3.1h3.2z"/><path class="sec" d="M6 8h3.6M6 10h2.2"/><path class="sec" d="M7.6 12.6l3.8-3.8 1.6 1.6-3.8 3.8-2 .6z"/>',
  minimap: '<path d="M2.4 3.2h7.2v9.6H2.4z"/><path class="sec" d="M3.6 5.2h3.6M3.6 7.2h2.6M3.6 9.2h3.2M3.6 11.2h2"/><path class="body" d="M11.2 3.2h2.4M11.2 6h2.4M11.2 8.8h2.4M11.2 11.6h2.4"/>',
  ruler: '<path d="M2.2 5.8h11.6v4.8H2.2z"/><path class="sec" d="M4.6 5.8v1.9M7 5.8v1.9M9.4 5.8v1.9M11.8 5.8v1.9"/>',
  invisible: '<path d="M1.8 8s2.4-4 6.2-4 6.2 4 6.2 4-2.4 4-6.2 4S1.8 8 1.8 8z"/><circle class="sec" cx="8" cy="8" r="1.8"/>',
  editMode: '<path class="body" d="M2.8 2.8h10.4v10.4H2.8z"/><path class="sec" d="M8 5v6M6.4 5h3.2M6.4 11h3.2"/>',
  format: '<path class="sec" d="M2.8 4.4h4.4M6 8h4.4M9.2 11.6h4"/>',
  info: '<circle cx="8" cy="8" r="5.6"/><path class="sec" d="M8 7.4v4"/><path class="solid" d="M8 4.6v.4"/>',
  font: '<path class="sec" d="M2.8 5h5.2M2.8 8.2h3.6M2.8 11.4h5.2"/><path class="solid" d="M11.6 6.8V2.6M10 4.4l1.6-1.8 1.6 1.8M11.6 9.2v4.2M10 11.6l1.6 1.8 1.6-1.8"/>',
  wrap: '<path d="M2.6 3.8h10.8M2.6 12.2h10.8"/><path d="M2.6 8h6.8"/><path class="solid" d="M9.8 6.2l2 1.8-2 1.8"/>',
} as const;

export function icon(name: keyof typeof ICONS, cls = ''): string {
  return `<svg class="ic ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
}

// ── ZiEdit 品牌标：Z 与插入光标组成 "Zi" ──
// 512 主图 icons/icon-master.svg 的 16 栅格版：深石墨底 #1C2027 + 白 Z + 蓝光标 #6FA8E8；
// 标题栏 / 关于 / 欢迎页三处统一（H-2），45° 斜画等重笔画，16px 下光标约 1px 仍可辨。
export function brandSvg(cls = ''): string {
  return (
    `<svg class="brand ${cls}" viewBox="0 0 16 16" aria-hidden="true">` +
    '<rect x="0.5" y="0.5" width="15" height="15" rx="3.5" fill="#1C2027"/>' +
    '<path d="M3.1 4.3h7.5v1.8L6.9 9.9h3.7v1.9H3.1V9.9h1.1L8 6.1H3.1Z" fill="#FFFFFF"/>' +
    '<rect x="11.75" y="4.6" width="1.2" height="6.8" fill="#6FA8E8"/>' +
    '</svg>'
  );
}

// ── 动作注册表（菜单 / 工具栏 / 命令面板 / 快捷键同源，001 规则 22） ──
export interface ActionDef {
  id: string;
  label: string;
  /** 工具栏分段按钮等窄位显示的短标签（缺省用 label） */
  short?: string;
  shortcut?: string;
  group: 'file' | 'edit' | 'find' | 'view' | 'tools' | 'help';
  iconCls?: string; // 命令面板分组色（g-file/g-edit/g-find/g-view）
  icon?: keyof typeof ICONS;
  /** 工具栏着色组（定稿 demo .t-blue/.t-violet/.t-teal/.t-amber/.t-green/.t-slate） */
  tint?: 'blue' | 'violet' | 'teal' | 'amber' | 'green' | 'slate';
  enabled?: () => boolean;
  checked?: () => boolean; // 工具栏 toggle 态 / 菜单对号
  /** H-2：工具栏按钮点击弹菜单（如「标题 ▾」「分隔符 ▾」）而非直接执行；入参为锚定按钮 */
  popup?: (anchor: HTMLElement) => void;
  run: () => void;
}

export class ActionRegistry {
  private defs = new Map<string, ActionDef>();
  add(def: ActionDef): void {
    this.defs.set(def.id, def);
  }
  get(id: string): ActionDef | undefined {
    return this.defs.get(id);
  }
  all(): ActionDef[] {
    return [...this.defs.values()];
  }
  run(id: string): boolean {
    const d = this.defs.get(id);
    if (!d || d.enabled?.() === false) return false;
    d.run();
    return true;
  }

  // ── H-5 T8：快捷键统一派发（单一来源=ActionDef.shortcut，keydown 只做焦点守卫） ──
  private chordIndex: Map<string, ActionDef> | null = null;

  /** 事件 → 和弦串（'Ctrl+Shift+P' / 'Alt+Z' / 'F5'；无修饰字母键返回 null——不打字干扰） */
  static chordOf(e: KeyboardEvent): string | null {
    const key = e.key;
    if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null;
    const mods: string[] = [];
    if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    const k = key.length === 1 ? key.toUpperCase() : key;
    if (!mods.length) {
      // 无修饰：仅功能键族允许派发（F1-F24），字母/数字/符号不拦截
      return /^F\d{1,2}$/.test(k) ? k : null;
    }
    return [...mods, k].join('+');
  }

  /** 按和弦查表派发；命中且启用返回 true（调用方负责 preventDefault）。
   *  H-6 根修：已消费事件短路——编辑器（CM6 / 旧渲染器的 keymap）命中绑定即 preventDefault，
   *  此处若再派发同一和弦就是二次执行（实测 Ctrl+Z 撤销两步、Alt+C 列模式开了又关）。
   *  「第一个处理器赢」是本方法的契约，不是每个调用点各自的义务。 */
  dispatch(e: KeyboardEvent): boolean {
    if (e.defaultPrevented || isCompositionKey(e)) return false;
    const chord = ActionRegistry.chordOf(e);
    if (!chord) return false;
    if (!this.chordIndex) {
      this.chordIndex = new Map();
      for (const d of this.defs.values()) {
        if (d.shortcut && !this.chordIndex.has(d.shortcut)) this.chordIndex.set(d.shortcut, d);
      }
    }
    const def = this.chordIndex.get(chord);
    if (!def || def.enabled?.() === false) return false;
    def.run();
    return true;
  }
}

// ── 标题栏：窗口控制（决策 009；纯 Web 环境降级无操作） ──
export function initTitlebar(getFileName: () => string | null): void {
  const text = document.getElementById('titleText');
  const set = () => {
    const name = getFileName();
    text!.innerHTML = name ? `<b>${name.replace(/</g, '&lt;')}</b> — ZiEdit` : '<b>ZiEdit</b>';
  };
  set();
  // 由 app 在标签变化时调用（挂在 window 上避免循环依赖）
  (window as unknown as { __ZiEditTitleRefresh?: () => void }).__ZiEditTitleRefresh = set;

  const winAction = async (fn: 'minimize' | 'toggleMaximize' | 'close') => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow()[fn]();
  };
  document.getElementById('winMin')?.addEventListener('click', () => void winAction('minimize'));
  document.getElementById('winMax')?.addEventListener('click', () => void winAction('toggleMaximize'));
  document.getElementById('winClose')?.addEventListener('click', () => void winAction('close'));
}

export function refreshTitlebar(): void {
  (window as unknown as { __ZiEditTitleRefresh?: () => void }).__ZiEditTitleRefresh?.();
}

// ── 菜单栏（六个菜单，001 规则 19） ──
export interface MenuEntry {
  label?: string;
  sep?: boolean;
  action?: string;
  /** 子菜单（`Submenu`，001 规则 19 v1.2：如"Markdown ▸"）；每次父菜单展开时求值，checked/enabled 始终新鲜 */
  children?: () => MenuEntry[];
}

/** 上下文菜单项：文本项 / 带子菜单的父项（如编辑右键"列操作 ▸"）/ 分隔线；
 * 回调可为 null（置灰不可点，007 v0.8：Markdown 模式菜单超限项置灰提示） */
export type CtxMenuLeaf = [string, (() => void) | null, (keyof typeof ICONS)?];
export type CtxMenuItem =
  | [string, (() => void) | null]
  | [string, () => void, (CtxMenuLeaf | 'sep')[]]
  | 'sep';
export interface MenuDef {
  label: string;
  entries: () => MenuEntry[]; // 动态：命名会话等列表每次打开时求值
}

export function buildMenubar(
  root: HTMLElement,
  menus: MenuDef[],
  reg: ActionRegistry
): { refresh: () => void; dispose: () => void; open: (index: number) => void } {
  let openMenu: HTMLElement | null = null;
  let previousFocus: HTMLElement | null = null;
  root.setAttribute('role', 'menubar');
  const closeAll = (restoreFocus = false) => {
    root.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
    root.querySelectorAll('[aria-expanded]').forEach(m => m.setAttribute('aria-expanded', 'false'));
    openMenu = null;
    if (restoreFocus) previousFocus?.focus();
  };
  const outside = (e: Event) => {
    if (!root.contains(e.target as Node)) closeAll();
  };
  document.addEventListener('click', outside);

  /** 单个条目（普通动作或带子菜单的父项）→ 挂到 host */
  const mkEntry = (en: MenuEntry, host: HTMLElement): void => {
    if (en.sep) {
      const s = document.createElement('div');
      s.className = 'menu-sep';
      host.appendChild(s);
      return;
    }
    if (en.children) {
      const parent = document.createElement('div');
      parent.className = 'menu-action has-sub';
      parent.tabIndex = -1;
      parent.setAttribute('role', 'menuitem');
      parent.setAttribute('aria-haspopup', 'menu');
      parent.setAttribute('aria-expanded', 'false');
      const ck = document.createElement('span');
      ck.className = 'ma-check';
      const lab = document.createElement('span');
      lab.className = 'ma-label';
      lab.textContent = L(en.label);
      const arrow = document.createElement('span');
      arrow.className = 'ma-arrow';
      arrow.textContent = '▸';
      parent.append(ck, lab, arrow);
      const sub = document.createElement('div');
      sub.className = 'menu-dropdown sub';
      sub.setAttribute('role', 'menu');
      // 悬停即展开并重建子项（与"每次打开重建"同构，无需额外刷新机制）
      const fillSub = () => {
        sub.innerHTML = '';
        for (const c of en.children!()) mkEntry(c, sub);
        parent.setAttribute('aria-expanded', 'true');
      };
      parent.addEventListener('mouseenter', fillSub);
      parent.addEventListener('mouseleave', () => {
        if (!parent.contains(document.activeElement)) parent.setAttribute('aria-expanded', 'false');
      });
      parent.addEventListener('click', e => { e.stopPropagation(); fillSub(); });
      parent.appendChild(sub);
      host.appendChild(parent);
      return;
    }
    const a = document.createElement('div');
    const def = en.action ? reg.get(en.action) : undefined;
    a.className = 'menu-action';
    a.tabIndex = -1;
    a.setAttribute('role', 'menuitem');
    const ck = document.createElement('span');
    ck.className = 'ma-check';
    ck.textContent = def?.checked?.() ? '✓' : '';
    const lab = document.createElement('span');
    lab.className = 'ma-label';
    lab.textContent = L(en.label ?? def?.label);
    const sc = document.createElement('span');
    sc.className = 'ma-shortcut';
    sc.textContent = def?.shortcut ?? '';
    a.append(ck, lab, sc);
    const disabled = def?.enabled ? !def.enabled() : false;
    if (disabled) a.classList.add('disabled');
    a.setAttribute('aria-disabled', String(disabled));
    a.addEventListener('click', e => {
      e.stopPropagation();
      if (disabled || !en.action) return; // 置灰项点击不关菜单、不执行
      closeAll(true);
      reg.run(en.action);
    });
    host.appendChild(a);
  };

  const items: HTMLElement[] = [];
  const fills: Array<() => void> = [];
  for (const m of menus) {
    const item = document.createElement('div');
    item.className = 'menu-item';
    item.tabIndex = 0;
    item.setAttribute('role', 'menuitem');
    item.setAttribute('aria-haspopup', 'menu');
    item.setAttribute('aria-expanded', 'false');
    item.textContent = L(m.label);
    const dropdown = document.createElement('div');
    dropdown.className = 'menu-dropdown';
    dropdown.setAttribute('role', 'menu');
    item.appendChild(dropdown);
    const fill = () => {
      dropdown.innerHTML = '';
      for (const en of m.entries()) mkEntry(en, dropdown);
    };
    fills.push(fill);
    item.addEventListener('click', e => {
      e.stopPropagation();
      const was = item.classList.contains('open');
      if (!openMenu) previousFocus = document.activeElement as HTMLElement | null;
      closeAll();
      if (!was) {
        fill();
        item.classList.add('open');
        item.setAttribute('aria-expanded', 'true');
        openMenu = item;
      }
    });
    item.addEventListener('mouseenter', () => {
      if (openMenu && openMenu !== item) {
        closeAll();
        fill();
        item.classList.add('open');
        item.setAttribute('aria-expanded', 'true');
        openMenu = item;
      }
    });
    root.appendChild(item);
    items.push(item);
  }
  const entries = (host: Element) => Array.from(host.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('menu-action') && !el.classList.contains('disabled'));
  const openAt = (index: number, focus = false): void => {
    const item = items[(index + items.length) % items.length];
    if (!item) return;
    if (!openMenu) previousFocus = document.activeElement as HTMLElement | null;
    closeAll();
    fills[items.indexOf(item)]!();
    item.classList.add('open');
    item.setAttribute('aria-expanded', 'true');
    openMenu = item;
    if (focus) entries(item.querySelector('.menu-dropdown')!)[0]?.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (isCompositionKey(e)) return;
    const target = document.activeElement as HTMLElement | null;
    if (!openMenu) {
      const at = items.indexOf(target!);
      if (at < 0 || !['ArrowDown', 'Enter', ' '].includes(e.key)) return;
      e.preventDefault();
      openAt(at, true);
      return;
    }
    if (!['Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === 'Tab') { closeAll(true); return; }
    const action = target?.closest<HTMLElement>('.menu-action');
    const host = action?.parentElement ?? openMenu.querySelector<HTMLElement>('.menu-dropdown')!;
    const opts = entries(host);
    const at = opts.indexOf(action!);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      const index = e.key === 'Home' ? 0 : e.key === 'End' ? opts.length - 1 : at < 0 ? (e.key === 'ArrowUp' ? opts.length - 1 : 0) : (at + (e.key === 'ArrowUp' ? -1 : 1) + opts.length) % opts.length;
      opts[index]?.focus();
    } else if (e.key === 'ArrowRight' && action?.classList.contains('has-sub') || (e.key === 'Enter' || e.key === ' ') && action?.classList.contains('has-sub')) {
      action!.click();
      entries(action!.querySelector('.sub')!)[0]?.focus();
    } else if (e.key === 'ArrowLeft' && host.classList.contains('sub')) {
      const parent = host.parentElement!;
      parent.focus();
      parent.setAttribute('aria-expanded', 'false');
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      openAt(items.indexOf(openMenu) + (e.key === 'ArrowRight' ? 1 : -1), true);
    } else if (e.key === 'Enter' || e.key === ' ') action?.click();
  };
  document.addEventListener('keydown', onKey, true);
  return {
    refresh: () => {
      /* 禁用态随每次打开重建，无需额外刷新 */
    },
    /** 程序化打开第 index 个菜单（Alt 助记键用，与点击同路径） */
    open: (index: number) => {
      openAt(index, true);
    },
    /** 卸载（语言切换重建菜单栏时调用，避免 document 级监听累积） */
    dispose: () => {
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', onKey, true);
    },
  };
}

// ── 工具栏（001 v0.6 修订；H-2 方案 A：左段恒定 + 中段随视图上下文，右区 = 命令面板 + 主题） ──
export type ToolbarItem = { action: string } | 'sep' | { seg: string[] };
export interface ToolbarSpec {
  /** 左段恒定（文件/撤销重做/剪贴板/查找） */
  left: ToolbarItem[];
  /** 中段：随活动视图切换的上下文组（文本/Markdown IR/CSV/图片各一套） */
  context?: ToolbarItem[];
  right?: Array<{ action: string }>;
}
/** 工具栏构建器：spec 为动态求值（每次 refresh 重算；结构签名变化时重建 DOM，
 *  enabled/checked 始终新鲜）——方案 A 的上下文切换实现基础 */
export function buildToolbar(
  root: HTMLElement,
  spec: () => ToolbarSpec,
  reg: ActionRegistry
): { refresh: () => void } {
  let refreshers: Array<() => void> = [];
  let shapeKey = '';
  const rebuild = (s: ToolbarSpec): void => {
    root.innerHTML = '';
    refreshers = [];
    const makeButton = (id: string, tinted: boolean): HTMLButtonElement => {
      const def = reg.get(id);
      const b = document.createElement('button');
      b.className = tinted ? `tb tinted${def?.tint ? ` t-${def.tint}` : ''}` : 'tb';
      b.dataset.action = id;
      b.title = `${L(def?.label)}${def?.shortcut ? ' ' + def.shortcut : ''}`;
      b.innerHTML = def?.icon ? icon(def.icon) : '';
      if (def?.popup) {
        b.classList.add('has-popup');
        b.setAttribute('aria-haspopup', 'menu');
        const arrow = document.createElement('span'); arrow.className = 'popup-indicator'; arrow.textContent = '▾';
        b.append(arrow);
      }
      b.addEventListener('click', () => {
        if (def?.popup) {
          if (def.enabled?.() !== false) def.popup(b);
        }
        else reg.run(id);
      });
      refreshers.push(() => {
        b.classList.toggle('toggle-on', def?.checked?.() ?? false);
        // 禁用态不用 disabled 属性（2026-10 反馈）：Chromium/WebView2 对 disabled 元素不显示
        // 原生 title 悬停提示——「有时有小字有时没有」的根源；改样式类 + aria-disabled，
        // 点击安全由 ActionRegistry.run 的 enabled 守卫与 popup 路径的显式判定保证。
        const off = def?.enabled ? !def.enabled() : false;
        b.classList.toggle('disabled', off);
        if (off) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
      });
      return b;
    };
    const mountItems = (items: ToolbarItem[]): void => {
      for (const item of items) {
        if (item === 'sep') {
          const s = document.createElement('span');
          s.className = 'tb-sep';
          root.appendChild(s);
          continue;
        }
        if ('seg' in item) {
          const seg = document.createElement('div');
          seg.className = 'seg';
          seg.setAttribute('role', 'group');
          for (const id of item.seg) {
            const def = reg.get(id);
            const b = document.createElement('button');
            // P3（反馈 2）：seg 图标吃 tint（t-* 组设定 --g1，CSS 只染 .ic 不染文字；active 跟随强调色）
            b.className = 'tb' + (def?.tint ? ` seg-t t-${def.tint}` : '');
            b.title = `${L(def?.label)}${def?.shortcut ? ' ' + def.shortcut : ''}`;
            b.innerHTML = def?.icon ? icon(def.icon, 's14') : '';
            b.appendChild(document.createTextNode(L(def?.short ?? def?.label)));
            b.addEventListener('click', () => reg.run(id));
            seg.appendChild(b);
            refreshers.push(() => {
              b.classList.toggle('active', def?.checked?.() ?? false);
              // 同 makeButton：禁用态不用 disabled 属性（保留 title 悬停提示），点击由 run 守卫
              const off = def?.enabled ? !def.enabled() : false;
              b.classList.toggle('disabled', off);
              if (off) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
            });
          }
          root.appendChild(seg);
          continue;
        }
        const b = makeButton(item.action, true);
        const def = reg.get(item.action);
        if (def?.short) b.appendChild(document.createTextNode(L(def.short)));
        root.appendChild(b);
      }
    };
    mountItems(s.left);
    if (s.context?.length) {
      const s2 = document.createElement('span');
      s2.className = 'tb-sep';
      root.appendChild(s2);
      mountItems(s.context);
    }
    const spacer = document.createElement('span');
    spacer.className = 'tb-spacer';
    root.appendChild(spacer);
    const right = document.createElement('div');
    right.className = 'toolbar-right';
    for (const item of s.right ?? []) right.appendChild(makeButton(item.action, false));
    root.appendChild(right);
  };
  return {
    refresh: () => {
      const s = spec();
      const key = JSON.stringify(s);
      if (key !== shapeKey) {
        shapeKey = key;
        rebuild(s);
      }
      for (const r of refreshers) r();
    },
  };
}

// ── 命令面板（Ctrl+Shift+P，001 规则 22） ──
export interface PaletteFileItem {
  path: string;
  label: string;
  sub?: string;
  isDir?: boolean;
}
export interface PaletteFileSource {
  items: () => PaletteFileItem[];
  open: (path: string, isDir?: boolean) => void;
}

type PaletteRow = { kind: 'cmd'; def: ActionDef } | { kind: 'file'; item: PaletteFileItem } | { kind: 'head'; text: string };

export function openPalette(reg: ActionRegistry, files?: PaletteFileSource): void {
  document.querySelector('.cmd-overlay')?.remove();
  const overlayEl = document.createElement('div');
  overlayEl.className = 'cmd-overlay';
  const palette = document.createElement('div');
  palette.className = 'cmd-palette';
  const input = document.createElement('input');
  input.className = 'cmd-input';
  input.type = 'text';
  input.placeholder = t('cmd.placeholder');
  const list = document.createElement('div');
  list.className = 'cmd-list';
  palette.append(input, list);
  overlayEl.appendChild(palette);
  document.body.appendChild(overlayEl);

  let selIdx = 0;
  let rows: PaletteRow[] = [];
  // 可选中行（跳过分组标题）的索引序列
  const selectableIdx = (): number[] => rows.map((r, i) => (r.kind === 'head' ? -1 : i)).filter(i => i >= 0);

  const runRow = (r: PaletteRow): void => {
    close();
    if (r.kind === 'cmd') reg.run(r.def.id);
    else if (r.kind === 'file') files?.open(r.item.path, r.item.isDir);
  };

  const renderList = () => {
    list.innerHTML = '';
    rows.forEach((r, i) => {
      if (r.kind === 'head') {
        const h = document.createElement('div');
        h.className = 'cmd-head';
        h.textContent = r.text;
        list.appendChild(h);
        return;
      }
      const it = document.createElement('div');
      it.className = 'cmd-item' + (r.kind === 'file' ? ' file' : '') + (i === selIdx ? ' selected' : '');
      const ic = document.createElement('span');
      if (r.kind === 'cmd') {
        const d = r.def;
        ic.className = `cmd-icon g-${d.group === 'help' || d.group === 'tools' ? 'edit' : d.group}`;
        ic.innerHTML = d.icon ? icon(d.icon, 's14') : '';
        const label = document.createElement('span');
        label.textContent = L(d.label);
        it.append(ic, label);
        if (d.shortcut) {
          const sc = document.createElement('span');
          sc.className = 'cmd-shortcut';
          sc.textContent = d.shortcut;
          it.appendChild(sc);
        }
      } else {
        ic.className = 'cmd-icon g-file';
        ic.innerHTML = icon(r.item.isDir ? 'folder' : 'newFile', 's14');
        const wrap = document.createElement('span');
        wrap.className = 'cmd-file';
        const nm = document.createElement('span');
        nm.className = 'cmd-file-name';
        nm.textContent = r.item.label;
        wrap.appendChild(nm);
        if (r.item.sub) {
          const sb = document.createElement('span');
          sb.className = 'cmd-file-sub';
          sb.textContent = r.item.sub;
          wrap.appendChild(sb);
        }
        it.append(ic, wrap);
      }
      it.addEventListener('click', () => runRow(r));
      it.addEventListener('mouseenter', () => {
        selIdx = i;
        list.querySelectorAll('.cmd-item').forEach(el => el.classList.remove('selected'));
        it.classList.add('selected');
      });
      list.appendChild(it);
    });
  };
  const close = () => overlayEl.remove();
  const applyFilter = () => {
    const q = input.value.trim().toLowerCase();
    const cmds = reg
      .all()
      .filter(d => !d.popup && d.enabled?.() !== false)
      // H-6i：过滤口径与显示口径同源——行上显示的是 L(d.label) 译文，过滤也得按译文匹配；
      // 此前只按裸 key 匹配，中文用户输「主题」找不到「主题…」（key 是 'act.theme'）。
      // 裸 key 仍作第二匹配路（输 'md'/'act' 等内部子串也能命中，供熟练用户）。
      .filter(d => {
        if (!q) return true;
        return L(d.label).toLowerCase().includes(q) || d.label.toLowerCase().includes(q);
      })
      .map(def => ({ kind: 'cmd', def }) as PaletteRow);
    rows = [...cmds];
    if (files && q) {
      const seen = new Set<string>();
      const matched = files
        .items()
        .filter(f => {
          if (seen.has(f.path)) return false;
          seen.add(f.path);
          return f.label.toLowerCase().includes(q) || f.path.toLowerCase().includes(q);
        })
        .slice(0, 30)
        .map(item => ({ kind: 'file', item }) as PaletteRow);
      if (matched.length) rows.push({ kind: 'head', text: t('sidebar.files') }, ...matched);
    }
    const sel = selectableIdx();
    selIdx = sel.length ? sel[0] : 0;
    renderList();
  };
  const moveSel = (dir: 1 | -1): void => {
    const sel = selectableIdx();
    if (!sel.length) return;
    const cur = sel.indexOf(selIdx);
    const next = cur < 0 ? (dir === 1 ? 0 : sel.length - 1) : Math.min(Math.max(cur + dir, 0), sel.length - 1);
    selIdx = sel[next];
    renderList();
    const node = list.children[selIdx] as HTMLElement | undefined;
    node?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', applyFilter);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSel(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSel(-1);
    } else if (e.key === 'Enter') {
      const r = rows[selIdx];
      if (r && r.kind !== 'head') runRow(r);
      else close();
    } else if (e.key === 'Escape') {
      close();
    }
  });
  overlayEl.addEventListener('mousedown', e => {
    if (e.target === overlayEl) close();
  });
  applyFilter();
  setTimeout(() => input.focus(), 30);
}

// ── 主题（四套，001 规则 21） ──
export const THEMES = [
  { key: 'paper', name: 'theme.paper', tone: 'light' },
  { key: 'cool', name: 'theme.cool', tone: 'light' },
  { key: 'graphite', name: 'theme.graphite', tone: 'dark' },
  { key: 'black', name: 'theme.black', tone: 'dark' },
] as const;
export type ThemeKey = (typeof THEMES)[number]['key'];

export function applyTheme(key: string): void {
  const th = THEMES.find(x => x.key === key) ?? THEMES[0];
  const root = document.documentElement;
  root.classList.remove('th-paper', 'th-cool', 'th-graphite', 'th-black');
  root.classList.add(`th-${th.key}`);
  root.setAttribute('data-tone', th.tone);
}

export function openThemeDialog(current: string, onPick: (key: ThemeKey) => void): void {
  (document.querySelector('.ov-mask') as unknown as OverlayMask | null)?.close();
  const body = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'theme-grid';
  for (const th of THEMES) {
    const card = document.createElement('div');
    card.className = `theme-card th-${th.key}` + (th.key === current ? ' selected' : '');
    card.dataset.themeKey = th.key;
    card.innerHTML =
      `<div class="tp-win"><div class="tp-title"></div><div class="tp-menu"></div>` +
      `<div class="tp-body"><div class="tp-side"></div><div class="tp-canvas">` +
      `<span class="tp-line" style="width:70%"></span><div class="tp-band"><span class="tp-line"></span></div>` +
      `<span class="tp-line" style="width:52%"></span><span class="tp-line" style="width:78%"></span>` +
      `</div></div><div class="tp-status"></div></div>` +
      `<div class="tp-meta"><span class="tp-name">${t(th.name)}</span><span class="tp-tone">${t(th.tone === 'light' ? 'theme.light' : 'theme.dark')}</span></div>` +
      `<span class="tp-check"><svg class="ic s9" viewBox="0 0 16 16"><path d="M3.4 8.2l3 3 6.2-6.4"/></svg></span>`;
    card.addEventListener('click', () => {
      grid.querySelectorAll('.theme-card').forEach(c => c.classList.toggle('selected', c === card));
      onPick(th.key);
    });
    grid.appendChild(card);
  }
  body.appendChild(grid);
  document.body.appendChild(overlayDialog(t('theme.title'), body, () => void 0));
}

// ── 状态栏闪示（001 规则 24：提示统一呈现） ──
let hintEl: HTMLElement | null = null;
let hintTimer: ReturnType<typeof setTimeout> | undefined;
let hintDefault = '';

export function bindStatusHint(el: HTMLElement): void {
  hintEl = el;
}
export function setHintDefault(text: string): void {
  hintDefault = text;
  if (hintEl && !hintTimer) hintEl.textContent = text;
}
export function flash(msg: string): void {
  if (!hintEl) return;
  hintEl.textContent = msg;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    if (hintEl) hintEl.textContent = hintDefault;
    hintTimer = undefined;
  }, 4000);
}

// ── 应用内对话框（定稿 .dlg 形态：顶对齐 96px、h4 标题、无 × ；001 规则 24） ──
/** overlayDialog 返回的遮罩元素：close() 是唯一收口（卸载 Esc 监听 + 移除 + 回调 onClose，
 *  幂等）。按钮回调一律持本句柄关闭，不得 querySelector('.ov-mask') 直删——多弹窗叠放时会
 *  删错别人的遮罩，且绕过监听卸载（P0-1 根修，注释 H-3 中的「自愈」路径随之退役）。 */
export type OverlayMask = HTMLElement & { close(): void };
const modalMasks: HTMLElement[] = [];
const modalInert = new Map<HTMLElement, boolean>();
let modalObserver: MutationObserver | null = null;
function topModal(): HTMLElement | undefined {
  const connected = modalMasks.filter(mask => mask.isConnected);
  return connected[connected.length - 1];
}
/** 只隔离最上层弹窗的祖先路径之外的节点，兼容挂在 app 内部及嵌套弹窗。 */
function syncModalBackground(): void {
  for (const [el, wasInert] of modalInert) el.toggleAttribute('inert', wasInert);
  modalInert.clear();
  for (let child = topModal(); child?.parentElement; child = child.parentElement) {
    for (const sibling of child.parentElement.children) {
      if (sibling === child || !(sibling instanceof HTMLElement)) continue;
      modalInert.set(sibling, sibling.hasAttribute('inert'));
      sibling.setAttribute('inert', '');
    }
    if (child.parentElement === document.body) break;
  }
}
export function overlayDialog(title: string, body: HTMLElement, onClose: () => void): OverlayMask {
  const mask = document.createElement('div');
  mask.className = 'ov-mask';
  const box = document.createElement('div');
  box.className = 'ov-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', title);
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const h = document.createElement('h4');
  h.textContent = title;
  // 常显 × 关闭钮（审计整改：此前仅遮罩点击/Esc（且 Esc 依赖焦点在 mask 内，实际难以触达），
  // 主题等无按钮对话框一度无法关闭）
  const closeBtn = document.createElement('button');
  closeBtn.className = 'ov-close';
  closeBtn.title = t('common.close');
  closeBtn.setAttribute('aria-label', t('common.close'));
  closeBtn.innerHTML = '<svg class="ic s10" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  let closed = false;
  const close = (): void => {
    if (closed) return;
    const wasTop = topModal() === mask;
    closed = true;
    clearTimeout(focusTimer);
    document.removeEventListener('keydown', onDocKey, true);
    document.removeEventListener('focusin', onFocus, true);
    document.removeEventListener('wheel', onWheel, true);
    mask.remove();
    modalMasks.splice(modalMasks.indexOf(mask), 1);
    syncModalBackground();
    if (!modalMasks.length) { modalObserver?.disconnect(); modalObserver = null; }
    if (wasTop) {
      const editor = !modalMasks.length ? document.querySelector<HTMLElement>('#editor .cm-content, .cm-editor .cm-content') : null;
      const target = editor ?? (previousFocus?.isConnected && !previousFocus.closest('[inert]') ? previousFocus : null);
      target?.focus({ preventScroll: true });
    }
    onClose();
  };
  closeBtn.addEventListener('click', close);
  box.append(h, closeBtn, body);
  mask.appendChild(box);
  mask.addEventListener('mousedown', e => {
    if (e.target === mask) close();
  });
  // H-3（审计 §2.5）：焦点不在对话框内 Esc 也生效——document 捕获阶段监听，
  // 随对话框关闭卸载；P0-1 起按钮回调均走返回句柄的 close()（见 OverlayMask 注释），
  // 不再依赖「mask 被外部直删、下一次按键自愈卸载」的兜底路径；
  // 对话框自身可聚焦（tabindex=-1 + 打开即 focus，键盘可达性）
  const onDocKey = (e: KeyboardEvent): void => {
    if (topModal() !== mask || isCompositionKey(e)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    } else if (e.key === 'Tab') {
      const controls = [...box.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]')]
        .filter(el => el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[hidden],[inert]')
          && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden');
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const nextIndex = index < 0 ? (e.shiftKey ? controls.length - 1 : 0)
        : (index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length;
      const next = controls[nextIndex] ?? box;
      e.preventDefault(); e.stopImmediatePropagation(); next.focus({ preventScroll: true });
    }
  };
  const onFocus = (e: FocusEvent): void => {
    if (topModal() === mask && !box.contains(e.target as Node)) box.focus({ preventScroll: true });
  };
  const onWheel = (e: WheelEvent): void => {
    if (topModal() !== mask) return;
    e.stopPropagation();
    // 内部滚动区未到边界时保留原生滚轮；遮罩及边界不向背景传递。
    for (let el = e.target instanceof HTMLElement ? e.target : null; el && box.contains(el); el = el.parentElement) {
      const style = getComputedStyle(el);
      const canY = /auto|scroll/.test(style.overflowY || style.overflow)
        && (e.deltaY < 0 ? el.scrollTop > 0 : e.deltaY > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1);
      const canX = /auto|scroll/.test(style.overflowX || style.overflow)
        && (e.deltaX < 0 ? el.scrollLeft > 0 : e.deltaX > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
      if (!e.ctrlKey && (canY || canX)) return;
    }
    e.preventDefault();
  };
  document.addEventListener('keydown', onDocKey, true);
  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  mask.addEventListener('keydown', e => e.stopPropagation());
  modalMasks.push(mask);
  if (!modalObserver) {
    modalObserver = new MutationObserver(syncModalBackground);
    modalObserver.observe(document.body, { childList: true, subtree: true });
  }
  box.tabIndex = -1;
  const focusTimer = setTimeout(() => {
    syncModalBackground();
    if (topModal() === mask) box.focus({ preventScroll: true });
  }, 0);
  const handle = mask as unknown as OverlayMask;
  handle.close = close;
  return handle;
}

export function dlgAlert(msg: string, title = 'ZiEdit'): void {
  const body = document.createElement('div');
  body.className = 'ov-body';
  const p = document.createElement('div');
  p.style.whiteSpace = 'pre-wrap';
  p.textContent = msg;
  const row = document.createElement('div');
  row.className = 'ov-row';
  const ok = document.createElement('button');
  ok.className = 'dlg-btn primary';
  ok.textContent = t('common.ok');
  let maskH: OverlayMask | null = null;
  ok.addEventListener('click', () => maskH?.close());
  row.appendChild(ok);
  body.append(p, row);
  maskH = overlayDialog(title, body, () => void 0);
  document.body.appendChild(maskH);
}

export function dlgConfirm(msg: string, title = t('common.confirm')): Promise<boolean> {
  return new Promise(resolve => {
    const body = document.createElement('div');
    body.className = 'ov-body';
    const p = document.createElement('div');
    p.style.whiteSpace = 'pre-wrap';
    p.textContent = msg;
    const row = document.createElement('div');
    row.className = 'ov-row';
    const no = document.createElement('button');
    no.className = 'dlg-btn';
    no.textContent = t('common.cancel');
    const yes = document.createElement('button');
    yes.className = 'dlg-btn primary';
    yes.textContent = t('common.ok');
    row.append(no, yes);
    body.append(p, row);
    let maskH: OverlayMask | null = null;
    // settled 守卫：close() 会同步触发 onClose→done——不守卫则「确定」的 resolve 被
    // onClose 的 done(false/null) 抢先（P0 句柄化引入的时序反转，ac-007-ir-polish 实测抓出）
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      maskH?.close();
      resolve(v);
    };
    no.addEventListener('click', () => done(false));
    yes.addEventListener('click', () => done(true));
    maskH = overlayDialog(title, body, () => done(false));
    document.body.appendChild(maskH);
  });
}

/** 带格式下拉的输入对话框（P2，001 规则 28 v2.1：树「新建文件」可选格式）：
 *  返回 {name, format}；取消返回 null。formats 为 [{id, label}]，defaultFormat 缺省取首项。 */
export function dlgPromptWithFormat(
  title: string,
  formats: Array<{ id: string; label: string }>,
  defaultFormat?: string
): Promise<{ name: string; format: string } | null> {
  return new Promise(resolve => {
    const body = document.createElement('div');
    body.className = 'ov-body';
    const rowFmt = document.createElement('div');
    rowFmt.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px';
    const fmtLab = document.createElement('span');
    fmtLab.style.cssText = 'font-size:12px;color:var(--muted)';
    fmtLab.textContent = t('prompt.format');
    const sel = document.createElement('select');
    sel.className = 'dlg-input';
    sel.style.width = 'auto';
    for (const f of formats) {
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.label;
      sel.appendChild(o);
    }
    sel.value = defaultFormat ?? formats[0]!.id;
    rowFmt.append(fmtLab, sel);
    const input = document.createElement('input');
    input.className = 'dlg-input';
    const row = document.createElement('div');
    row.className = 'ov-row';
    const no = document.createElement('button');
    no.className = 'dlg-btn';
    no.textContent = t('common.cancel');
    const yes = document.createElement('button');
    yes.className = 'dlg-btn primary';
    yes.textContent = t('common.ok');
    row.append(no, yes);
    body.append(rowFmt, input, row);
    let maskH: OverlayMask | null = null;
    let settled = false; // 同 dlgConfirm：close→onClose 的二次 done 不得抢 resolve
    const done = (v: { name: string; format: string } | null): void => {
      if (settled) return;
      settled = true;
      maskH?.close();
      resolve(v);
    };
    no.addEventListener('click', () => done(null));
    yes.addEventListener('click', () => done({ name: input.value, format: sel.value }));
    input.addEventListener('keydown', e => {
      // Enter 必须先 preventDefault：done→resolve→调用方跳转并聚焦编辑器发生在同一按键的微任务里，
      // 不拦默认动作会让随后的 keypress/beforeinput 落进刚聚焦的编辑器（E1：跳行 Enter 往文档插入换行）。
      if (e.key === 'Enter') { e.preventDefault(); done({ name: input.value, format: sel.value }); }
      if (e.key === 'Escape') done(null);
    });
    maskH = overlayDialog(title, body, () => done(null));
    document.body.appendChild(maskH);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

export function dlgPrompt(title: string, defaultValue = ''): Promise<string | null> {
  return new Promise(resolve => {
    const body = document.createElement('div');
    body.className = 'ov-body';
    const input = document.createElement('input');
    input.className = 'dlg-input';
    input.value = defaultValue;
    const row = document.createElement('div');
    row.className = 'ov-row';
    const no = document.createElement('button');
    no.className = 'dlg-btn';
    no.textContent = t('common.cancel');
    const yes = document.createElement('button');
    yes.className = 'dlg-btn primary';
    yes.textContent = t('common.ok');
    row.append(no, yes);
    body.append(input, row);
    let maskH: OverlayMask | null = null;
    let settled = false; // 同 dlgConfirm：close→onClose 的二次 done 不得抢 resolve
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      maskH?.close();
      resolve(v);
    };
    no.addEventListener('click', () => done(null));
    yes.addEventListener('click', () => done(input.value));
    input.addEventListener('keydown', e => {
      // 同 dlgPromptWithFormat 的说明：Enter 必须 preventDefault，防焦点移交编辑器后按键默认动作泄漏入文档。
      if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
      if (e.key === 'Escape') done(null);
    });
    maskH = overlayDialog(title, body, () => done(null));
    document.body.appendChild(maskH);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}
