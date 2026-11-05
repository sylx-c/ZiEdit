import { EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, drawSelection, runScopeHandlers } from '@codemirror/view';
import { undo, redo, defaultKeymap } from '@codemirror/commands';
import { renderMarkdownInline } from './preview';
import { compositionChanged, compositionGuard, isComposing } from '../common/composition';
import { safeCell, limitTablePaste, tableModel, tableRowPrefix, runTableOperation, resizeTable, parseTablePaste, pasteTable, deleteTable, type TableOperation } from './table-model';
import { icon, flash } from '../shell/chrome';
import { t } from '../common/i18n';
import { tableCellAt, tableRowNumber } from './table-viewport';

export interface CellRange { from: number; to: number }
interface CellSession { editor: EditorView; main: EditorView; cell: HTMLTableCellElement; row: number; col: number; syncing: boolean; composed: boolean; leftPad: number; rightPad: number }
const sessions = new WeakMap<HTMLElement, CellSession>();
const pendingEnds = new WeakMap<CellSession, ReturnType<typeof setTimeout>>();

/** 等原生末笔和 CM 的 DOM 提交落地；超时才主动结束，回调以会话身份隔离。 */
function afterComposition(box: HTMLElement, session: CellSession, done: () => void): void {
  clearTimeout(pendingEnds.get(session));
  const deadline = Date.now() + 300;
  const wait = (): void => {
    if (sessions.get(box) !== session) return;
    if (!isComposing(session.editor)) { pendingEnds.delete(session); done(); return; }
    if (Date.now() >= deadline) {
      session.editor.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      session.editor.contentDOM.blur();
      pendingEnds.set(session, setTimeout(() => {
        pendingEnds.delete(session);
        if (sessions.get(box) === session) done();
      }, 0));
    } else pendingEnds.set(session, setTimeout(wait, 10));
  };
  wait();
}

function restoreCell(main: EditorView, box: HTMLElement, row: number, col: number): void {
  queueMicrotask(() => {
    if (!box.isConnected || main.state.readOnly) return;
    const cell = tableCellAt(box, row, col);
    if (cell) openCellEditor(main, box, cell);
  });
}

function applyOperation(main: EditorView, box: HTMLElement, operation: TableOperation): void {
  if (main.state.readOnly || isComposing(main)) return;
  destroyCellEditor(box);
  const target = runTableOperation(main, Number(box.dataset.mdTableFrom), Number(box.dataset.mdTableRow ?? 0),
    Number(box.dataset.mdTableCol ?? 0), operation);
  syncCellEditor(main, box);
  if (target) restoreCell(main, box, target.row, target.col);
}

