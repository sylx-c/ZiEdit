import { Language, LanguageSupport } from '@codemirror/language';
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { MarkdownParser } from '@lezer/markdown';
import { markdownSyntaxExtensions } from './extensions';

// markdown() 的 parseCode 包装会在一次 advance 中遍历整树，无法被解析预算打断。
// 正文只做增量 Markdown 解析；代码着色使用已有的离线 Worker。
const language = new Language(commonmarkLanguage.data,
  (commonmarkLanguage.parser as MarkdownParser).configure(markdownSyntaxExtensions), [], 'markdown');
const support = markdown().support;

/** 保留 Markdown 键位、粘贴链接、折叠和 HTML 标签补全，共享同一语言数据 facet。 */
export function editorMarkdown(): LanguageSupport { return new LanguageSupport(language, support); }
