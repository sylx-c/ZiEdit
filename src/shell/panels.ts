// panels —— 侧栏面板（符号列表 006 / 查找文件 Ctrl+Shift+F / 设置）+ 通用覆盖层
import {
  checksum,
  findInFiles,
  findCancel,
  textSave,
  normalizeSave,
  normalizePreview,
  encodeConvertSave,
  ENC_TARGETS,
  textLines,
  textOpen,
} from '../common/ipc';
import { listen } from '@tauri-apps/api/event';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { parseCsvLine, sniffDelim } from '../csv-view/table';
import { extractTreeSymbols, loadHighlightParser } from '../text-view/highlight';
import { dlgAlert, overlayDialog, type OverlayMask } from './chrome';
import { t, tf } from '../common/i18n';
import { writeClipboardText } from '../common/clipboard';

/** 保存目标的词法规范化；Windows 路径不区分大小写。 */
export function sameSavePath(a: string, b: string): boolean {
  const normalize = (path: string) => {
    const windows = /^[a-z]:[\\/]|^\\\\/i.test(path);
    const parts: string[] = [];
    for (const part of path.replace(/\\/g, '/').split('/')) {
      if (part === '.' || !part) continue;
      if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else parts.push(part);
    }
    const result = parts.join('/');
    return windows ? result.toLowerCase() : result;
  };
  return normalize(a) === normalize(b);
}

function assertSaveAllowed(opts: { path: string; isReadOnly?: () => boolean }, target?: string): void {
  if (opts.isReadOnly?.()) throw new Error(t('set.readOnlyMode'));
  if (target && sameSavePath(opts.path, target)) throw new Error(t('save.sourceTargetSame'));
}

/**
 * 规范化另存共享对话框（002 增补 / 008 规则 12 v0.2）：编辑菜单入口与对比视图
 * 工具栏入口同一实现；对比视图经 pathNote 附"作用于 A 侧"提示。挂载后返回 body。
 */