export function refreshTableTools(main: EditorView, box: HTMLElement): void {
  const disabled = main.state.readOnly || isComposing(main);
  const row = Number(box.dataset.mdTableRow ?? 0), col = Number(box.dataset.mdTableCol ?? 0);
  const rows = Number(box.dataset.mdTableRows), cols = Number(box.dataset.mdTableCols);
  for (const button of box.querySelectorAll<HTMLButtonElement>('.mdir-tabletools button')) {
    const op = button.dataset.tableOp;
    button.disabled = disabled || ((op === 'rowAbove' || op === 'delRow' || op === 'rowUp' || op === 'rowDown') && row === 0)
      || (op === 'rowUp' && row <= 1) || (op === 'rowDown' && row === rows - 1)
      || (op === 'colPrev' && col === 0) || (op === 'colNext' && col === cols - 1)
      || (op === 'delCol' && cols === 1);
  }
  for (const input of box.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.mdir-tabletools input,.mdir-tabletools select')) input.disabled = disabled;
}

/** 局部工具条只持有视图，源坐标与目标格始终从当前容器读取。 */
export function createTableTools(main: EditorView): HTMLElement {
  const tools = document.createElement('div'); tools.className = 'mdir-tabletools';
  tools.setAttribute('role', 'toolbar'); tools.setAttribute('aria-label', t('ctx.table'));
  const operations: Array<[TableOperation, Parameters<typeof icon>[0]]> = [
    ['rowAbove', 'tableRow'], ['rowBelow', 'tableRow'], ['colLeft', 'tableColumn'], ['colRight', 'tableColumn'],
    ['delRow', 'cut'], ['delCol', 'cut'], ['rowUp', 'arrowUp'], ['rowDown', 'arrowDown'], ['colPrev', 'arrowLeft'], ['colNext', 'arrowRight'],
  ];
  for (const [op, glyph] of operations) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'tb';
    button.dataset.tableOp = op; button.title = t('tbl.' + op); button.setAttribute('aria-label', button.title);
    button.innerHTML = icon(glyph);
    button.addEventListener('mousedown', e => e.preventDefault());
    button.addEventListener('click', () => applyOperation(main, tools.closest<HTMLElement>('.mdir-tablebox')!, op));
    tools.append(button);
  }
  const align = document.createElement('select'); align.setAttribute('aria-label', t('tbl.align')); align.title = t('tbl.align');
  for (const value of ['left', 'center', 'right']) {
    const option = document.createElement('option'); option.value = value; option.textContent = t('tbl.' + value); align.append(option);
  }
  align.addEventListener('change', () => applyOperation(main, tools.closest<HTMLElement>('.mdir-tablebox')!, align.value as TableOperation));
  tools.append(align);
  for (const name of ['rows', 'cols']) {
    const label = document.createElement('label'); label.textContent = t('tbl.' + name);
    const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.max = name === 'rows' ? '1000' : '100';
    input.dataset.tableSize = name; input.title = t('tbl.' + name); input.setAttribute('aria-label', t('tbl.' + name)); label.append(input); tools.append(label);
  }
  const resize = document.createElement('button'); resize.type = 'button'; resize.className = 'tb';
  resize.title = t('tbl.resize'); resize.setAttribute('aria-label', resize.title); resize.innerHTML = icon('ruler');
  resize.addEventListener('click', () => {
    const box = tools.closest<HTMLElement>('.mdir-tablebox')!;
    const rows = tools.querySelector<HTMLInputElement>('[data-table-size=rows]')!;
    const cols = tools.querySelector<HTMLInputElement>('[data-table-size=cols]')!;
    if (!rows.reportValidity() || !cols.reportValidity()) return;
    if (main.state.readOnly || isComposing(main)) return;
    destroyCellEditor(box);
    if (resizeTable(main, Number(box.dataset.mdTableFrom), rows.valueAsNumber, cols.valueAsNumber)) restoreCell(main, box, 1, 0);
  });
  tools.append(resize);
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'tb';
  // (2026-10-29 走查修复) 此前直接塞 4 字文本进 26px 图标按钮——窄窗被逐字竖排；改用图标+title。
  remove.innerHTML = icon('tableRemove'); remove.title = t('tbl.deleteTable'); remove.setAttribute('aria-label', remove.title);
  remove.addEventListener('mousedown', e => e.preventDefault());
  remove.addEventListener('click', () => {
    if (main.state.readOnly || isComposing(main)) return;
    const box = tools.closest<HTMLElement>('.mdir-tablebox')!;
    // (2026-10-29 走查修复) 整表即将删除，单元格不回填渲染（少一层中间帧，也免把编辑中单元格序列化露出）
    destroyCellEditor(box, false);
    if (deleteTable(main, Number(box.dataset.mdTableFrom))) main.focus();
  });
  tools.append(remove);
  tools.addEventListener('focusout', () => queueMicrotask(() => {
    const box = tools.closest<HTMLElement>('.mdir-tablebox');
    if (box && !box.contains(document.activeElement)) destroyCellEditor(box);
  }));
  return tools;
}

