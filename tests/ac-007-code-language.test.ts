// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { codeHighlight } from '../src/markdown-view/code-highlight';
import { codeLanguage, type CodeToken } from '../src/markdown-view/code-tokens';
import { compositionChanged, compositionGuard } from '../src/common/composition';
import { CODE_HINT_LANGS, waitForPreviewCode } from '../src/markdown-view/preview';
import { renderStaticHtml, staticMarkdownParser } from '../src/markdown-view/static-html';
import { extractMarkdownMetadata } from '../src/markdown-view/headings';

const workerSource = ts.transpileModule(readFileSync('src/markdown-view/code-worker.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const core = readFileSync('public/renderers/highlight/highlight.min.js', 'utf8');
const extras = readFileSync('public/renderers/highlight/third-languages.js', 'utf8');
const views: EditorView[] = [];
const workers: LocalWorker[] = [];
let delayed = false;

// 仅替代 jsdom 不具备的 Worker 传输，执行产品 Worker 与随包的真实语法库。
class LocalWorker {
  onmessage?: (event: { data: { id: number; tokens?: CodeToken[]; error?: string } }) => void;
  onerror?: () => void;
  stopped = false;
  requests: { id: number; language: string; source: string }[] = [];
  scope = vm.createContext({ console });
  constructor() {
    const scope = this.scope;
    scope.self = scope;
    scope.importScripts = (...urls: string[]) => {
      expect(urls).toEqual(['/renderers/highlight/highlight.min.js', '/renderers/highlight/third-languages.js']);
      vm.runInContext(core, scope); vm.runInContext(extras, scope);
    };
    scope.postMessage = (data: never) => this.onmessage?.({ data });
    vm.runInContext(workerSource, scope); workers.push(this);
  }
  postMessage(request: { id: number; language: string; source: string }) {
    this.requests.push(request);
    if (!delayed) setTimeout(() => { if (!this.stopped) this.reply(request); }, 0);
  }
  reply(request = this.requests[this.requests.length - 1]!) { this.scope.onmessage({ data: request }); }
  terminate() { this.stopped = true; }
}
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren(); workers.length = 0; delayed = false; vi.unstubAllGlobals();
});
function mount(source: string) {
  vi.stubGlobal('Worker', LocalWorker);
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: source,
    extensions: [markdown({ base: markdownLanguage }), history(), compositionGuard(), codeHighlight([])] }) });
  views.push(view); return view;
}
async function colored(view: EditorView, text: string) {
  await vi.waitFor(() => expect([...view.dom.querySelectorAll('.hljs-keyword')].some(el => el.textContent === text)).toBe(true));
}
const bash = 'if [ -n "$HOME" ]; then\n  echo "中文<&😀" # comment\nfi';

describe('007 代码语言选择与离线高亮', () => {
  it('冷启动分屏等待每个代码块着色后再复制，空容器不等待', async () => {
    const root = document.createElement('div');
    await waitForPreviewCode(root);
    root.innerHTML = '<pre><code class="language-bash">echo hi</code></pre><pre><code>plain</code></pre>';
    let finished = false;
    const pending = waitForPreviewCode(root).then(() => { finished = true; });
    const codes = root.querySelectorAll('code');
    codes[0]!.classList.add('hljs');
    await Promise.resolve(); expect(finished).toBe(false);
    codes[1]!.classList.add('hljs'); await pending;
    expect(finished).toBe(true);
  });
  it('候选的45种语言均有随包语法；Shell别名统一，不借自动猜测语言', () => {
    const worker = new LocalWorker(); worker.scope.importScripts('/renderers/highlight/highlight.min.js', '/renderers/highlight/third-languages.js');
    for (const language of CODE_HINT_LANGS) expect(worker.scope.hljs.getLanguage(codeLanguage(language)), language).toBeTruthy();
    for (const language of ['sh', 'shell', 'zsh', 'BASH']) expect(codeLanguage(language)).toBe('bash');
    // v0.42 改锁登记：offlinePreviewHtml（旧渲染器二次渲染前 shell→bash 类名改写）作废；
    // 语义迁至序列化器——静态面语言 class 用归一化名，与 code-worker 同口径。
    const source = '```shell\necho hi\n```';
    const html = renderStaticHtml(source, staticMarkdownParser.parse(source), extractMarkdownMetadata(source));
    expect(html).toContain('language-bash');
  });
  it.each(['bash', 'sh', 'shell'])('%s保留源码及UTF-16范围，关键字/变量/字符串/注释真正着色', async language => {
    const source = '```' + language + '\n' + bash + '\n```';
    const view = mount(source); await colored(view, 'if');
    expect(view.dom.querySelector('.hljs-variable')?.textContent).toBe('$HOME');
    expect([...view.dom.querySelectorAll('.hljs-string')].some(el => el.textContent === '"中文<&😀"')).toBe(true);
    expect(view.dom.querySelector('.hljs-comment')?.textContent).toBe('# comment');
    expect(view.state.doc.toString()).toBe(source);
  });
  it.each(['> ', '  '])('容器前缀%s不计入高亮范围；空行与变量保持正确位置', async prefix => {
    const source = (prefix === '> ' ? '> ```bash' : '- ```bash') + '\n' + prefix + 'if true; then\n' + prefix + '\n' + prefix + 'echo "$HOME"\n' + prefix + 'fi\n' + prefix + '```';
    const view = mount(source); await colored(view, 'if');
    expect(view.dom.querySelector('.hljs-variable')?.textContent).toBe('$HOME');
    expect(view.dom.querySelector('.hljs-built_in')?.textContent).toBe('echo');
    expect(view.state.doc.toString()).toBe(source);
  });
  it('在途结果晚于源码替换只作用于相同内容，不使用旧坐标；撤销可重新着色', async () => {
    delayed = true;
    const initial = '```bash\n' + bash + '\n```';
    const view = mount(initial), worker = workers[0]!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '```plaintext\nplain\n```' }, userEvent: 'input' });
    worker.reply();
    await new Promise(r => setTimeout(r, 20));
    expect(view.dom.querySelector('.hljs-keyword')).toBeNull();
    undo(view); await colored(view, 'if');
    expect(view.state.doc.toString()).toBe(initial);
  });
  it('组合期间只映射原装饰，提交后更新；销毁终止Worker，迟到结果不回填', async () => {
    const view = mount('```bash\n' + bash + '\n```'); await colored(view, 'if');
    view.dispatch({ effects: compositionChanged.of(true) });
    const before = workers[0]!.requests.length;
    view.dispatch({ changes: { from: 8, insert: '新' }, userEvent: 'input.type.compose' });
    expect(workers[0]!.requests.length).toBe(before);
    view.dispatch({ effects: compositionChanged.of(false) });
    await vi.waitFor(() => expect(workers[0]!.requests.length).toBe(before + 1));
    const worker = workers[0]!; views.pop(); view.destroy();
    expect(worker.stopped).toBe(true); expect(() => worker.reply()).not.toThrow();
  });
  it('未知语言保持可编辑原文，恶意HTML只作为字符串高亮，不生成元素', async () => {
    const view = mount('```bash\necho "<img src=x onerror=alert(1)>"\n```');
    await vi.waitFor(() => expect(view.dom.querySelector('.hljs-string')?.textContent).toContain('<img'));
    expect(view.dom.querySelector('img')).toBeNull();
    view.dispatch({ changes: { from: 3, to: 7, insert: 'unknown-lang' } });
    await vi.waitFor(() => expect(view.dom.querySelector('.hljs-string')).toBeNull());
    expect(view.state.doc.toString()).toContain('<img src=x onerror=alert(1)>');
  });
});