export function normalizeSaveDialog(opts: {
  isReadOnly?: () => boolean;
  path: string;
  title: string;
  flash: (msg: string) => void;
  /** 顶部路径说明行（如"作用于 A：<路径>"），缺省不显示 */
  pathNote?: string;
  onError?: (msg: string) => void;
}): HTMLElement {
  const body = document.createElement('div');
  body.className = 'ov-body';
  if (opts.pathNote) {
    const note = document.createElement('div');
    note.className = 'ov-path';
    note.textContent = opts.pathNote;
    body.appendChild(note);
  }
  const mk = (label: string, key: string) => {
    const lab = document.createElement('label');
    lab.className = 'set-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.opt = key;
    lab.append(cb, document.createTextNode(label));
    body.appendChild(lab);
  };
  mk(t('cmp.stripBom'), 'stripBom');
  mk(t('cmp.nfc'), 'nfc');
  mk(t('cmp.fullToHalf'), 'fullToHalf');
  const nlLab = document.createElement('label');
  nlLab.className = 'set-row';
  const nlSel = document.createElement('select');
  const nlOpts: Array<[string, string]> = [['', t('cmp.eolKeep')], ['LF', '→ LF'], ['CRLF', '→ CRLF']];
  for (const [v, lab] of nlOpts) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = lab;
    nlSel.appendChild(o);
  }
  nlLab.append(document.createTextNode(t('cmp.eolLabel')), nlSel);
  body.appendChild(nlLab);
  // 预览修复 diff（008 规则 12 v0.6：勾选 → 预览 → 另存）
  const currentOpts = () => ({
    stripBom: (body.querySelector('[data-opt=stripBom]') as HTMLInputElement)?.checked ?? false,
    nfc: (body.querySelector('[data-opt=nfc]') as HTMLInputElement)?.checked ?? false,
    newline: nlSel.value || null,
    fullToHalf: (body.querySelector('[data-opt=fullToHalf]') as HTMLInputElement)?.checked ?? false,
  });
  const pvBtn = document.createElement('button');
  pvBtn.className = 'dlg-btn';
  pvBtn.textContent = t('cmp.previewFix');
  const pvBox = document.createElement('div');
  pvBox.className = 'norm-preview';
  const renderPreview = (p: { same: boolean; changed: number; added: number; removed: number; sample: Array<{ line: number; before: string; after: string }> }) => {
    pvBox.textContent = '';
    if (p.same) {
      pvBox.appendChild(document.createTextNode(t('cmp.previewSame')));
      return;
    }
    const head = document.createElement('div');
    head.className = 'norm-preview-head';
    head.textContent = tf('cmp.previewChanged', p.changed, p.added, p.removed);
    pvBox.appendChild(head);
    for (const s of p.sample) {
      const row = document.createElement('div');
      row.className = 'norm-preview-row';
      const no = document.createElement('span');
      no.className = 'norm-preview-no';
      no.textContent = String(s.line);
      const pair = document.createElement('span');
      pair.className = 'norm-preview-pair';
      const b = document.createElement('del');
      b.textContent = s.before || '·';
      const a = document.createElement('ins');
      a.textContent = s.after || '·';
      pair.append(b, a);
      row.append(no, pair);
      pvBox.appendChild(row);
    }
  };
  pvBtn.addEventListener('click', () => {
    void (async () => {
      try {
        renderPreview(await normalizePreview(opts.path, currentOpts()));
      } catch (err) {
        (opts.onError ?? dlgAlert)(tf('cmp.normalizeFail', String(err)));
      }
    })();
  });
  body.append(pvBtn, pvBox);
  const btn = document.createElement('button');
  btn.className = 'dlg-btn primary';
  btn.textContent = t('cmp.saveAsNew');
  btn.addEventListener('click', () => {
    const g = (k: string) => (body.querySelector(`[data-opt=${k}]`) as HTMLInputElement)?.checked ?? false;
    void (async () => {
      try { assertSaveAllowed(opts); } catch (err) { (opts.onError ?? dlgAlert)(String(err)); return; }
      const target = await saveDialog({
        defaultPath: (opts.path.split(/[\\/]/).pop() ?? 'a') + '.normalized',
      });
      if (!target) return;
      try {
        assertSaveAllowed(opts, target);
        await normalizeSave(opts.path, target, {
          stripBom: g('stripBom'),
          nfc: g('nfc'),
          newline: nlSel.value || null,
          fullToHalf: g('fullToHalf'),
        });
        (body.closest('.ov-mask') as OverlayMask | null)?.close();
        opts.flash(tf('cmp.normalizedSaved', target));
      } catch (err) {
        (opts.onError ?? dlgAlert)(tf('cmp.normalizeFail', String(err)));
      }
    })();
  });
  body.appendChild(btn);
  document.body.appendChild(overlayDialog(opts.title, body, () => void 0));
  return body;
}

export function encodeConvertDialog(opts: {
  isReadOnly?: () => boolean;
  path: string;
  fromEnc: string;
  title: string;
  flash: (msg: string) => void;
  pathNote?: string;
  onError?: (msg: string) => void;
}): HTMLElement {
  const body = document.createElement('div');
  body.className = 'ov-body';
  if (opts.pathNote) {
    const note = document.createElement('div');
    note.className = 'ov-path';
    note.textContent = opts.pathNote;
    body.appendChild(note);
  }
  const fromLab = document.createElement('label');
  fromLab.className = 'set-row';
  fromLab.append(document.createTextNode(t('cmp.srcEnc')), document.createTextNode(opts.fromEnc));
  body.appendChild(fromLab);
  const toLab = document.createElement('label');
  toLab.className = 'set-row';
  const sel = document.createElement('select');
  for (const e of ENC_TARGETS) {
    const o = document.createElement('option');
    o.value = e;
    o.textContent = e;
    if (e === 'UTF-8') o.selected = true;
    sel.appendChild(o);
  }
  toLab.append(document.createTextNode(t('enc.target')), sel);
  body.appendChild(toLab);
  const btn = document.createElement('button');
  btn.className = 'dlg-btn primary';
  btn.textContent = t('cmp.saveAsNew');
  btn.addEventListener('click', () => {
    void (async () => {
      try { assertSaveAllowed(opts); } catch (err) { (opts.onError ?? dlgAlert)(String(err)); return; }
      const target = await saveDialog({
        defaultPath: (opts.path.split(/[\\/]/).pop() ?? 'a') + '.' + sel.value.toLowerCase().replace(/-/g, ''),
      });
      if (!target) return;
      try {
        assertSaveAllowed(opts, target);
        await encodeConvertSave(opts.path, target, sel.value);
        (body.closest('.ov-mask') as OverlayMask | null)?.close();
        opts.flash(tf('enc.saved', sel.value, target));
      } catch (err) {
        (opts.onError ?? dlgAlert)(tf('enc.fail', String(err)));
      }
    })();
  });
  body.appendChild(btn);
  document.body.appendChild(overlayDialog(opts.title, body, () => void 0));
  return body;
}

