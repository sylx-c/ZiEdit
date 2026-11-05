import { placeContextPopup, placeSubmenu } from '../common/popup';
import { icon, type CtxMenuItem } from './chrome';
import { isCompositionKey } from './composition-key';

export type ContextMenu = HTMLElement & { close: () => void };
let active: ContextMenu | null = null;

/** Shared mouse/keyboard menu. Fixed submenus escape the scrollable parent. */
export function openContextMenu(items: CtxMenuItem[], x: number, y: number): ContextMenu {
  active?.close();
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const root = document.createElement('div') as unknown as ContextMenu;
  root.className = 'ctx-menu';
  root.setAttribute('role', 'menu');
  root.tabIndex = -1;
  let closed = false;
  const close = (restore = true): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('click', outside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', resize);
    root.remove();
    if (active === root) active = null;
    if (restore && previous?.isConnected) previous.focus({ preventScroll: true });
  };
  root.close = () => close();
  const outside = (event: Event): void => { if (!root.contains(event.target as Node)) close(false); };
  const resize = (): void => close();
  const entries = (host: HTMLElement): HTMLElement[] => [...host.children].filter((node): node is HTMLElement =>
    node instanceof HTMLElement && node.getAttribute('role')?.startsWith('menuitem') === true && node.getAttribute('aria-disabled') !== 'true');
  const hideSiblings = (row: HTMLElement): void => {
    for (const other of row.parentElement?.children ?? []) {
      if (other !== row) other.setAttribute('aria-expanded', 'false');
    }
  };
  const add = (item: CtxMenuItem, host: HTMLElement): void => {
    const row = document.createElement('div');
    if (item === 'sep') {
      row.className = 'ctx-sep'; row.setAttribute('role', 'separator'); host.append(row); return;
    }
    const [text, fn, children] = item;
    row.className = children?.length ? 'ctx-parent' : 'ctx-action';
    row.setAttribute('role', 'menuitem');
    row.tabIndex = -1;
    const label = document.createElement('span'); label.className = 'ctx-label';
    // Existing callers prefix checkmarks; render them in a stable leading column.
    const mark = document.createElement('span'); mark.className = 'ctx-check'; mark.setAttribute('aria-hidden', 'true');
    const checked = /^[✓✔]\s*/.exec(text);
    if (checked) mark.textContent = '✓';
    label.textContent = text.replace(/^[✓✔]\s*|^　/, '');
    row.append(mark, label); row.title = label.textContent;
    if (children?.length) {
      row.setAttribute('aria-haspopup', 'menu'); row.setAttribute('aria-expanded', 'false');
      const arrow = document.createElement('span'); arrow.className = 'ctx-arrow'; arrow.textContent = '▸'; arrow.setAttribute('aria-hidden', 'true');
      const sub = document.createElement('div'); sub.className = 'ctx-sub'; sub.setAttribute('role', 'menu');
      for (const child of children) {
        if (child === 'sep') { add('sep', sub); continue; }
        add([child[0], child[1]], sub);
        if (child[2]) sub.lastElementChild?.querySelector('.ctx-check')?.insertAdjacentHTML('afterbegin', icon(child[2]));
      }
      row.append(arrow, sub);
      const show = (): void => { hideSiblings(row); row.setAttribute('aria-expanded', 'true'); placeSubmenu(row, sub); };
      row.addEventListener('mouseenter', show);
      row.addEventListener('mouseleave', () => { if (!row.contains(document.activeElement)) row.setAttribute('aria-expanded', 'false'); });
      row.addEventListener('click', event => { event.stopPropagation(); show(); });
    } else {
      row.setAttribute('aria-disabled', String(!fn));
      if (!fn) row.classList.add('disabled');
      row.addEventListener('mouseenter', () => hideSiblings(row));
      row.addEventListener('click', event => {
        event.stopPropagation();
        if (!fn) return;
        close(); fn();
      });
    }
    host.append(row);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (isCompositionKey(event)) return;
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter', ' ', 'Escape', 'Tab'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Escape' || event.key === 'Tab') { close(); return; }
    const focused = document.activeElement as HTMLElement;
    const row = root.contains(focused) && focused !== root ? focused.closest<HTMLElement>('[role^=menuitem]') : null;
    const host = row?.parentElement ?? root;
    const options = entries(host), at = options.indexOf(row!);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : at < 0 ? (event.key === 'ArrowUp' ? options.length - 1 : 0)
        : (at + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[index]?.focus();
    } else if (event.key === 'ArrowLeft' && host !== root) {
      host.parentElement?.setAttribute('aria-expanded', 'false'); host.parentElement?.focus();
    } else if (event.key === 'ArrowRight' && row?.classList.contains('ctx-parent')) {
      row.click(); entries(row.querySelector<HTMLElement>('.ctx-sub')!)[0]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      row?.click();
      if (row?.classList.contains('ctx-parent')) entries(row.querySelector<HTMLElement>('.ctx-sub')!)[0]?.focus();
    }
  };
  for (const item of items) add(item, root);
  root.addEventListener('scroll', event => {
    (event.target as HTMLElement).querySelectorAll('.ctx-parent[aria-expanded="true"]').forEach(row => row.setAttribute('aria-expanded', 'false'));
  }, true);
  document.body.append(root);
  placeContextPopup(root, x, y);
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('click', outside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', resize);
  active = root;
  // Focusing the menu guards global shortcuts without changing editor selections.
  root.focus({ preventScroll: true });
  return root;
}
