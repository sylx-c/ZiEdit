// @vitest-environment jsdom
// 007-AC Markdown 深治回归锁（P2，规则 1/2/6/16/20 v2.0 + 001 规则 28 v2.1）：
//   形态正名（源码视图/分屏预览/即时渲染；v0.15 起三形态——渲染预览已删；修前 split 三种叫法）；
//   解析选项单一来源（IR 与静态预览同引，出厂全开——修「即时渲染和渲染预览效果不一样」）；
//   代码块语言补全表（hljs.langs 显式给表——修「``` 后无法选择语言」）；
//   弹层定位单一实现（顶部锚点向下弹——修「标题 ▾ 只显示 H3/H4」）；
//   分屏防跳顶（块级锚点捕获/恢复，不依赖标题——修「一编辑右侧滚回最上面」）；
//   新建文件格式下拉（dlgPromptWithFormat 返回 {name, format}——修「选 markdown 不进 markdown」）。
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CODE_HINT_LANGS } from '../src/markdown-view/preview';
import { createBlockRenderer } from '../src/markdown-view/blockcache';
import { loadMarkdownIt } from '../src/markdown-view/md';
import { placePopup, placeSubmenu } from '../src/common/popup';
import { dlgPromptWithFormat } from '../src/shell/chrome';
import { dict } from '../src/common/i18n';

function mockOffset(el: HTMLElement, top: number, height: number): void {
  Object.defineProperty(el, 'offsetTop', { get: () => top, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { get: () => height, configurable: true });
  Object.defineProperty(el, 'offsetWidth', { get: () => 180, configurable: true });
}

describe('007 AC：形态正名（规则 1 v2.0；v0.15 三形态）', () => {
  it('H5/H6 三面字号递减，保留明确字重和 H6 弱化色', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
    for (const [level, ratio] of [[5, 0.875], [6, 0.85]]) {
      expect(css).toContain(`.md-preview .md-col h${level}{font-size:calc(var(--md-fs-base) * ${ratio})`);
      expect(css).toContain(`.md-ir .cm-line.mdir-h${level}{font-size:calc(var(--md-fs-base) * ${ratio})`);
    }
    expect(css).toContain('.md-ir .cm-line.mdir-h6{color:var(--muted)}');
  });
  it('格式钮按 Markdown/只读状态判决，不依赖异步挂载视图实例', () => {
    const app = readFileSync(resolve(__dirname, '../src/shell/app.ts'), 'utf8');
    const predicate = app.slice(app.indexOf('const canFormatMarkdown ='), app.indexOf('const formatMarkdown ='));
    expect(predicate).toContain('isMdActive() && !settings.readOnlyMode');
    // 走查 P 补视图 isReadOnly 判定（同步 instanceof 检查不依赖异步挂载）
    expect(app).toContain('tint, enabled: canFormatMarkdown');
    expect(app).toContain('enabled: canFormatMarkdown,');
  });
  it('zh/en 两字典 split 全部叫「分屏预览 / Split Preview」（修前 源码+预览分屏/Split View/分屏 三种叫法）', () => {
    for (const lang of ['zh-CN', 'en-US'] as const) {
      const d = dict(lang);
      const want = lang === 'zh-CN' ? '分屏预览' : 'Split Preview';
      expect(d['act.mdSplit']).toBe(want);
      expect(d['st.quick.splitTip']).toBe(want);
      expect(d['tb.mdSplit']).toBe(want);
    }
  });
});

