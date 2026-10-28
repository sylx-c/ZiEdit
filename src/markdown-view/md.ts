// markdown-view —— 主线程 markdown-it 共享惰性单例。
// 修前 preview.ts 与 static-html.ts 各自模块级 `new MarkdownIt()`：主线程两份实例、
// 两套规则注册。两处配置对比结论：preview `{ html:false, linkify:true, typographer:false }`
// 附加行内规则/标题锚点/代码高亮；static-html `{ html:false }` 只消费与选项无关的
// `utils.unescapeAll / normalizeLink / validateLink`（原型行为，不随 options 变化）——
// 直接共享 preview 侧完整配置实例，static-html 行为不变。
// 加载形态：动态 import + Promise 缓存（实例与规则只建/注册一次），模块加载即预取；
// 同步渲染入口（renderMarkdown/renderMarkdownInline/静态序列化链接校验）都在预取完成
// 之后的宏任务里触发。headings.ts（worker 入口）按方案不动，其副本仍随 worker chunk
// 打包——worker 与主线程之间的库重复无法消除，属已知正常项。
import type { MarkdownIt } from 'markdown-it';
import { highlightLines, hasHighlight } from '../text-view/highlight';
import { normalizeReference, type FootnoteItem } from './headings';
import { renderPlaceholder } from './render-model';
import { bindMdLinkTools, __unbindMdLinkToolsForTest } from './md-link';
import emojiTable from './unicode-emojis.json';

/** Unicode 表情别名表（与 preview.ts 行内规则/IR 共用同一默认值来源） */
const unicodeEmojiValues: Readonly<Record<string, string>> = emojiTable;

let instance: MarkdownIt | null = null;
let loader: Promise<MarkdownIt> | null = null;

/** 动态 import 共享实例并完成一次性配置；Promise 缓存，重复调用共享同一实例。
 *  实例就绪后同时注入链接/实体工具接缝（./md-link）——headings.ts 的元数据提取（含
 *  主线程侧）经接缝取 unescapeAll/normalizeLink/validateLink，不再静态依赖本库。 */
export function loadMarkdownIt(): Promise<MarkdownIt> {
  return (loader ??= import('markdown-it').then(({ default: MarkdownIt }) => {
    const md = (instance ??= configure(new MarkdownIt({ html: false, linkify: true, typographer: false })));
    bindMdLinkTools(md);
    return md;
  }));
}

// 模块加载即预取：把一次加载成本挪出首渲（同步入口按约定只在预取完成后调用）。
// 失败时清空缓存允许下一次重试，且不产生未处理拒绝。
loadMarkdownIt().catch(() => { loader = null; });

/** 同步取共享实例。前置条件（FC 收口 1 就绪屏障约定）：调用发生前实例已就绪——
 *  模块加载即预取覆盖常规运行时；冷启动首解析前由各异步入口显式 await
 *  loadMarkdownIt()（renderPreviewInto / blockcache.render / LivePreviewView.init /
 *  extractHeadingsReady）。纯同步调用方（renderMarkdownInline/decodeMarkdownEntity
 *  的 CM 更新与测试桥）依赖预取或挂载屏障时机成立，属文档化前置条件。 */
export function markdownIt(): MarkdownIt {
  if (!instance) throw new Error('markdown-it 预取未完成：同步渲染入口早于模块加载完成');
  return instance;
}

/** 测试 seam：清空单例缓存并解除链接工具注入，模拟冷启动未预取（仅测试使用）。 */
export function __coldStartForTest(): void {
  instance = null;
  loader = null;
  __unbindMdLinkToolsForTest();
}

