// 语法高亮（决策 004）：Lezer 解析器按可视窗口解析 + classHighlighter 着色
// 查看路径不建全量编辑器（性能红线），窗口级解析（~100 行/次，毫秒级）。
import { classHighlighter, highlightTree } from '@lezer/highlight';
import type { Parser } from '@lezer/common';
import { t } from '../common/i18n';
import { safeSyntaxLanguage, safeSyntaxText } from './language-guard';

const lr = (l: { language: { parser: Parser } }): Parser => l.language.parser;

// 语言包拆为异步 chunk。同步渲染只使用已加载的解析器；调用方按需预载，完成后刷新，
// 启动和首屏不必等待当前场景用不到的语言包。
const parserLoaders: Record<string, () => Promise<Parser>> = {
  JSON: () => import('@codemirror/lang-json').then(m => lr(m.json())),
  JavaScript: () => import('@codemirror/lang-javascript').then(m => lr(m.javascript())),
  TypeScript: () => import('@codemirror/lang-javascript').then(m => lr(m.javascript({ typescript: true }))),
  Markdown: () => import('@codemirror/lang-markdown').then(m => lr(m.markdown())),
  YAML: () => import('@codemirror/lang-yaml').then(m => lr(m.yaml())),
  XML: () => import('@codemirror/lang-xml').then(m => lr(m.xml())),
  HTML: () => import('@codemirror/lang-html').then(m => lr(m.html())),
  CSS: () => import('@codemirror/lang-css').then(m => lr(m.css())),
  C: () => import('@codemirror/lang-cpp').then(m => lr(m.cpp())),
  'C++': () => import('@codemirror/lang-cpp').then(m => lr(m.cpp())),
  Python: () => import('@codemirror/lang-python').then(m => lr(m.python())),
  Rust: () => import('@codemirror/lang-rust').then(m => lr(m.rust())),
  Java: () => import('@codemirror/lang-java').then(m => lr(m.java())),
  SQL: () => import('@codemirror/lang-sql').then(m => lr(m.sql())),
};

const parserCache = new Map<string, Parser>();
const parserPending = new Map<string, Promise<Parser | null>>();

/** 同步读取已加载解析器；未预加载时返回 null，渲染调用可安全降级为纯文本。 */
export function getParser(language: string): Parser | null {
  return parserCache.get(language) ?? null;
}

export function hasHighlightParser(language: string): boolean {
  return Object.prototype.hasOwnProperty.call(parserLoaders, language);
}

/** 按需加载并缓存一种语言的解析器；同语言并发请求共享一次加载。 */
export function loadHighlightParser(language: string): Promise<Parser | null> {
  const cached = parserCache.get(language);
  if (cached) return Promise.resolve(cached);
  const pending = parserPending.get(language);
  if (pending) return pending;
  const load = parserLoaders[language];
  if (!load) return Promise.resolve(null);
  const request = load().then(parser => {
    parserCache.set(language, parser);
    return parser;
  }).finally(() => parserPending.delete(language));
  parserPending.set(language, request);
  return request;
}

/** 启用高亮的文件大小上限（超过走纯文本，保护大文件路径） */
export const HIGHLIGHT_LIMIT = 20 * 1024 * 1024;

/** 支持语法高亮的语言清单（002 规则 6；状态栏语言选择弹窗数据源；Log 为正则轻量着色，批 D-4） */
export const HIGHLIGHT_LANGS: readonly string[] = [...Object.keys(parserLoaders), 'Log', 'Go', 'Shell', 'Batch', 'PowerShell', 'Config'];

export function hasHighlight(language: string | null, size: number): boolean {
  return (
    !!language &&
    size <= HIGHLIGHT_LIMIT &&
    HIGHLIGHT_LANGS.includes(language)
  );
}

