// markdown-view/mdformat —— CM6 侧 Markdown 格式命令（007 v0.8 规则 17，自研，决策 011）
// 纯函数 applyFormat：输入文档与选区集合，输出变更与光标（不触碰 EditorView，可单测）；
// runMdFormat 薄封装：单次 dispatch = Ctrl+Z 单步撤销。多 range（列模式矩形选区）按序累计偏移。
import { EditorSelection, EditorState, type ChangeSpec, type Text } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { overlayDialog } from '../shell/chrome';
import { t } from '../common/i18n';

/** 格式命令（与 WYSIWYG 右键格式菜单项一一对应，007 规则 2/8 菜单同构） */
export type MdFormatCmd =
  | 'bold' | 'italic' | 'strike' | 'inlineCode'           // 包裹类（选区 toggle）
  | 'h1' | 'h2' | 'h3' | 'h4' | 'paragraph' | 'quote' | 'ul' | 'ol' | 'task' // 行前缀类
  | 'codeBlock' | 'hr' | 'link' | 'table';                // 插入类（模板）

/** 单条格式命令的输出（绝对坐标，应用到输入 doc 后的光标位置） */
export interface MdFormatResult {
  changes: ChangeSpec[];
  selection: { anchor: number; head: number }[];
}

export const MD_INLINE_COMMANDS = [
  ['bold', 'md.bold'], ['italic', 'md.italic'], ['strike', 'md.strike'],
  ['inlineCode', 'md.inlineCode'], ['link', 'md.link'],
] as const;
export const MD_BLOCK_COMMANDS = [
  ['h1', 'md.h1'], ['h2', 'md.h2'], ['h3', 'md.h3'], ['h4', 'md.h4'], ['paragraph', 'md.paragraph'],
  ['quote', 'md.quote'], ['ul', 'md.list'], ['ol', 'md.orderedList'], ['task', 'md.taskList'],
  ['codeBlock', 'md.codeBlock'], ['table', 'md.table'], ['hr', 'md.hr'],
] as const;

/** 源码与 IR 共用链接对话框；异步期间文档变化则拒绝过期坐标。 */
export function editMarkdownLink(view: EditorView, allowed: () => boolean): void {
  const doc = view.state.doc, range = view.state.selection.main;
  const body = document.createElement('div'); body.className = 'ov-body';
  const label = document.createElement('input'), url = document.createElement('input');
  label.value = doc.sliceString(range.from, range.to);
  for (const [name, input] of [[t('md.linkText'), label], [t('md.linkAddress'), url]] as const) {
    input.setAttribute('aria-label', name);
    const row = document.createElement('label'); row.textContent = name; row.append(input); body.append(row);
  }
  const submit = document.createElement('button'); submit.className = 'dlg-btn primary'; submit.textContent = t('common.ok'); body.append(submit);
  const mask = overlayDialog(t('md.link'), body, () => {});
  const insert = (): void => {
    if (!url.value.trim() || !allowed() || view.state.doc !== doc) return;
    const address = url.value.trim().replace(/[\s<>]/g, char => encodeURIComponent(char));
    const text = (label.value || url.value.trim()).replace(/[\\[\]]/g, '\\$&').replace(/\r?\n/g, ' ');
    const markdown = `[${text}](<${address}>)`;
    mask.close();
    view.dispatch({ changes: { from: range.from, to: range.to, insert: markdown }, selection: { anchor: range.from + markdown.length },
      userEvent: 'input.format', annotations: isolateHistory.of('full') });
    view.focus();
  };
  submit.addEventListener('click', insert);
  body.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); insert(); } });
  document.body.append(mask);
}

const WRAP: Partial<Record<MdFormatCmd, string>> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  inlineCode: '`',
};

const LINE_PREFIX: Partial<Record<MdFormatCmd, string>> = {
  paragraph: '',
  h1: '# ',
  h2: '## ',
  h3: '### ',
  h4: '#### ',
  quote: '> ',
  ul: '- ',
  ol: '1. ',
  task: '- [ ] ',
};