function configure(md: MarkdownIt): MarkdownIt {
  md.inline.ruler.before('emphasis', 'ziedit_math', (state, silent) => {
    const start = state.pos;
    if (state.src[start] !== '$' || state.src[start - 1] === '$' || state.src[start + 1] === '$' || /\s/.test(state.src[start + 1] ?? ' ')) return false;
    for (let end = start + 1; end < state.posMax; end++) {
      const char = state.src[end];
      if (char === '\n') break;
      if (char === '\\') { end++; continue; }
      if (char === '$' && !/\s/.test(state.src[end - 1]!)) {
        if (!silent) state.push('html_inline', '', 0).content = renderPlaceholder({ kind: 'math', display: false, source: state.src.slice(start + 1, end) })
          .replace('data-render-kind=', `data-render-offset="${start}" data-render-length="${end + 1 - start}" data-render-kind=`);
        state.pos = end + 1; return true;
      }
    }
    return false;
  });
  md.inline.ruler.before('link', 'ziedit_footnote', (state, silent) => {
    const match = /^\[\^([^\]\n]+)\]/.exec(state.src.slice(state.pos, state.posMax));
    const notes = (state.env as { footnotes?: ReadonlyMap<string, FootnoteItem> })?.footnotes;
    const label = match ? normalizeReference(match[1]!) : '';
    const note = notes?.get(label);
    if (!match || !note?.number) return false;
    if (!silent) state.push('html_inline', '', 0).content = `<a class="mdir-footnote-ref" href="#footnotes-def-${note.number}" data-md-note="${esc(label)}" data-md-offset="${state.pos}">${note.number}</a>`;
    state.pos += match[0].length; return true;
  });
  md.inline.ruler.before('emphasis', 'ziedit_inline', (state, silent) => {
    const rest = state.src.slice(state.pos, state.posMax);
    const emoji = /^:([\w+-]+):/.exec(rest);
    const value = emoji ? ((state.env as { emojis?: Readonly<Record<string, string>> })?.emojis ?? unicodeEmojiValues)[emoji[1]!] : undefined;
    if (emoji && value) {
      if (!silent) state.push('text', '', 0).content = value;
      state.pos += emoji[0].length; return true;
    }
    const match = /^(==)([^=\s](?:[^\n]*?[^=\s])?)==/.exec(rest) ?? /^(\^)([^\s^]+)\^/.exec(rest) ?? /^(~)([^\s~]+)~(?!~)/.exec(rest);
    if (!match || (match[1] === '~' && rest.startsWith('~~'))) return false;
    if (!silent) {
      const tag = match[1] === '==' ? 'mark' : match[1] === '^' ? 'sup' : 'sub';
      // D-T2-05（parity 锁暴露的存量缺陷）：修前用 state.md.inline.parse(match[2], …, state.tokens)
      // 把子解析的定界符后处理结果直插当前 token 流——外层 parse 结束时按索引配对 '*'/'~' 定界
      // 符会错位改写这些外来 token（`a *b* ==d==` 产出交叉标签丢内容）。改用 markdown-it 链接/
      // 强调同款模式：同 state 收窄 [pos, posMax] 再 tokenize，定界符归属同一配对上下文。
      const outerPos = state.pos, outerMax = state.posMax;
      state.push(tag + '_open', tag, 1);
      state.pos = outerPos + match[1]!.length;
      state.posMax = state.pos + match[2]!.length;
      state.md.inline.tokenize(state);
      state.pos = outerPos + match[0].length; state.posMax = outerMax;
      state.push(tag + '_close', tag, -1);
    } else {
      state.pos += match[0].length;
    }
    return true;
  });

  // 标题注入 data-line（markdown-it token.map 的起始行）：回退路径下大纲点击定位用
  const defHeadingOpen =
    md.renderer.rules.heading_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    if (t.map) t.attrSet('data-line', String(t.map[0]));
    return defHeadingOpen(tokens, idx, options, env, self);
  };

  md.set({
    highlight: (code: string, lang: string) => {
      if (lang && hasHighlight(normLang(lang), code.length)) {
        try {
          const lines = code.split('\n');
          const spans = highlightLines(lines, normLang(lang));
          const html = spans
            .map((lineSpans, i) => {
              const line = lines[i] ?? '';
              let out = '';
              let pos = 0;
              for (const s of lineSpans) {
                out += esc(line.slice(pos, s.from)) + `<span class="${s.cls}">${esc(line.slice(s.from, s.to))}</span>`;
                pos = s.to;
              }
              return out + esc(line.slice(pos));
            })
            .join('\n');
          return `<pre class="md-code"><code>${html}</code></pre>`;
        } catch {
          return '';
        }
      }
      return '';
    },
  });
  return md;
}

function normLang(l: string): string {
  const m: Record<string, string> = { js: 'JavaScript', ts: 'TypeScript', json: 'JSON', yaml: 'YAML', yml: 'YAML', md: 'Markdown' };
  return m[l] ?? (l.charAt(0).toUpperCase() + l.slice(1));
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