// 按当前位置消费 token：字符串/注释优先，避免区间重叠；只处理可视行。
const REGEX_RULES: Record<string, Array<[RegExp, string]>> = {
  Go: [
    [/^(?:\/\/.*|\/\*.*?(?:\*\/|$))/, 'tok-comment'],
    [/^(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`[^`]*`?)/, 'tok-string'],
    [/^\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/, 'tok-keyword'],
  ],
  Shell: [
    [/^#.*/, 'tok-comment'],
    [/^(?:"(?:\\.|[^"\\])*"?|'[^']*'?)/, 'tok-string'],
    [/^\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|return|export|local|readonly|echo|exit)\b/, 'tok-keyword'],
  ],
  Batch: [
    [/^(?:rem\b.*|::.*)/i, 'tok-comment'],
    [/^"[^"]*"?/, 'tok-string'],
    [/^\b(?:echo|set|setlocal|endlocal|if|else|for|in|do|goto|call|exit|not|exist|defined|pause|shift)\b/i, 'tok-keyword'],
  ],
  PowerShell: [
    [/^(?:#.*|<#.*?(?:#>|$))/, 'tok-comment'],
    [/^(?:"(?:`.|[^"`])*"?|'(?:''|[^'])*'?)/, 'tok-string'],
    [/^(?:\b(?:if|else|elseif|switch|foreach|for|while|do|until|function|param|return|filter|begin|process|end|try|catch|finally|throw|class|in)\b|\b(?:Write-Host|Write-Output|Get-ChildItem|Set-Variable)\b)/i, 'tok-keyword'],
  ],
  Config: [
    [/^[#;].*/, 'tok-comment'],
    [/^[\w.-]+(?=\s*[=:])/, 'tok-propertyName'],
    [/^[=:]\s*(?:"(?:\\.|[^"\\])*"?|'[^']*'?|[^#;]*)/, 'tok-string'],
  ],
};
const NUMBER = /^(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/;
const stickyRules = new WeakMap<RegExp, RegExp>();

/** 将行首规则转为可复用的 sticky 规则，避免逐字符复制剩余行文本。 */
function ruleAtPosition(rule: RegExp): RegExp {
  let sticky = stickyRules.get(rule);
  if (!sticky) {
    sticky = new RegExp(rule.source.replace(/^\^/, ''), `${rule.flags}y`);
    stickyRules.set(rule, sticky);
  }
  return sticky;
}

function regexLineSpans(line: string, language: string): Span[] {
  const rules = REGEX_RULES[language];
  const spans: Span[] = [];
  for (let pos = 0; pos < line.length;) {
    const boundary = pos === 0 || !/[\w$-]/.test(line[pos - 1]);
    let matched = false;
    for (const [rule, cls] of rules) {
      if (!boundary && (cls === 'tok-keyword' || cls === 'tok-number' || cls === 'tok-propertyName')) continue;
      const re = ruleAtPosition(rule);
      re.lastIndex = pos;
      const hit = re.exec(line);
      if (!hit?.[0]) continue;
      spans.push({ from: pos, to: pos + hit[0].length, cls });
      pos += hit[0].length;
      matched = true;
      break;
    }
    if (!matched && boundary) {
      const re = ruleAtPosition(NUMBER);
      re.lastIndex = pos;
      const hit = re.exec(line);
      if (hit?.[0]) {
        spans.push({ from: pos, to: pos + hit[0].length, cls: 'tok-number' });
        pos += hit[0].length;
        matched = true;
      }
    }
    if (!matched) pos++;
  }
  return spans;
}

// ---- 日志着色（批 D-4）：时间戳/级别正则轻量着色，非 Lezer ----
const LOG_TS = /^(\s*)(\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?\]?|\[\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)/;
const LOG_LEVEL: Array<[RegExp, string]> = [
  [/\b(FATAL|ERROR|SEVERE)\b/g, 'tok-keyword'],
  [/\b(WARN|WARNING)\b/g, 'tok-atom'],
  [/\b(INFO)\b/g, 'tok-meta'],
  [/\b(DEBUG|TRACE|VERBOSE)\b/g, 'tok-comment'],
];

/** 单行日志着色区间（纯函数供单测） */
export function logLineSpans(line: string): Span[] {
  const spans: Span[] = [];
  const m = line.match(LOG_TS);
  if (m && m[0].trim()) {
    const lead = m[1].length;
    spans.push({ from: lead, to: lead + (m[0].length - m[1].length), cls: 'tok-number' });
  }
  for (const [re, cls] of LOG_LEVEL) {
    re.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(line))) {
      spans.push({ from: hit.index, to: hit.index + hit[0].length, cls });
      if (hit.index === re.lastIndex) re.lastIndex++;
    }
  }
  return spans;
}

/** Lezer 语法树符号提取（M6-6：5 个 Lezer 语言替代正则） */
export interface TreeSymbol {
  line: number;
  name: string;
  kind: string;
}

const DEF_NODES: Record<string, Record<string, string>> = {
  JavaScript: { FunctionDeclaration: 'sym.func', ClassDeclaration: 'sym.class', VariableDeclaration: 'sym.var', MethodDefinition: 'sym.method' },
  TypeScript: { FunctionDeclaration: 'sym.func', ClassDeclaration: 'sym.class', VariableDeclaration: 'sym.var', MethodDefinition: 'sym.method', InterfaceDeclaration: 'sym.interface', TypeDeclaration: 'sym.type', EnumDeclaration: 'sym.enum' },
  Markdown: { ATXHeading1: 'H1', ATXHeading2: 'H2', ATXHeading3: 'H3', ATXHeading4: 'H4', ATXHeading5: 'H5', ATXHeading6: 'H6', SetextHeading1: 'H1', SetextHeading2: 'H2' },
  JSON: { PropertyName: 'sym.key' },
  YAML: { BlockMapping: 'sym.key' },
};

export function extractTreeSymbols(text: string, language: string, lineOffset = 0): TreeSymbol[] {
  if (!safeSyntaxText(language, text)) return [];
  const parser = getParser(language);
  const kinds = DEF_NODES[language];
  if (!parser || !kinds) return [];
  const tree = parser.parse(text);
  const out: TreeSymbol[] = [];
  // Lezer visits nodes in document order. Advance one cursor instead of rescanning
  // the whole prefix for every symbol (quadratic on files with many declarations).
  let scannedTo = 0;
  let line = 1;
  tree.iterate({
    enter: node => {
      const kind = kinds[node.node.name];
      if (!kind) return;
      const from = node.node.from;
      while (scannedTo < from) {
        if (text.charCodeAt(scannedTo) === 10) line++;
        scannedTo++;
      }
      const lineEnd = text.indexOf('\n', from);
      const raw = text.slice(from, Math.min(node.node.to, lineEnd < 0 ? text.length : lineEnd));
      if (language === 'Markdown') {
        out.push({ line: line + lineOffset, name: raw.replace(/^#+\s*/, '').trim().slice(0, 80), kind: t(kind) });
        return;
      }
      // 取节点内的标识符（函数/类名等）
      const m = raw.match(/(?:function|class|const|let|var|def|interface|enum|type)?\s*\*?\s*([A-Za-z_$][\w$]*)/);
      const name = language === 'JSON' ? raw.replace(/^"|"$/g, '') : m?.[1] ?? raw.slice(0, 40);
      if (name) out.push({ line: line + lineOffset, name, kind: t(kind) });
    },
  });
  return out;
}

/** 一行内的着色区间（字符偏移，行内相对） */
export interface Span {
  from: number;
  to: number;
  cls: string;
}

/** 行偏移二分：最后一个 start <= pos 的行号 */
export function lineIndexOf(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 解析一组连续行，返回每行的着色区间 */
export function highlightLines(lines: string[], language: string): Span[][] {
  if (!safeSyntaxLanguage(language, lines)) return lines.map(() => []);
  if (language === 'Log') return lines.map(l => logLineSpans(l));
  if (language in REGEX_RULES) return lines.map(l => regexLineSpans(l, language));
  const parser = getParser(language);
  if (!parser) {
    if (hasHighlightParser(language)) void loadHighlightParser(language).catch(() => undefined);
    return lines.map(() => []);
  }
  const text = lines.join('\n');
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  const spans: Span[][] = lines.map(() => []);
  const totalLen = text.length;
  highlightTree(parser.parse(text), classHighlighter, (from, to, cls) => {
    const li = lineIndexOf(starts, from);
    const le = lineIndexOf(starts, to - 1);
    for (let l = li; l <= le && l < spans.length; l++) {
      const lineEnd = (l + 1 < starts.length ? starts[l + 1] - 1 : totalLen) - starts[l];
      const s = Math.max(0, from - starts[l]);
      const e = Math.min(lineEnd, to - starts[l]);
      if (e > s) spans[l].push({ from: s, to: e, cls });
    }
  });
  return spans;
}
