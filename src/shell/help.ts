import { t, tf } from '../common/i18n';
import { ActionRegistry, L, overlayDialog, type ActionDef, type OverlayMask } from './chrome';

const GROUPS: ActionDef['group'][] = ['file', 'edit', 'find', 'view', 'tools', 'help'];
const GROUP_LABELS: Record<ActionDef['group'], string> = {
  file: 'menu.fileF', edit: 'menu.editF', find: 'menu.searchF',
  view: 'menu.viewF', tools: 'menu.toolsF', help: 'menu.helpF',
};
const CHAPTERS = ['open', 'edit', 'save', 'column', 'find', 'md', 'formats', 'compare', 'navigation', 'logs', 'settings', 'shortcuts'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Separate modifier keys from the final key, including a literal + key. */
export function shortcutKeys(chord: string): string[] {
  const modifiers: string[] = [];
  let rest = chord;
  for (;;) {
    const match = /^(Ctrl|Alt|Shift|Meta)\+/.exec(rest);
    if (!match) break;
    modifiers.push(match[1]!);
    rest = rest.slice(match[0].length);
  }
  return [...modifiers, rest || '+'].map(key => ({
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Escape: 'Esc', Delete: 'Del', ' ': 'Space',
  })[key] ?? key);
}

function keycaps(chord: string): HTMLElement {
  const keys = el('span', 'help-keys');
  keys.setAttribute('aria-label', chord);
  for (const key of shortcutKeys(chord)) {
    const cap = el('kbd', 'help-key', key);
    cap.setAttribute('aria-hidden', 'true');
    keys.append(cap);
  }
  return keys;
}

function mount(title: string, body: HTMLElement, variant: string): OverlayMask {
  const mask = overlayDialog(title, body, () => void 0);
  mask.classList.add('help-mask');
  mask.querySelector('.ov-box')!.classList.add('help-dialog', variant);
  document.body.append(mask);
  return mask;
}

export function openShortcuts(reg: ActionRegistry): OverlayMask {
  const body = el('div', 'help-content');
  const intro = el('p', 'help-intro', t('help.shortcutIntro'));
  const controls = el('div', 'help-controls');
  const searchWrap = el('div', 'help-search');
  const searchIcon = el('span', 'help-search-icon');
  searchIcon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.8" cy="6.8" r="4.5"/><path d="m10.2 10.2 3.4 3.4"/></svg>';
  const search = el('input', 'help-search-input');
  search.type = 'search';
  search.placeholder = t('help.search');
  search.setAttribute('aria-label', t('help.searchLabel'));
  search.autofocus = true;
  search.autocomplete = 'off';
  search.spellcheck = false;
  const clear = el('button', 'help-search-clear', '×');
  clear.type = 'button';
  clear.setAttribute('aria-label', t('help.clearSearch'));
  clear.hidden = true;
  searchWrap.append(searchIcon, search, clear);
  const filters = el('div', 'help-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', t('help.shortcuts'));
  let selected: ActionDef['group'] | null = null;
  const count = el('p', 'help-count');
  count.setAttribute('role', 'status');
  count.setAttribute('aria-live', 'polite');
  const results = el('div', 'help-scroll shortcut-results');
  results.tabIndex = 0;
  results.setAttribute('role', 'region');
  results.setAttribute('aria-label', t('help.shortcuts'));
  const commands = reg.all().filter(d => d.shortcut);
  const filterButtons: HTMLButtonElement[] = [];
  const render = (): void => {
    const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = commands.filter(d => (!selected || d.group === selected) && terms.every(term =>
      `${L(d.label)} ${d.shortcut} ${L(GROUP_LABELS[d.group])}`.toLocaleLowerCase().includes(term)));
    clear.hidden = search.value.length === 0;
    count.textContent = tf('help.results', matches.length);
    results.replaceChildren();
    for (const group of GROUPS) {
      const defs = matches.filter(d => d.group === group);
      if (!defs.length) continue;
      const section = el('section', 'shortcut-group');
      const heading = el('h3', 'help-group-title', L(GROUP_LABELS[group]).replace(/\([A-Z]\)$/, ''));
      heading.append(el('span', 'help-group-count', String(defs.length)));
      const table = el('table', 'shortcut-table');
      const head = table.createTHead().insertRow();
      for (const label of ['help.actionColumn', 'help.keyColumn']) {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = t(label);
        head.append(th);
      }
      const rows = table.createTBody();
      for (const d of defs) {
        const row = rows.insertRow();
        row.insertCell().textContent = L(d.label);
        row.insertCell().append(keycaps(d.shortcut!));
      }
      section.append(heading, table);
      results.append(section);
    }
    if (!matches.length) results.append(el('p', 'help-empty', t('help.noResults')));
    results.scrollTop = 0;
  };
  for (const group of [null, ...GROUPS]) {
    if (group && !commands.some(d => d.group === group)) continue;
    const label = group ? L(GROUP_LABELS[group]).replace(/\([A-Z]\)$/, '') : t('common.all');
    const button = el('button', 'help-filter', label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(group === selected));
    button.addEventListener('click', () => {
      selected = group;
      for (const other of filterButtons) other.setAttribute('aria-pressed', String(other === button));
      render();
    });
    filterButtons.push(button);
    filters.append(button);
  }
  search.addEventListener('input', render);
  clear.addEventListener('click', () => { search.value = ''; render(); search.focus(); });
  const footer = el('div', 'help-footer');
  footer.append(el('p', '', t('help.extra')), el('p', '', t('help.mnemonics')));
  controls.append(searchWrap, filters, count);
  body.append(intro, controls, results, footer);
  render();
  return mount(t('help.shortcuts'), body, 'help-shortcuts');
}

export function openUserGuide(): OverlayMask {
  const body = el('div', 'help-content');
  body.append(el('p', 'help-intro', t('help.intro')));
  const layout = el('div', 'guide-layout');
  const nav = el('nav', 'guide-nav');
  nav.setAttribute('aria-label', t('help.guideNav'));
  const article = el('div', 'help-scroll guide-article');
  article.tabIndex = 0;
  article.setAttribute('role', 'region');
  article.setAttribute('aria-label', t('act.manual'));
  const buttons: HTMLButtonElement[] = [];
  const showChapter = (id: string, focus = false): void => {
    for (const button of buttons) {
      if (button.dataset.chapter === id) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
    article.replaceChildren(el('h3', 'guide-title', t(`help.h.${id}`)));
    for (const paragraph of t(`help.b.${id}`).split('\n').filter(Boolean)) article.append(el('p', 'guide-paragraph', paragraph));
    article.scrollTop = 0;
    if (focus) article.focus();
  };
  for (const [index, id] of CHAPTERS.entries()) {
    const button = el('button', 'guide-chapter');
    button.type = 'button';
    button.dataset.chapter = id;
    button.append(el('span', 'guide-index', String(index + 1).padStart(2, '0')), el('span', '', t(`help.h.${id}`)));
    button.addEventListener('click', () => showChapter(id));
    buttons.push(button);
    nav.append(button);
  }
  nav.addEventListener('keydown', event => {
    const horizontal = getComputedStyle(nav).flexDirection === 'row';
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 || (!horizontal && event.key === 'ArrowLeft')) return;
    event.preventDefault();
    if (!horizontal && event.key === 'ArrowRight') { article.focus(); return; }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (at + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]!.focus();
    showChapter(CHAPTERS[next]!);
  });
  layout.append(nav, article);
  body.append(layout);
  showChapter(CHAPTERS[0]!);
  return mount(t('act.manual'), body, 'help-guide');
}