export function cellRange(main: EditorView, box: HTMLElement, row: number, col: number, trim = true): CellRange | null {
  const start = Number(box.dataset.mdTableFrom);
  if (!Number.isInteger(start) || start < 0 || row < 0 || col < 0) return null;
  const lineNo = main.state.doc.lineAt(Math.min(start, main.state.doc.length)).number + row + (row > 0 ? 1 : 0);
  if (lineNo > main.state.doc.lines) return null;
  const line = main.state.doc.line(lineNo);
  const prefix = tableRowPrefix(line.text).length;
  const pipes: number[] = [];
  let slashes = 0;
  for (let i = prefix; i < line.length; i++) {
    const ch = line.text[i]!;
    if (ch === '|' && slashes % 2 === 0) pipes.push(line.from + i);
    slashes = ch === '\\' ? slashes + 1 : 0;
  }
  if (pipes[0] !== line.from + prefix) pipes.unshift(line.from + prefix - 1);
  if (pipes[pipes.length - 1] !== line.to - (line.text.match(/\s*$/)?.[0].length ?? 0) - 1) pipes.push(line.to);
  if (pipes[col] == null || pipes[col + 1] == null) return null;
  let from = pipes[col]! + 1, to = pipes[col + 1]!;
  if (!trim) return { from, to };
  const session = sessions.get(box);
  if (session?.row === row && session.col === col) {
    from = Math.min(to, from + session.leftPad);
    return { from, to: Math.max(from, to - session.rightPad) };
  }
  while (from < to && /\s/.test(main.state.doc.sliceString(from, from + 1))) from++;
  while (to > from && /\s/.test(main.state.doc.sliceString(to - 1, to))) to--;
  return { from, to };
}

export function destroyCellEditor(box: HTMLElement, render = true): void {
  const s = sessions.get(box);
  if (s) {
    if (render && !s.main.state.readOnly && isComposing(s.editor)) {
      afterComposition(box, s, () => destroyCellEditor(box, render));
      return;
    }
    const range = cellRange(s.main, box, s.row, s.col);
    sessions.delete(box);
    clearTimeout(pendingEnds.get(s)); pendingEnds.delete(s);
    s.editor.destroy();
    if (render) {
      s.cell.innerHTML = renderMarkdownInline(range ? s.main.state.doc.sliceString(range.from, range.to) : '');
      s.cell.dispatchEvent(new CustomEvent('mdir-cell-render', { bubbles: true, detail: { row: s.row, col: s.col } }));
    }
  }
}

/** 主文档撤销/菜单操作后回填当前格；微任务避开嵌套 CM 更新重入。 */
export function syncCellEditor(main: EditorView, box: HTMLElement): void {
  const session = sessions.get(box);
  if (!session) return;
  queueMicrotask(() => {
    if (sessions.get(box) !== session || isComposing(session.editor)) return;
    if (main.state.readOnly) { destroyCellEditor(box); return; }
    const range = cellRange(main, box, session.row, session.col);
    if (!range) { destroyCellEditor(box); return; }
    const text = main.state.doc.sliceString(range.from, range.to);
    if (safeCell(session.editor.state.doc.toString()) === text) return;
    const decoded = text.replace(/<br\s*\/?>/gi, '\n');
    const head = Math.min(session.editor.state.selection.main.head, decoded.length);
    session.syncing = true;
    session.editor.dispatch({ changes: { from: 0, to: session.editor.state.doc.length, insert: decoded },
      selection: { anchor: head }, annotations: Transaction.addToHistory.of(false) });
    session.syncing = false;
  });
}

export function activeCell(box: HTMLElement): HTMLTableCellElement | undefined { return sessions.get(box)?.cell; }

