import { getLang, t, type Lang } from '../common/i18n';
import { clampFontSize } from '../common/fontSize';
import type { Settings } from '../common/ipc';
import { overlayDialog, type OverlayMask } from './chrome';
import './settings.css';

/** The shell retains ownership of persistence, language switching and view effects. */
export interface SettingsDialogContext {
  getSettings(): Settings;
  save(settings: Settings): void;
  switchLanguage(language: Lang): void;
  clearRemembered(): void;
  browseSnapshot(defaultPath?: string): Promise<string | null>;
}

let dialogSequence = 0;

export function openSettingsDialog(ctx: SettingsDialogContext): OverlayMask {
  const initial = ctx.getSettings();
  const prefix = `settings-${++dialogSequence}`;
  let controlSequence = 0;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
    const el = document.createElement(tag);
    el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const body = node('div', 'settings-content');
  const intro = node('p', 'settings-intro', t('set.intro'));
  const scroll = node('div', 'settings-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', t('set.title'));
  const form = node('form', 'settings-form');
  const footer = node('div', 'settings-footer');
  const cancel = node('button', 'dlg-btn', t('common.cancel'));
  cancel.type = 'button';
  const save = node('button', 'dlg-btn primary', t('ed.save'));
  save.type = 'submit';
  footer.append(cancel, save);
  scroll.append(form);
  body.append(intro, scroll, footer);

  const identify = <T extends HTMLInputElement | HTMLSelectElement>(input: T, name: string): T => {
    input.id = `${prefix}-${++controlSequence}`;
    input.name = name;
    return input;
  };
  const checkbox = (name: string, checked: boolean): HTMLInputElement => {
    const el = identify(node('input', ''), name);
    el.type = 'checkbox'; el.checked = checked;
    return el;
  };
  const number = (name: string, value: number, min: number, max?: number): HTMLInputElement => {
    const el = identify(node('input', 'settings-number'), name);
    el.type = 'number'; el.min = String(min); el.step = '1'; el.value = String(value);
    if (max !== undefined) el.max = String(max);
    return el;
  };
  const select = (name: string, value: string, options: Array<[string, string]>): HTMLSelectElement => {
    const el = identify(node('select', ''), name);
    for (const [v, key] of options) {
      const option = document.createElement('option'); option.value = v; option.textContent = t(key); el.append(option);
    }
    el.value = value;
    return el;
  };
  const row = (key: string, input: HTMLInputElement | HTMLSelectElement, ...extra: HTMLElement[]): HTMLElement => {
    const el = node('div', 'settings-row');
    const label = node('label', 'settings-label', t(key)); label.htmlFor = input.id;
    const controls = node('div', 'settings-controls'); controls.append(input, ...extra);
    el.append(label, controls);
    return el;
  };
  const group = (key: string, hint: string, ...rows: HTMLElement[]): void => {
    const fieldset = node('fieldset', 'settings-group');
    const legend = node('legend', '', t(key));
    const description = node('p', 'settings-group-hint', t(hint));
    description.id = `${prefix}-hint-${key.replace(/^.*\./, '')}`;
    fieldset.setAttribute('aria-describedby', description.id);
    fieldset.append(legend, description, ...rows); form.append(fieldset);
  };
  const color = (name: string, key: string, value: string | undefined, fallback: string) => {
    const enabled = checkbox(`${name}Enabled`, !!value);
    enabled.setAttribute('aria-label', `${t(key)} · ${t('set.backupOn')}`);
    const picker = identify(node('input', ''), name);
    picker.type = 'color'; picker.value = value ?? fallback; picker.disabled = !enabled.checked;
    picker.setAttribute('aria-label', t(key));
    enabled.addEventListener('change', () => { picker.disabled = !enabled.checked; });
    return { enabled, picker };
  };

  const theme = select('theme', initial.theme ?? 'paper', [
    ['paper', 'theme.paper'], ['cool', 'theme.cool'], ['graphite', 'theme.graphite'], ['black', 'theme.black'],
  ]);
  const line = color('lineHl', 'set.lineHl', initial.lineHl, '#eaeef4');
  group('set.grpAppearance', 'set.hintAppearance', row('set.theme', theme), row('set.lineHl', line.enabled, line.picker));

  const readOnly = checkbox('readOnlyMode', initial.readOnlyMode === true);
  const fontSize = number('fontSize', initial.fontSize ?? 12, 10, 18);
  const markers = identify(node('input', ''), 'columnMarkers');
  markers.value = (initial.columnMarkers ?? []).join(','); markers.placeholder = t('set.markersPh');
  group('set.grpEdit', 'set.hintEdit', row('set.readOnlyMode', readOnly), row('set.fontSize', fontSize), row('set.markers', markers));

  const markdown = select('mdDefaultMode', initial.mdDefaultMode ?? 'ir', [
    ['ir', 'set.mdIr'], ['source', 'set.mdSource'], ['preview', 'act.mdPreview'],
  ]);
  group('set.grpMarkdown', 'set.hintMarkdown', row('set.mdDefault', markdown));

  const diffKeys = ['add', 'del', 'chg'] as const;
  const diffLabels = ['set.diffAdd', 'set.diffDel', 'set.diffChg'];
  const diffs = diffKeys.map((key, i) => color(`diff-${key}`, diffLabels[i]!, initial.diffColors?.[key], '#cccccc'));
  const reset = node('button', 'dlg-btn', t('set.diffReset')); reset.type = 'button';
  reset.addEventListener('click', () => {
    for (const diff of diffs) { diff.enabled.checked = false; diff.picker.disabled = true; }
  });
  const resetRow = node('div', 'settings-reset'); resetRow.append(reset);
  group('set.grpCompare', 'set.hintCompare', ...diffs.map((diff, i) => row(diffLabels[i]!, diff.enabled, diff.picker)), resetRow);

  const outline = color('outlineCur', 'set.outlineCur', initial.outlineCur, '#3377cc');
  group('set.grpOutline', 'set.hintOutline', row('set.outlineCur', outline.enabled, outline.picker));

  const autosave = number('autoSaveSec', initial.autoSaveSec ?? 15, 0);
  const target = select('autoSaveTarget', initial.autoSaveTarget ?? 'sidecar', [
    ['sidecar', 'set.autoSaveSidecar'], ['file', 'set.autoSaveFile'],
  ]);
  let snapshotDir = initial.snapshotDir;
  const directoryRow = node('div', 'settings-row settings-directory');
  const directoryTitle = node('span', 'settings-label', t('set.snapDir'));
  directoryTitle.id = `${prefix}-directory-title`;
  const directoryControls = node('div', 'settings-controls');
  const path = node('output', 'settings-path');
  path.id = `${prefix}-directory-path`;
  path.setAttribute('aria-labelledby', directoryTitle.id);
  const refreshPath = (): void => {
    path.textContent = snapshotDir || `${t('set.snapDirDefault')} (config/recovery/)`;
    path.title = path.textContent;
  };
  const browse = node('button', 'dlg-btn', t('set.snapDirBrowse')); browse.type = 'button';
  browse.setAttribute('aria-describedby', path.id);
  browse.addEventListener('click', () => {
    browse.disabled = true;
    void ctx.browseSnapshot(snapshotDir || undefined).then(selected => {
      if (!mask.isConnected || selected === null) return;
      snapshotDir = selected; refreshPath();
    }).catch(() => void 0).finally(() => { browse.disabled = false; });
  });
  const useDefault = node('button', 'dlg-btn', t('set.snapDirDefault')); useDefault.type = 'button';
  useDefault.addEventListener('click', () => { snapshotDir = undefined; refreshPath(); });
  refreshPath(); directoryControls.append(path, browse, useDefault); directoryRow.append(directoryTitle, directoryControls);
  const closeAutoSave = checkbox('closeAutoSave', initial.closeAutoSave === true);
  const backup = checkbox('backupEnabled', initial.backupEnabled !== false);
  const keep = number('backupKeep', initial.backupKeep ?? 3, 0, 10);
  keep.disabled = !backup.checked;
  backup.addEventListener('change', () => { keep.disabled = !backup.checked; });
  group('set.grpBackup', 'set.hintBackup', row('set.autosave', autosave), row('set.autoSaveTarget', target), directoryRow,
    row('settings.closeAutoSave', closeAutoSave), row('set.backupOn', backup), row('set.backupKeep', keep));

  const language = select('language', getLang(), [['zh-CN', 'common.langZh'], ['en-US', 'common.langEn']]);
  language.addEventListener('change', () => {
    const picked = language.value as Lang;
    if (picked !== getLang()) ctx.switchLanguage(picked);
  });
  const close = select('closeBehavior', initial.closeBehavior ?? 'ask', [
    ['ask', 'set.closeAsk'], ['exit', 'set.closeExit'], ['tray', 'set.closeTray'],
  ]);
  const clear = node('button', 'dlg-btn', t('set.clearRemembered')); clear.type = 'button';
  const refreshClear = (): void => { clear.hidden = close.value !== 'ask' || !ctx.getSettings().rememberedCloseAction; };
  clear.addEventListener('click', () => { ctx.clearRemembered(); refreshClear(); });
  close.addEventListener('change', refreshClear); refreshClear();
  group('set.grpAdvanced', 'set.hintAdvanced', row('common.language', language), row('set.closeBehavior', close, clear));

  let mask: OverlayMask;
  cancel.addEventListener('click', () => mask.close());
  const saveSettings = (): void => {
    const diffColors: NonNullable<Settings['diffColors']> = {};
    for (const [i, key] of diffKeys.entries()) if (diffs[i]!.enabled.checked) diffColors[key] = diffs[i]!.picker.value;
    ctx.save({
      ...ctx.getSettings(),
      readOnlyMode: readOnly.checked,
      columnMarkers: markers.value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0).slice(0, 12),
      fontSize: clampFontSize(parseInt(fontSize.value, 10) || 12),
      autoSaveSec: Math.max(0, parseInt(autosave.value, 10) || 0),
      autoSaveTarget: target.value as Settings['autoSaveTarget'],
      snapshotDir: snapshotDir || undefined,
      closeAutoSave: closeAutoSave.checked,
      backupKeep: Math.min(10, Math.max(0, parseInt(keep.value, 10) || 0)),
      backupEnabled: backup.checked,
      theme: theme.value as Settings['theme'],
      mdDefaultMode: markdown.value as Settings['mdDefaultMode'],
      lineHl: line.enabled.checked ? line.picker.value : undefined,
      outlineCur: outline.enabled.checked ? outline.picker.value : undefined,
      diffColors: Object.keys(diffColors).length ? diffColors : undefined,
      language: language.value as Lang,
      closeBehavior: close.value as Settings['closeBehavior'],
    });
    mask.close();
  };
  // Keep the action bar outside the scrolling form while retaining native Enter submission.
  form.id = `${prefix}-form`;
  form.noValidate = true; // Values retain the existing clamp-on-save behavior.
  save.setAttribute('form', form.id);
  form.addEventListener('submit', event => { event.preventDefault(); saveSettings(); });
  mask = overlayDialog(t('set.title'), body, () => void 0);
  mask.classList.add('settings-mask');
  mask.querySelector('.ov-box')!.classList.add('settings-dialog');
  document.body.append(mask);
  return mask;
}