/** 语言 → 符号正则（006 规则 1 的通用规则简化版） */
const SYMBOL_RULES: Record<string, RegExp[]> = {
  JavaScript: [/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/],
  TypeScript: [/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[=:]/],
  Python: [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)/],
  Rust: [/^\s*(?:(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn)\s+([A-Za-z_]\w*)/, /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/],
  Markdown: [/^#{1,6}\s+(.+)/],
  JSON: [/^\s{2}"([^"]+)"\s*:/],
  YAML: [/^(\s*)([A-Za-z_][\w-]*):/],
  C: [/^\s*(?:static\s+)?[A-Za-z_][\w\s\*]*\s+\**([A-Za-z_]\w*)\s*\(/],
  'C++': [/^\s*(?:[A-Za-z_][\w:<>,\s\*]+)\s+([A-Za-z_]\w*)\s*\(/, /^\s*(?:class|struct)\s+([A-Za-z_]\w*)/],
  Java: [/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:class|void|[A-Za-z_][\w<>\[\]]*)\s+([A-Za-z_]\w*)\s*\(/, /^\s*class\s+([A-Za-z_]\w*)/],
};

export interface SymbolItem {
  line: number;
  name: string;
  kind: string;
}

const TREE_SYMBOL_LANGS = ['JavaScript', 'TypeScript', 'Markdown', 'JSON', 'YAML'];

function usesTreeSymbols(text: string, language: string): boolean {
  if (!TREE_SYMBOL_LANGS.includes(language)) return false;
  let lineCount = 1;
  for (let at = text.indexOf('\n'); at >= 0 && lineCount <= 50000; at = text.indexOf('\n', at + 1)) lineCount++;
  return lineCount <= 50000;
}

/** 006 规则 6：编辑面大纲读当前未保存缓冲——文本版符号提取（Lezer 语言整树 ≤50000 行，其余正则词表）。 */
export function symbolsFromText(text: string, language: string): SymbolItem[] {
  if (usesTreeSymbols(text, language)) {
    return extractTreeSymbols(text, language).map(s => ({ line: s.line, name: s.name, kind: s.kind }));
  }
  const rules = SYMBOL_RULES[language];
  if (!rules) return [];
  const out: SymbolItem[] = [];
  let from = 0;
  let lineNo = 1;
  while (from <= text.length) {
    const end = text.indexOf('\n', from);
    const line = text.slice(from, end < 0 ? text.length : end);
    for (const re of rules) {
      const m = line.match(re);
      if (m && m[1]) {
        out.push({ line: lineNo, name: m[1].trim(), kind: t('sym.symbol') });
        break;
      }
    }
    if (end < 0) break;
    from = end + 1;
    lineNo++;
  }
  return out;
}

/** 大纲异步入口：同步解析前只加载当前语言对应的 Lezer 语法包。 */
export async function symbolsFromTextAsync(text: string, language: string): Promise<SymbolItem[]> {
  if (usesTreeSymbols(text, language)) await loadHighlightParser(language);
  return symbolsFromText(text, language);
}

export async function extractSymbols(path: string, language: string, encoding: string): Promise<SymbolItem[]> {
  const open = await textOpen(path);
  const total = open.totalLines || 0;
  if (!total || total > 200000) return [];
  const all: string[] = [];
  const BATCH = 5000;
  for (let from = 1; from <= total;) {
    const got = await textLines(path, from, Math.min(total, from + BATCH - 1), encoding);
    if (!got.length) break;
    for (let i = 0; i < got.length; i++) {
      if (got[i].no !== from + i) break;
      all.push(got[i].text);
    }
    from = got[got.length - 1]!.no + 1;
  }
  return symbolsFromTextAsync(all.join('\n'), language);
}

/** 校验和面板（001 规则 16） */
export function checksumPanel(path: string): HTMLElement {
  const body = document.createElement('div');
  body.className = 'ov-body';
  const head = document.createElement('div');
  head.textContent = path;
  head.className = 'ov-path';
  body.appendChild(head);
  for (const algo of ['crc32', 'md5', 'sha1', 'sha256'] as const) {
    const row = document.createElement('div');
    row.className = 'sum-row';
    const label = document.createElement('span');
    label.textContent = algo.toUpperCase();
    const val = document.createElement('span');
    val.textContent = '…';
    val.className = 'sum-val';
    row.append(label, val);
    body.appendChild(row);
    void checksum(path, algo)
      .then(h => {
        val.textContent = h;
        val.title = t('sum.copyTip');
        val.classList.add('clickable');
        val.addEventListener('click', () => void writeClipboardText(h));
      })
      .catch(e => {
        val.textContent = String(e);
      });
  }
  return body;
}

/** 跨文件搜索面板（006 规则 3-5） */
export function findInFilesPanel(root: string, onOpen: (path: string, line: number) => void): HTMLElement & { dispose(): void } {
  const body = Object.assign(document.createElement('div'), { dispose() {} });
  body.className = 'ov-body fif';
  const form = document.createElement('div');
  form.className = 'fif-form';
  const rootInput = document.createElement('input');
  rootInput.value = root;
  rootInput.className = 'fif-root';
  const needle = document.createElement('input');
  needle.placeholder = t('fif.needlePh');
  needle.className = 'fif-needle';
  const glob = document.createElement('input');
  glob.value = '*';
  glob.className = 'fif-glob';
  glob.title = t('fif.glob');
  glob.setAttribute('aria-label', t('fif.glob'));
  const caseCb = mkCb('Aa');
  const wordCb = mkCb('W');
  const reCb = mkCb('.*');
  const btn = document.createElement('button');
  btn.textContent = t('fif.search');
  const cancel = document.createElement('button');
  cancel.textContent = t('common.cancel');
  cancel.disabled = true;
  const exportBtn = document.createElement('button');
  exportBtn.textContent = t('fif.export');
  exportBtn.disabled = true;
  form.append(rootInput, glob, needle, caseCb, wordCb, reCb, btn, cancel, exportBtn);
  const status = document.createElement('div');
  status.className = 'fif-status';
  status.setAttribute('role', 'status');
  const result = document.createElement('div');
  result.className = 'fif-result';
  result.textContent = t('fif.hint');
  body.append(form, status, result);
  let activeJob: string | null = null;
  let disposed = false;
  let exportText = '';
  let cancelRequested = false;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    cancelRequested = true;
    clearTimeout(cancelTimer);
    if (!activeJob) return;
    const job = activeJob;
    void findCancel(job).catch(e => { if (!disposed) status.textContent = tf('fif.fail', String(e)); });
    // IPC 注册与取消可能交错，直到当前任务收口前继续送达取消请求。
    cancelTimer = setTimeout(() => { if (activeJob === job) stop(); }, 100);
  };
  body.dispose = () => { disposed = true; stop(); };
  cancel.addEventListener('click', stop);
  exportBtn.addEventListener('click', () => void (async () => {
    const text = exportText;
    try {
      const path = await saveDialog({ defaultPath: 'search-results.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
      if (path) await textSave(path, text, 'UTF-8', 0);
    } catch (e) { if (!disposed) status.textContent = tf('fif.fail', String(e)); }
  })());
  const run = async () => {
    if (activeJob || disposed || !needle.value) return;
    const jobId = crypto.randomUUID();
    activeJob = jobId;
    cancelRequested = false;
    btn.disabled = true;
    cancel.disabled = false;
    exportBtn.disabled = true;
    exportText = '';
    status.textContent = '';
    result.textContent = t('fif.searching');
    let unlisten: (() => void) | undefined;
    try {
      const query = { root: rootInput.value.trim(), needle: needle.value, glob: glob.value, options: {
        caseSensitive: (caseCb.querySelector('input') as HTMLInputElement).checked,
        wholeWord: (wordCb.querySelector('input') as HTMLInputElement).checked,
        regex: (reCb.querySelector('input') as HTMLInputElement).checked,
      } };
      unlisten = await listen<{ jobId: string; scanned: number }>('find-progress', event => {
        if (!disposed && event.payload.jobId === activeJob) status.textContent = tf('fif.progress', event.payload.scanned);
      });
      if (disposed || cancelRequested) { status.textContent = t('fif.cancelled'); return; }
      const report = await findInFiles(query.root, query.needle, query.options, jobId, query.glob);
      if (disposed) return;
      const files = report.files;
      status.textContent = tf('fif.summary', report.scanned, files.length, report.skippedCount)
        + (report.cancelled ? ` · ${t('fif.cancelled')}` : '')
        + (report.limits.length ? ` · ${t('fif.incomplete')}: ${report.limits.join(', ')}` : '');
      exportText = [JSON.stringify(query), status.textContent,
        ...files.flatMap(file => file.hits.map(hit => `${file.path}:${hit.line}:${hit.col}: ${hit.text}`)),
        ...report.skipped.map(item => `${t('fif.skipped')}: ${item.path}: ${item.reason}`),
        ...(report.skippedCount > report.skipped.length ? [tf('fif.omitted', report.skippedCount - report.skipped.length)] : []),
      ].join('\n');
      exportBtn.disabled = false;
      result.innerHTML = '';
      if (report.skippedCount) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = tf('fif.skippedCount', report.skippedCount);
        const list = document.createElement('pre');
        list.textContent = report.skipped.map(item => `${item.path}: ${item.reason}`).join('\n');
        if (report.skippedCount > report.skipped.length) list.textContent += '\n' + tf('fif.omitted', report.skippedCount - report.skipped.length);
        details.append(summary, list);
        result.append(details);
      }
      if (files.length === 0) {
        result.append(document.createTextNode(t('fif.noResult')));
        return;
      }
      for (const f of files) {
        const group = document.createElement('div');
        group.className = 'fif-file';
        const fh = document.createElement('div');
        fh.textContent = tf('fif.fileHits', f.path, f.hits.length);
        fh.className = 'fif-filehead';
        // P1-2（006 规则 3）：组内步进 ‹ n/N ›——逐个跳转该文件的命中行（双击行仍直达）
        const nav = document.createElement('span');
        nav.className = 'fif-nav';
        const pos = document.createElement('span');
        pos.className = 'fif-navpos';
        let cur = -1;
        const showPos = (): void => {
          pos.textContent = cur >= 0 ? `${cur + 1}/${f.hits.length}` : `–/${f.hits.length}`;
        };
        const step = (d: 1 | -1): void => {
          if (f.hits.length === 0) return;
          cur = (cur < 0 ? (d === 1 ? 0 : f.hits.length - 1) : (cur + d + f.hits.length) % f.hits.length);
          showPos();
          onOpen(f.path, f.hits[cur]!.line);
        };
        const mkNav = (label: string, d: 1 | -1): HTMLButtonElement => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'fb-step';
          b.title = label;
          b.textContent = d === 1 ? '▾' : '▴';
          b.addEventListener('click', () => step(d));
          return b;
        };
        nav.append(mkNav(t('fif.prev'), -1), pos, mkNav(t('fif.next'), 1));
        showPos();
        fh.appendChild(nav);
        group.appendChild(fh);
        for (const h of f.hits) {
          const item = document.createElement('div');
          item.className = 'fif-hit';
          const ln = document.createElement('span');
          ln.textContent = `${h.line}`;
          const tx = document.createElement('span');
          tx.textContent = h.text.trim().slice(0, 120);
          item.append(ln, tx);
          item.addEventListener('click', () => {
            (item.closest('.ov-mask') as OverlayMask | null)?.close();
            onOpen(f.path, h.line);
          });
          group.appendChild(item);
        }
        result.appendChild(group);
      }
    } catch (e) {
      if (!disposed) result.textContent = tf('fif.fail', String(e));
    } finally {
      unlisten?.();
      clearTimeout(cancelTimer);
      activeJob = null;
      btn.disabled = false;
      cancel.disabled = true;
    }
  };
  btn.addEventListener('click', () => void run());
  needle.addEventListener('keydown', e => {
    if (e.key === 'Enter') void run();
  });
  return body;
}

function mkCb(label: string): HTMLLabelElement {
  const lab = document.createElement('label');
  lab.className = 'tv-bar-cb';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  lab.append(cb, document.createTextNode(label));
  return lab;
}

/** CSV 嗅探导出（供路由判断复用） */
export { parseCsvLine, sniffDelim };