export function openCellEditor(main: EditorView, box: HTMLElement, cell: HTMLTableCellElement, selection?: { anchor: number; head: number }): void {
  if (main.state.readOnly || sessions.get(box)?.cell === cell) return;
  const previous = sessions.get(box);
  if (previous && isComposing(previous.editor)) {
    afterComposition(box, previous, () => {
      if (box.contains(cell)) openCellEditor(main, box, cell, selection);
    });
    return;
  }
  destroyCellEditor(box);
  const row = tableRowNumber(cell);
  const col = cell.cellIndex;
  box.dataset.mdTableRow = String(row); box.dataset.mdTableCol = String(col);
  const model = tableModel(main.state, Number(box.dataset.mdTableFrom));
  const rowsInput = box.querySelector<HTMLInputElement>('[data-table-size=rows]');
  const colsInput = box.querySelector<HTMLInputElement>('[data-table-size=cols]');
  const alignSelect = box.querySelector<HTMLSelectElement>('.mdir-tabletools select');
  if (rowsInput) rowsInput.value = String(Math.max(1, (model?.rows.length ?? 3) - 2));
  if (colsInput) colsInput.value = String(model?.rows[0]?.length ?? 1);
  if (alignSelect) {
    const delimiter = model?.rows[1]?.[col] ?? '---';
    alignSelect.value = delimiter.endsWith(':') ? delimiter.startsWith(':') ? 'center' : 'right' : 'left';
  }
  let range = cellRange(main, box, row, col);
  if (!range) {
    // GFM 允许正文行少于表头列数；用户进入补空格时，显式补齐所需分隔符。
    const start = Number(box.dataset.mdTableFrom);
    const line = main.state.doc.line(main.state.doc.lineAt(start).number + row + (row > 0 ? 1 : 0));
    let count = 0;
    while (cellRange(main, box, row, count, false)) count++;
    const closed = /(?:^|[^\\])(?:\\\\)*\|\s*$/.test(line.text);
    // 无右外缘时先封住旧末格，再追加空格；仅补一个尾竖线仍只会被 GFM 当外缘。
    main.dispatch({ changes: { from: line.to, insert: (closed ? '' : ' |') + '  |'.repeat(col - count + 1) }, userEvent: 'input' });
    range = cellRange(main, box, row, col);
  }
  if (!range) return;
  const source = main.state.doc.sliceString(range.from, range.to);
  const text = source.replace(/<br\s*\/?>/gi, '\n');
  const localSelection = selection ? {
    anchor: source.slice(0, Math.max(0, selection.anchor - range.from)).replace(/<br\s*\/?>/gi, '\n').length,
    head: source.slice(0, Math.max(0, selection.head - range.from)).replace(/<br\s*\/?>/gi, '\n').length,
  } : { anchor: text.length, head: text.length };
  cell.replaceChildren();
  delete cell.dataset.mdCellHtml;
  const raw = cellRange(main, box, row, col, false)!;
  const session = { main, cell, row, col, syncing: false, composed: false, leftPad: range.from - raw.from, rightPad: raw.to - range.to } as CellSession;
  const go = (dir: 1 | -1): boolean => {
    if (isComposing(session.editor)) return false;
    const count = Number(box.dataset.mdTableCols), rows = Number(box.dataset.mdTableRows);
    const index = row * count + col + dir;
    const next = index >= 0 && index < rows * count ? tableCellAt(box, Math.floor(index / count), index % count) : undefined;
    if (next) { openCellEditor(main, box, next); return true; }
    if (dir < 0) return true;
    // 末格 Tab 只追加一行，仍由主文档历史记录。
    const at = Number(box.dataset.mdTableTo);
    const start = Number(box.dataset.mdTableFrom);
    const model = tableModel(main.state, start);
    const prefix = model?.prefixes[1] ?? '';
    main.dispatch({ changes: { from: at, insert: '\n' + prefix + '|' + '  |'.repeat(count) }, userEvent: 'input' });
    restoreCell(main, box, rows, 0);
    return true;
  };
  const vertical = (dir: 1 | -1): boolean => {
    if (isComposing(session.editor)) return false;
    const next = row + dir;
    if (next >= 0 && next < Number(box.dataset.mdTableRows)) {
      const target = tableCellAt(box, next, col);
      if (target) openCellEditor(main, box, target);
    }
    return true;
  };
  const horizontal = (dir: 1 | -1): boolean => {
    const selection = session.editor.state.selection.main;
    if (!selection.empty || selection.head !== (dir < 0 ? 0 : session.editor.state.doc.length)) return false;
    if (dir > 0 && row === Number(box.dataset.mdTableRows) - 1 && col === Number(box.dataset.mdTableCols) - 1) return true;
    return go(dir);
  };
  session.editor = new EditorView({ parent: cell, state: EditorState.create({ doc: text,
    selection: localSelection, extensions: [drawSelection(),
      compositionGuard(main, () => {
        if (sessions.get(box) !== session || pendingEnds.has(session)) return;
        if (!session.editor.dom.contains(document.activeElement)) destroyCellEditor(box);
        else syncCellEditor(main, box);
      }),
      EditorView.contentAttributes.of({ 'aria-label': `表格第 ${row + 1} 行第 ${col + 1} 列` }),
      keymap.of([
        { key: 'Tab', run: () => go(1) }, { key: 'Shift-Tab', run: () => go(-1) },
        { key: 'Mod-Enter', run: () => { applyOperation(main, box, 'rowBelow'); return true; } },
        { key: 'Enter', run: () => vertical(1) },
        { key: 'ArrowUp', run: () => vertical(-1) }, { key: 'ArrowDown', run: () => vertical(1) },
        { key: 'ArrowLeft', run: () => horizontal(-1) }, { key: 'ArrowRight', run: () => horizontal(1) },
        { key: 'Escape', run: () => { destroyCellEditor(box); main.focus(); return true; } },
        { key: 'Mod-z', run: () => undo(main) }, { key: 'Mod-Shift-z', run: () => redo(main) },
        { key: 'Mod-y', run: () => redo(main) },
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of(u => {
        refreshTableTools(main, box);
        if (sessions.get(box) !== session || session.syncing || main.state.readOnly) return;
        if (u.transactions.some(tr => tr.effects.some(e => e.is(compositionChanged) && e.value))) session.composed = false;
        const current = cellRange(main, box, row, col);
        if (!current) return;
        const selection = u.state.selection.main;
        const raw = u.state.doc.toString();
        const anchor = current.from + safeCell(raw.slice(0, selection.anchor)).length;
        const head = current.from + safeCell(raw.slice(0, selection.head)).length;
        if (u.docChanged) {
          // CM 会无条件把 compose 合并到上一事件；首笔必须标记 compose.start。
          const composing = isComposing(session.editor);
          const userEvent = composing ? (session.composed ? 'input.type.compose' : 'input.type.compose.start') : 'input.type';
          session.composed ||= composing;
          main.dispatch({ changes: { ...current, insert: safeCell(raw) }, selection: { anchor, head }, userEvent,
            annotations: Transaction.time.of(u.transactions[0]?.annotation(Transaction.time) ?? Date.now()) });
        }
        else if (u.selectionSet) main.dispatch({ selection: { anchor, head } });
      }),
    ] }) });
  sessions.set(box, session);
  session.editor.contentDOM.addEventListener('paste', e => {
    if (main.state.readOnly || isComposing(session.editor)) return;
    const original = e.clipboardData?.getData('text/plain') ?? '';
    const text = limitTablePaste(original);
    if (text !== original) flash('表格粘贴内容已截断至 1 MB');
    const grid = parseTablePaste(text);
    if (!grid || !text.includes('\t')) {
      if (!text.includes('\n') && !text.includes('\r') && text === original) return;
      e.preventDefault(); e.stopImmediatePropagation();
      session.editor.dispatch(session.editor.state.replaceSelection(text.replace(/\r\n?/g, '\n')));
      return;
    }
    e.preventDefault(); e.stopImmediatePropagation();
    destroyCellEditor(box);
    if (pasteTable(main, Number(box.dataset.mdTableFrom), row, col, grid)) restoreCell(main, box, row, col);
  }, true);
  // 格内选区已映射主文档：保存、查找和格式命令复用主编辑器；其余全局命令交回 shell。
  session.editor.dom.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (!e.defaultPrevented && mod && /^[sfhbik1-4]$/.test(key) && runScopeHandlers(main, e, 'editor')) {
      e.preventDefault();
    }
    if (e.defaultPrevented || (mod && /^[acvxzy]$/.test(key))) e.stopPropagation();
  });
  session.editor.dom.addEventListener('focusout', () => queueMicrotask(() => {
    if (sessions.get(box) === session && !session.editor.dom.contains(document.activeElement)
      && !box.querySelector('.mdir-tabletools')?.contains(document.activeElement)) destroyCellEditor(box);
  }));
  main.dispatch({ selection: { anchor: range.from + safeCell(text.slice(0, localSelection.anchor)).length,
    head: range.from + safeCell(text.slice(0, localSelection.head)).length } });
  session.editor.focus();
  refreshTableTools(main, box);
}
