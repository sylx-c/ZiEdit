import { FindBar, buildNeedleRe, type FindRunResult } from '../text-view/findbar';
import type { FindOptions } from '../common/ipc';

/** 阅读面查找只操作 DOM Range，不改 Markdown，也不跳到隐藏的源缓冲。
 *  onRequestReplace（可选）：▸ 展开替换的引导回调——预览无编辑面，由宿主带查找词切可编辑形态。 */
export class PreviewFind {
  private readonly bar: FindBar;
  private key = '';
  private current = -1;
  constructor(private host: HTMLElement, onRequestReplace?: () => void) {
    this.bar = new FindBar({
      run: async (needle, opts, dir, _count, jump) => this.run(needle, opts, dir, jump),
      onClosed: () => { host.classList.remove('md-preview-searching'); host.focus(); },
      onRequestReplace,
    });
    host.tabIndex = 0;
    host.before(this.bar.el);
    this.bar.el.classList.add('md-preview-find');
  }

  /** 当前查找词（▸ 引导切形态时接力） */
  get needle(): string {
    return this.bar.inputEl.value;
  }
  show(): void { this.host.classList.add('md-preview-searching'); this.bar.show(); }
  step(dir: 1 | -1): void {
    if (!this.bar.visible) this.show();
    else if (dir === 1) this.bar.stepNext();
    else this.bar.stepPrev();
  }
  selectAll(): void {
    const range = document.createRange(); range.selectNodeContents(this.host);
    document.getSelection()?.removeAllRanges(); document.getSelection()?.addRange(range);
  }
  destroy(): void { this.bar.hide(); this.bar.el.remove(); }
  private run(needle: string, opts: FindOptions, dir: 1 | -1, jump: boolean): FindRunResult {
    const nodes: Array<{ node: Text; start: number; end: number }> = [];
    const walker = document.createTreeWalker(this.host, NodeFilter.SHOW_TEXT);
    let text = '';
    let lastBlock: Element | null = null;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.data || node.parentElement?.closest('script,style')) continue;
      const block = node.parentElement?.closest('p,h1,h2,h3,h4,h5,h6,li,pre,td,th') ?? null;
      if (lastBlock && block !== lastBlock) text += '\n';
      lastBlock = block;
      nodes.push({ node, start: text.length, end: text.length + node.length });
      text += node.data;
    }
    const key = JSON.stringify([needle, opts]);
    if (key !== this.key) { this.key = key; this.current = -1; }
    const re = buildNeedleRe(needle, opts);
    const scan = new RegExp(re.source, re.flags + 'g');
    let total = 0, before = 0;
    let first: RegExpExecArray | null = null, last: RegExpExecArray | null = null, chosen: RegExpExecArray | null = null;
    for (let match = scan.exec(text); match; match = scan.exec(text)) {
      if (!match[0]) { scan.lastIndex++; continue; }
      first ??= match; last = match;
      if (dir === 1 && !chosen && match.index > this.current) { chosen = match; before = total; }
      if (dir === -1 && (this.current < 0 || match.index < this.current)) { chosen = match; before = total; }
      total++;
    }
    if (!chosen) { chosen = dir === 1 ? first : last; before = dir === 1 ? 0 : total - 1; }
    if (jump && chosen) {
      this.current = chosen.index;
      const start = nodes.find(n => n.end > chosen!.index)!;
      const endPos = chosen.index + chosen[0].length;
      const end = nodes.find(n => n.end >= endPos)!;
      const range = document.createRange();
      range.setStart(start.node, chosen.index - start.start); range.setEnd(end.node, endPos - end.start);
      document.getSelection()?.removeAllRanges(); document.getSelection()?.addRange(range);
      start.node.parentElement?.scrollIntoView({ block: 'center' });
    }
    return { hit: chosen ? { line: 0, col: chosen.index } : null,
      counts: { total, before: chosen ? before : null } };
  }
}