// 行首既有前缀（标题/引用/三列表互斥：应用任一行前缀命令先剥掉全部既有前缀）
// 组1为至多3空格缩进（CommonMark 顶层块允许的缩进；嵌套列表项的层级缩进不得被剥掉）
const ANY_PREFIX = /^( {0,3})(#{1,6} +|> ?|[-*+] \[[ x]\] +|[-*+] +|\d+\. +)/;
const LINE_INDENT = /^ {0,3}/;

/** 拆出行首缩进与前缀之后的正文；无前缀时 lead 为空、body 为整行 */
function splitPrefix(line: string): { lead: string; body: string } {
  const match = ANY_PREFIX.exec(line);
  if (!match) return { lead: '', body: line };
  return { lead: match[1]!, body: line.slice(match[0].length) };
}

function isCmdPrefix(cmd: MdFormatCmd, line: string): boolean {
  const rest = line.slice(LINE_INDENT.exec(line)![0].length);
  switch (cmd) {
    case 'h1': case 'h2': case 'h3': case 'h4':
      return rest.startsWith(LINE_PREFIX[cmd]!) && !rest.startsWith(LINE_PREFIX[cmd]! + '#');
    case 'quote': return /^> ?/.test(rest);
    case 'ul': return /^[-*+] (?!\[[ x]\] )/.test(rest);
    case 'ol': return /^\d+\. /.test(rest);
    case 'task': return /^[-*+] \[[ x]\] /.test(rest);
    default: return false;
  }
}

/**
 * 对 doc 的 ranges（按 from 升序、互不重叠）应用格式命令。
 * 包裹类：已包裹→去除；空选区→成对定界符光标居中；有选区→包裹并保持选中文本。
 * 行前缀类：选区覆盖行逐行 toggle；既有其他前缀先剥（互斥）；ol 对选中行 1..n 重编号。
 * 插入类：模板插入（空选区光标落于待填位置）。
 */
export function applyFormat(doc: Text, ranges: { from: number; to: number }[], cmd: MdFormatCmd): MdFormatResult {
  const changes: ChangeSpec[] = []; // 均为输入 doc 原始坐标（CM6 变更集合同时应用）
  const selection: { anchor: number; head: number }[] = []; // 均为应用变更后的坐标
  let off = 0; // 前序变更的累计偏移：原始坐标 → 变更后坐标

  const wrap = WRAP[cmd];
  if (wrap !== undefined) {
    for (const r of ranges) {
      const sel = doc.sliceString(r.from, r.to);
      if (sel.length >= wrap.length * 2 && sel.startsWith(wrap) && sel.endsWith(wrap)) {
        // 已包裹 → 去除定界符，选中原文本
        changes.push({ from: r.from, to: r.from + wrap.length, insert: '' });
        changes.push({ from: r.to - wrap.length, to: r.to, insert: '' });
        selection.push({ anchor: r.from + off, head: r.to + off - wrap.length * 2 });
        off -= wrap.length * 2;
      } else if (r.from >= wrap.length && r.to + wrap.length <= doc.length
        && doc.sliceString(r.from - wrap.length, r.from) === wrap
        && doc.sliceString(r.to, r.to + wrap.length) === wrap) {
        changes.push({ from: r.from - wrap.length, to: r.from, insert: '' });
        changes.push({ from: r.to, to: r.to + wrap.length, insert: '' });
        selection.push({ anchor: r.from + off - wrap.length, head: r.to + off - wrap.length });
        off -= wrap.length * 2;
      } else if (r.from === r.to) {
        // 空选区 → 成对定界符，光标居中
        changes.push({ from: r.from, to: r.to, insert: wrap + wrap });
        selection.push({ anchor: r.from + off + wrap.length, head: r.from + off + wrap.length });
        off += wrap.length * 2;
      } else {
        // 跨行选区：按行分别包裹（CommonMark 行内标记不可跨块——整段单一包裹会与围栏/列表
        // 等块级结构交叠成非法嵌套）；围栏代码内的行不包（代码内无行内语义，标记即字面文本）。
        // 行内段取该行选区交集中的首尾非空白字符（行首 ** 紧跟空格不构成强调）。
        const firstLine = doc.lineAt(r.from);
        const lastLine = doc.lineAt(r.to);
        if (firstLine.number === lastLine.number) {
          changes.push({ from: r.from, to: r.to, insert: wrap + sel + wrap });
          selection.push({ anchor: r.from + off + wrap.length, head: r.to + off + wrap.length });
          off += wrap.length * 2;
        } else {
          // 围栏状态：从文档头扫到选区首行（仅记录 ``` / ~~~ 围栏开关，性能可接受）
          let inFence = false;
          for (let n = 1; n < firstLine.number; n++) {
            const m = /^\s{0,3}(`{3,}|~{3,})/.exec(doc.line(n).text);
            if (m) inFence = !inFence;
          }
          let firstAnchor = -1, lastHead = -1;
          for (let n = firstLine.number; n <= lastLine.number; n++) {
            const line = doc.line(n);
            const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line.text);
            if (m) { inFence = !inFence; continue; } // 围栏行本身不动
            if (inFence) continue; // 代码内容行：字面保留
            const segFrom = Math.max(r.from, line.from);
            const segTo = Math.min(r.to, line.to);
            const seg = doc.sliceString(segFrom, segTo);
            const lead = seg.length - seg.trimStart().length;
            const trail = seg.length - seg.trimEnd().length;
            const text = seg.trim();
            if (!text) continue; // 空白行不包
            const from = segFrom + lead, to = segTo - trail;
            changes.push({ from, to, insert: wrap + text + wrap });
            if (firstAnchor < 0) firstAnchor = from + off + wrap.length;
            lastHead = to + off + wrap.length;
            off += wrap.length * 2;
          }
          if (lastHead >= 0) selection.push({ anchor: firstAnchor, head: lastHead });
          else selection.push({ anchor: r.from + off, head: r.from + off });
        }
      }
    }
    return { changes, selection };
  }

  const prefix = LINE_PREFIX[cmd];
  if (prefix !== undefined) {
    let olNum = 0; // ol 重编号计数（选中行 1..n）
    const edited = new Map<number, { from: number; removed: number; added: number; length: number }>();
    for (const r of ranges) {
      const first = doc.lineAt(r.from).number;
      const last = doc.lineAt(Math.max(r.from, r.to - (r.to > r.from ? 1 : 0))).number;
      for (let n = first; n <= last; n++) {
        if (edited.has(n)) continue;
        const line = doc.line(n);
        const raw = line.text;
        const was = isCmdPrefix(cmd, raw);
        const p = cmd === 'ol' && !was ? `${++olNum}. ` : prefix;
        const { lead, body } = splitPrefix(raw), added = was ? '' : p;
        // 空列表不能紧邻普通段落，否则 '-' 会成为Setext下划线，'1.'不能中断段落。
        const separate = !was && !body.trim() && ['ul', 'ol', 'task'].includes(cmd) && n > 1
          && !!doc.line(n - 1).text.trim() && !/^\s*(?:[-+*]|\d+[.)])\s/.test(doc.line(n - 1).text) ? '\n' : '';
        const next = separate + lead + added + body;
        edited.set(n, { from: line.from + off + separate.length, removed: raw.length - body.length, added: lead.length + added.length, length: body.length });
        changes.push({ from: line.from, to: line.to, insert: next });
        off += next.length - raw.length;
      }
      const map = (pos: number): number => {
        const line = doc.lineAt(pos), entry = edited.get(line.number);
        if (!entry) return pos + off; // 选区末尾恰在下一行行首。
        return entry.from + entry.added + Math.min(entry.length, Math.max(0, pos - line.from - entry.removed));
      };
      selection.push({ anchor: map(r.from), head: map(r.to) });
    }
    if (!selection.length) selection.push({ anchor: ranges[0]?.from ?? 0, head: ranges[0]?.to ?? 0 });
    return { changes, selection };
  }

  // 插入类
  for (const r of ranges) {
    let insert = '';
    let anchor = 0;
    let head = 0;
    if (cmd === 'codeBlock') {
      const sel = doc.sliceString(r.from, r.to);
      const left = doc.lineAt(r.from), right = doc.lineAt(r.to);
      const prefix = /^(\s*(?:>\s*)+|\s*(?:[-+*]|\d+[.)])\s+)/.exec(left.text)?.[0] ?? '';
      const continuation = prefix.includes('>') ? prefix : prefix.replace(/\S/g, ' ');
      const before = r.from > left.from ? '\n' + continuation : '';
      const after = r.to < right.to ? '\n' + continuation : '';
      let longest = 2;
      for (const run of sel.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
      const fence = '`'.repeat(longest + 1);
      if (sel) {
        insert = before + fence + '\n' + continuation + sel.replace(/\n/g, '\n' + continuation) + '\n' + continuation + fence + after;
        anchor = head = r.from + off + before.length + fence.length + 1 + continuation.length;
      } else {
        insert = before + fence + '\n' + continuation + '\n' + continuation + fence + after;
        anchor = head = r.from + off + before.length + fence.length + 1 + continuation.length;
      }
    } else if (cmd === 'hr') {
      insert = '\n\n---\n\n';
      anchor = head = r.from + off + insert.length;
    } else if (cmd === 'link') {
      const sel = doc.sliceString(r.from, r.to);
      insert = `[${sel || ''}](url)`;
      anchor = r.from + off + sel.length + 3; // 选中 url 占位符，直接键入替换
      head = anchor + 3;
    } else {
      // table：3×3 GFM 模板，光标落在首格内容起点（与链接选中 url 占位同一"待填位置"模式）。
      // 块级隔离：表格上下以空行分隔，否则相邻正文会被 GFM 宽松解析并入表格（007 v0.32 边界规则）。
      const left = doc.lineAt(r.from), right = doc.lineAt(r.to);
      const table = '| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n|  |  |  |';
      const before = r.from === 0 ? ''
        : r.from > left.from ? '\n\n'
        : left.number > 1 && doc.line(left.number - 1).text.trim() ? '\n' : '';
      const after = r.to < right.to ? '\n\n'
        : right.number < doc.lines && doc.line(right.number + 1).text.trim() ? '\n' : '';
      insert = before + table + after;
      anchor = head = r.from + off + before.length + 2; // '| ' 之后 = 首格「列1」起点
    }
    changes.push({ from: r.from, to: r.to, insert });
    selection.push({ anchor, head });
    off += insert.length - (r.to - r.from);
  }
  return { changes, selection };
}

/** 应用格式命令到 CM6 编辑器（单次 dispatch = 单步撤销，007 规则 17） */
export function runMdFormat(view: { state: EditorState; dispatch: (spec: object) => void }, cmd: MdFormatCmd): void {
  const ranges = view.state.selection.ranges.map(r => ({ from: r.from, to: r.to }));
  const { changes, selection } = applyFormat(view.state.doc, ranges, cmd);
  if (!changes.length) return;
  const sel = EditorSelection.create(
    selection.map(s => EditorSelection.range(s.anchor, s.head)),
    0
  );
  view.dispatch({ changes, selection: sel, userEvent: 'input.format', annotations: isolateHistory.of('full') });
}