describe('007 AC：渲染单源与语言表（规则 16/2 v2.0；v0.42 Lezer 单源）', () => {
  // v0.42 删锁登记：previewParseOpts 出厂全开锁作废——该函数服务于旧预览 API 解析选项，
  // Lezer 语法配置为编译期常量（static-html.ts staticMarkdownParser，IR 扩展同源），不再存在
  // 「运行时解析选项漂移」的面；原「两形态同口径」由三面共用同一解析器保证。

  it('CODE_HINT_LANGS 覆盖常用语言且无重复（``` 围栏语言行补全数据源）', () => {
    expect(CODE_HINT_LANGS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(CODE_HINT_LANGS).size).toBe(CODE_HINT_LANGS.length);
    for (const must of ['javascript', 'typescript', 'python', 'rust', 'go', 'json', 'yaml', 'sql', 'bash', 'markdown']) {
      expect(CODE_HINT_LANGS).toContain(must);
    }
  });

  it('引擎契约（规则 2 v0.16/16 v0.42）：IR 为自研 CM6 live preview；静态面（预览/分屏）单引 renderStaticHtml，无旧渲染器依赖', () => {
    const lp = readFileSync(resolve(__dirname, '../src/markdown-view/livepreview.ts'), 'utf8');
    const pv = readFileSync(resolve(__dirname, '../src/markdown-view/preview.ts'), 'utf8');
    expect(existsSync(resolve(__dirname, '../src/markdown-view/wysiwyg.ts'))).toBe(false); // 旧 IR 路径已删
    expect(lp).not.toMatch(/(?:from\s*|import\s*\(\s*)['"](?!\.|@codemirror\/|@lezer\/)[^'"]+['"]/);
    expect(pv).not.toMatch(/import\s*\(\s*['"](?!\.)[^'"]+['"]/); // 动态渲染依赖只能来自本地模块
    expect(lp).toContain("from './editor-language'");
    expect(readFileSync(resolve(__dirname, '../src/markdown-view/editor-language.ts'), 'utf8')).toMatch(/from '@codemirror\/lang-markdown'/);
    expect(lp).toContain('runMdFormat'); // 规则 17：三上下文同一实现
    expect(pv).toContain('renderStaticHtml'); // 静态渲染（预览整篇）单源不回漂
  });
});

describe('001/007 AC：弹层定位单一实现（placePopup）', () => {
  it('右下角子菜单向左并上移，所有命令留在视口内', () => {
    const anchor = document.createElement('div');
    anchor.getBoundingClientRect = () => ({ left: window.innerWidth - 140, right: window.innerWidth - 20,
      top: window.innerHeight - 50, bottom: window.innerHeight - 22 } as DOMRect);
    const sub = document.createElement('div');
    mockOffset(sub, 0, 318);
    placeSubmenu(anchor, sub);
    const left = parseInt(sub.style.left, 10), top = parseInt(sub.style.top, 10);
    expect(left).toBeLessThan(anchor.getBoundingClientRect().left);
    expect(left + sub.offsetWidth).toBeLessThanOrEqual(window.innerWidth - 4);
    expect(top + sub.offsetHeight).toBeLessThanOrEqual(window.innerHeight - 4);
    expect(top).toBeGreaterThanOrEqual(4);
    expect(sub.style.overflowY).toBe('auto');
  });
  it('顶部锚点（下方空间大）向下弹；底部锚点（上方空间大）向上弹——修「标题 ▾ 被顶出视口只显 H3/H4」', () => {
    // 顶部工具栏锚点：rect.top=90/bottom=120，菜单高 140 → 向下弹 top=122
    const anchor = document.createElement('button');
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      value: () => ({ top: 90, bottom: 120, left: 200, right: 260, width: 60, height: 30, x: 200, y: 90, toJSON: () => ({}) }),
      configurable: true,
    });
    const m = document.createElement('div');
    mockOffset(m, 0, 140);
    m.style.position = 'fixed';
    document.body.append(anchor, m);
    placePopup(anchor, m);
    expect(m.style.top).toBe('122px'); // 120 + gap 2
    expect(m.style.bottom).toBe('');

    // 底部状态栏锚点：rect.top=900（视口 960）→ 上方空间 900 远大于下方 36 → 向上弹
    const anchor2 = document.createElement('div');
    Object.defineProperty(anchor2, 'getBoundingClientRect', {
      value: () => ({ top: 900, bottom: 930, left: 200, right: 260, width: 60, height: 30, x: 200, y: 900, toJSON: () => ({}) }),
      configurable: true,
    });
    placePopup(anchor2, m);
    expect(m.style.top).toBe(`${900 - 140 - 2}px`);
  });

  it('水平双侧钳制（右缘越界钳回）', () => {
    const anchor = document.createElement('button');
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      value: () => ({ top: 90, bottom: 120, left: 1900, right: 1960, width: 60, height: 30, x: 1900, y: 90, toJSON: () => ({}) }),
      configurable: true,
    });
    const m = document.createElement('div');
    mockOffset(m, 0, 140);
    document.body.append(anchor, m);
    Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 960, configurable: true, writable: true });
    placePopup(anchor, m);
    expect(parseInt(m.style.left, 10)).toBeLessThanOrEqual(1920 - 180 - 4 + 1);
  });
});

describe('007 AC：阅读块锚防跳顶', () => {
  it('无标题正文同样能捕获块身份和块内像素偏移', async () => {
    await loadMarkdownIt();
    const renderer = createBlockRenderer(), host = document.createElement('div');
    await renderer.render(host, '引言\n\n当前段\n\n结尾', { dark:false });
    const nodes = [...host.querySelectorAll<HTMLElement>('.md-block')];
    nodes.forEach((node,i) => mockOffset(node,i*100,100));
    renderer.surface!.measure();
    host.scrollTop = 125;
    const anchor = renderer.surface!.capture();
    expect(anchor.blockId).toBe(nodes[1].dataset.blockId);
    expect(anchor.offset).toBe(25);
    mockOffset(nodes[1],180,100);
    mockOffset(nodes[0],0,180); renderer.surface!.measure();
    renderer.surface!.restore(anchor);
    expect(host.scrollTop).toBe(205);
    renderer.destroy();
  });
  it('相同文本的不同段落不互相冒充阅读锚', async () => {
    await loadMarkdownIt();
    const renderer = createBlockRenderer(), host = document.createElement('div');
    await renderer.render(host, 'same\n\nsame\n\nsame', { dark:false });
    const nodes = [...host.querySelectorAll<HTMLElement>('.md-block')];
    nodes.forEach((node,i) => mockOffset(node,i*100,100));
    renderer.surface!.measure();
    host.scrollTop = 225;
    const anchor = renderer.surface!.capture();
    expect(anchor.blockId).toBe(nodes[2].dataset.blockId);
    renderer.surface!.restore(anchor);
    expect(host.scrollTop).toBe(225);
    renderer.destroy();
  });
});

describe('001 AC：新建文件格式下拉（规则 28 v2.1）', () => {
  it('dlgPromptWithFormat：确定返回 {name, format}，取消返回 null', async () => {
    const p = dlgPromptWithFormat('新建文件', [
      { id: 'txt', label: '纯文本' },
      { id: 'md', label: 'Markdown' },
    ], 'md');
    await new Promise(r => setTimeout(r, 20));
    const input = document.querySelector('.ov-mask .dlg-input:not(select)') as HTMLInputElement;
    const sel = document.querySelector('.ov-mask select') as HTMLSelectElement;
    input.value = '笔记';
    sel.value = 'md';
    const ok = document.querySelector('.ov-mask .dlg-btn.primary') as HTMLButtonElement;
    ok.click();
    const r = await p;
    expect(r).toEqual({ name: '笔记', format: 'md' });
  });
});
