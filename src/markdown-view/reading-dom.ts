import { mdLinkTools } from './md-link';
import { yieldToBrowser } from '../common/yield';

const VOID = new Set(['br', 'hr', 'img', 'input', 'wbr']);
const decode = (value: string): string => value.replace(/&(?:#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, entity => mdLinkTools().utils.unescapeAll(entity));
/** 保留代码高亮祖先与全部文本，把超长 pre 的首次布局拆成有界的行组。 */
async function splitCodeLayout(root: HTMLElement, current: () => boolean): Promise<void> {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
    if ((code.textContent?.length ?? 0) < 64 * 1024) continue;
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const ranges: Array<{ node: Text; offset: number; rows: number }> = [];
    let rows = 0, scanned = 0, deadline = performance.now() + 8;
    let last: Text | undefined, lastText = '';
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      // Text.data 是浏览器边界属性，逐字符读取会反复复制整段文本。
      const text = node.data; last = node; lastText = text;
      for (let offset = text.indexOf('\n'); offset >= 0; offset = text.indexOf('\n', offset + 1)) {
        if (++rows === 64) { ranges.push({ node, offset:offset + 1, rows }); rows = 0; }
        if (++scanned % 256 === 0 && performance.now() >= deadline) {
          await yieldToBrowser(); if (!current()) return; deadline = performance.now() + 8;
        }
      }
      if (performance.now() >= deadline) { await yieldToBrowser(); if (!current()) return; deadline = performance.now() + 8; }
    }
    const tail = ranges[ranges.length - 1];
    if (last && (tail?.node !== last || tail?.offset !== lastText.length)) ranges.push({ node:last, offset:lastText.length, rows:rows + (lastText.endsWith('\n') ? 0 : 1) });
    const fragment = document.createDocumentFragment(), range = document.createRange();
    let start: Node = code, offset = 0; deadline = performance.now() + 8;
    for (const end of ranges) {
      range.setStart(start, offset); range.setEnd(end.node, end.offset);
      const chunk = document.createElement('span'); chunk.className = 'md-code-chunk';
      chunk.style.containIntrinsicSize = `auto calc(${Math.max(1,end.rows)} * 1lh)`;
      // cloneContents 不包含共同祖先自身；同一高亮文本跨多片时须补回被省略的样式祖先。
      let contents: Node = range.cloneContents();
      let ancestor: Node | null = range.commonAncestorContainer;
      if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentNode;
      while (ancestor && ancestor !== code) {
        const wrapper = ancestor.cloneNode(false);
        wrapper.appendChild(contents); contents = wrapper; ancestor = ancestor.parentNode;
      }
      chunk.append(contents); fragment.append(chunk);
      start = end.node; offset = end.offset;
      if (performance.now() >= deadline) { await yieldToBrowser(); if (!current()) return; deadline = performance.now() + 8; }
    }
    if (current()) code.replaceChildren(fragment);
  }
}
/** 超长表保留所有行，用有界的行组跳过离屏布局，避免首次挂载一次布局数千行。 */
async function splitTableLayout(root: HTMLElement, current: () => boolean): Promise<void> {
  for (const table of root.querySelectorAll<HTMLTableElement>('table')) {
    const rows = [...table.tBodies].flatMap(body => [...body.rows]);
    if (rows.length < 256) continue;
    let spanned = false, deadline = performance.now() + 8;
    for (const row of rows) {
      if ([...row.cells].some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1)) { spanned = true; break; }
      if (performance.now() >= deadline) { await yieldToBrowser(); if (!current()) return; deadline = performance.now() + 8; }
    }
    if (spanned) continue;
    const widths: number[] = [];
    for (const row of [...table.tHead?.rows ?? [], ...rows]) {
      [...row.cells].forEach((cell, index) => { widths[index] = Math.max(widths[index] ?? 4, Math.min(120, cell.textContent?.length ?? 0)); });
      if (performance.now() >= deadline) { await yieldToBrowser(); if (!current()) return; deadline = performance.now() + 8; }
    }
    table.classList.add('md-reading-table');
    table.style.setProperty('--md-table-columns', widths.map(width => `minmax(0,${width + 4}fr)`).join(' '));
    const bodies = [...table.tBodies], fragment = document.createDocumentFragment();
    for (let from = 0; from < rows.length; from += 64) {
      const body = document.createElement('tbody'), part = rows.slice(from, from + 64);
      body.className = 'md-table-chunk';
      body.style.containIntrinsicSize = `auto ${part.length * 47}px`;
      body.append(...part); fragment.append(body);
      if (performance.now() >= deadline) { await yieldToBrowser(); if (!current()) return; deadline = performance.now() + 8; }
    }
    for (const body of bodies) body.remove();
    table.append(fragment);
  }
}
/** 大块按安全的 HTML 节点与文本片段构建；单次 innerHTML 不承担整块高亮/表格。 */
export async function fillReadingBlock(root: HTMLElement, html: string, current: () => boolean): Promise<void> {
  // 大块的调用方（编辑器创建、消息反序列化）可能还占着当前任务。先让出，避免叠成一次超 100ms 的长任务。
  // 小块保持同步：逐块让出会把普通文档的首屏拆成数百个定时器。
  if (html.length >= 64 * 1024) { await yieldToBrowser(); if (!current()) return; }
  if (html.length < 64 * 1024) { root.innerHTML = html; return; }
  const stack: HTMLElement[] = [root];
  const tokens = /<[^>]*>|[^<]+/g;
  let deadline = performance.now() + 8;
  for (let token = tokens.exec(html); token; token = tokens.exec(html)) {
    const part = token[0];
    if (part.startsWith('</')) { if (stack.length > 1) stack.pop(); }
    else if (part.startsWith('<')) {
      const tag = /^<([a-z][\w-]*)\b([^>]*)>/i.exec(part);
      if (tag && !/^(script|style|iframe|object|embed)$/i.test(tag[1]!)) {
        const element = document.createElement(tag[1]!);
        for (const match of tag[2]!.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
          const name = match[1]!;
          if (/^on/i.test(name)) continue;
          const value = decode(match[2] ?? match[3] ?? match[4] ?? '');
          element.setAttribute(name, value);
        }
        stack[stack.length - 1]!.append(element);
        if (!VOID.has(tag[1]!.toLowerCase()) && !part.endsWith('/>')) stack.push(element);
      }
    } else {
      for (let from = 0; from < part.length;) {
        let to = Math.min(part.length, from + 16 * 1024);
        // 实体和代理对在分片边界保持完整，代码中的反斜杠不作 Markdown 反转义。
        const amp = part.lastIndexOf('&', to - 1);
        if (to < part.length && amp >= from && to - amp < 40 && !part.slice(amp, to).includes(';')) to = amp || to;
        if (to < part.length && /[\uD800-\uDBFF]/.test(part[to - 1]!)) to--;
        stack[stack.length - 1]!.append(document.createTextNode(decode(part.slice(from, to))));
        from = to;
        if (performance.now() >= deadline) {
          await yieldToBrowser(); if (!current()) return;
          deadline = performance.now() + 8;
        }
      }
    }
    if (performance.now() >= deadline) {
      await yieldToBrowser(); if (!current()) return;
      deadline = performance.now() + 8;
    }
  }
  // 构建/重新分组可能各有不可抢占的 DOM 操作，不能与挂载及首次测量叠成同一任务。
  await yieldToBrowser(); if (!current()) return;
  if (current()) await splitCodeLayout(root, current);
  await yieldToBrowser(); if (!current()) return;
  if (current()) await splitTableLayout(root, current);
  await yieldToBrowser();
}
