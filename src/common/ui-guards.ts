// ui-guards.ts — 桌面化 UI 兜底（2026-11-16 用户反馈轮）
// ① 默认右键菜单拦截：未提供自定义右键菜单的面（工具栏/状态栏/菜单栏/最近列表/对话框等）
//   不再漏出 WebView2 浏览器默认菜单；可编辑控件（输入框/文本域/可编辑区）保留系统编辑菜单
//   （复制/粘贴），编辑器与阅读面等已 preventDefault 的自定义菜单不受影响。
// ② 统一 title 提示层：原生 title 悬停提示在 WebView2 下延迟长（约 500ms）且不稳定
//   （同位悬停常不再触发）——自定义层接管：260ms 稳定出现、跟随元素、离開/按下即隐。
//   原生提示的抑制采用「悬停期间摘下 title、离开时恢复」的经典手法，无障碍属性不变。

let guardInstalled = false;
export function installDefaultContextMenuGuard(): void {
  if (guardInstalled) return;
  guardInstalled = true;
  window.addEventListener('contextmenu', e => {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    const editable = !!t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (!editable) e.preventDefault();
  });
}

let tipInstalled = false;
let tipEl: HTMLDivElement | null = null;
let tipTimer: ReturnType<typeof setTimeout> | null = null;
let tipOwner: HTMLElement | null = null;

function restoreTitle(el: HTMLElement): void {
  if (el.dataset.tipTitle !== undefined) {
    el.title = el.dataset.tipTitle;
    delete el.dataset.tipTitle;
  }
}

export function installPointerTips(): void {
  if (tipInstalled) return;
  tipInstalled = true;
  const ensure = (): HTMLDivElement => {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'app-tip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
    }
    return tipEl;
  };
  const hide = (): void => {
    if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    if (tipEl) tipEl.classList.remove('on');
    if (tipOwner) { restoreTitle(tipOwner); tipOwner = null; }
  };
  const show = (el: HTMLElement): void => {
    const tip = ensure();
    tip.textContent = el.dataset.tipTitle ?? '';
    tip.classList.add('on'); // 用类切换可见性：.app-tip 基类自带 display:none，
    // 修前 style.display='' 会回落到该规则导致真机永远不可见（jsdom 未加载 CSS 漏检）。
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2), window.innerWidth - 8 - tip.offsetWidth);
    const below = r.bottom + 6;
    const y = below + tip.offsetHeight <= window.innerHeight - 6
      ? below
      : Math.max(6, r.top - tip.offsetHeight - 6);
    tip.style.left = Math.round(x) + 'px';
    tip.style.top = Math.round(y) + 'px';
  };
  document.addEventListener('pointerover', e => {
    const el = (e.target as HTMLElement | null)?.closest?.('[title]') as HTMLElement | null;
    if (!el || !el.title) return;
    if (tipOwner !== el) hide();
    tipOwner = el;
    if (el.dataset.tipTitle === undefined) el.dataset.tipTitle = el.title;
    el.title = ''; // 悬停期间摘下原生提示；离开时恢复
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { tipTimer = null; show(el); }, 260);
  });
  document.addEventListener('pointerout', e => {
    const to = e.relatedTarget as Node | null;
    if (tipOwner && !(to && tipOwner.contains(to))) hide();
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); }, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}

/** 测试收尾：清空安装标记与提示层（跨测试文件环境拆除后全局绑定失效，重复安装守卫需复位）。 */
export function resetUiGuardsForTest(): void {
  guardInstalled = false;
  tipInstalled = false;
  if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
  tipOwner = null;
  tipEl?.remove();
  tipEl = null;
}
