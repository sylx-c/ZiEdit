// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EditorState } from '@codemirror/state';
import { ActionRegistry, buildToolbar, openPalette, ICONS } from '../src/shell/chrome';
import { applyFormat, MD_INLINE_COMMANDS, MD_BLOCK_COMMANDS } from '../src/markdown-view/mdformat';

const source = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const app = source('src/shell/app.ts');
const ir = source('src/markdown-view/livepreview.ts');
const chrome = source('src/shell/chrome.ts');

describe('产品打磨 P2 Markdown 入口', () => {
  it('两类菜单分桶不重叠且链接属行内、正文与表格属块级', () => {
    expect(MD_INLINE_COMMANDS.map(x => x[0])).toEqual(['bold', 'italic', 'strike', 'inlineCode', 'link']);
    expect(MD_BLOCK_COMMANDS).toHaveLength(12);
    expect(MD_BLOCK_COMMANDS.map(x => x[0])).toContain('paragraph');
    for (const text of [app, ir]) {
      expect(text).toContain('MD_INLINE_COMMANDS.map');
      expect(text).toContain('MD_BLOCK_COMMANDS.map');
      expect(text).toContain('editMarkdownLink(');
    }
  });

  it('正文去除标题、插表沿用唯一模板', () => {
    const state = EditorState.create({ doc: '## 标题' });
    const result = applyFormat(state.doc, [{ from: 0, to: 5 }], 'paragraph');
    expect(state.update({ changes: result.changes }).state.doc.toString()).toBe('标题');
    const table = applyFormat(EditorState.create().doc, [{ from: 0, to: 0 }], 'table');
    expect(EditorState.create().update({ changes: table.changes }).state.doc.toString()).toContain('| --- | --- | --- |');
    expect(app).toContain('runMdFormat(v.view, cmd)');
    expect(ir).toContain('runMdFormat(this.view, cmd)');
    expect(app).not.toContain('| --- | --- | --- |');
    expect(ir).not.toContain('| --- | --- | --- |');
  });

  it('popup 按钮有独立类名、指示符与 aria，禁用态阻止入口且保留 title 提示', () => {
    const popup = vi.fn();
    const reg = new ActionRegistry();
    reg.add({ id: 'heading', label: 'md.headingBtn', group: 'edit', icon: 'heading', popup, enabled: () => false, run: () => {} });
    const root = document.createElement('div');
    buildToolbar(root, () => ({ left: [], context: [{ action: 'heading' }], right: [] }), reg).refresh();
    const button = root.querySelector('button')!;
    expect(button.classList.contains('has-popup')).toBe(true);
    expect(button.querySelector('.popup-indicator')?.textContent).toBe('▾');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    // 禁用态不用 disabled 属性（2026-10 反馈）：Chromium/WebView2 对 disabled 元素不显示 title
    // 悬停提示；改样式类 + aria-disabled，入口由 enabled 守卫阻止
    expect(button.disabled).toBe(false);
    expect(button.classList.contains('disabled')).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.click();
    expect(popup).not.toHaveBeenCalled();
    expect(chrome).toContain('.filter(d => !d.popup && d.enabled?.() !== false)');
  });

  it('八枚格式图标齐备', () => {
    for (const key of ['bold', 'italic', 'strike', 'inlineCode', 'codeBlock', 'link', 'table', 'heading'] as const)
      expect(ICONS[key]).toContain('<path');
  });

  it('命令面板不展示无法执行的 popup 动作', () => {
    const reg = new ActionRegistry();
    reg.add({ id: 'popup', label: 'Popup sentinel', group: 'edit', popup: () => {}, run: () => {} });
    reg.add({ id: 'normal', label: 'Executable sentinel', group: 'edit', run: () => {} });
    openPalette(reg);
    const labels = [...document.querySelectorAll('.cmd-item')].map(el => el.textContent);
    expect(labels).toContain('Executable sentinel');
    expect(labels).not.toContain('Popup sentinel');
    document.querySelector('.cmd-overlay')?.remove();
  });

  it('源码与预览格式段齐备，预览或只读不可格式化', () => {
    expect(app).toContain("mode === 'md' || mode === 'edit' || mode === 'split' || mode === 'wysiwyg'");
    expect(app).toContain("modeOf(activeTab()!) !== 'md'");
    expect(app).toContain('enabled: canFormatMarkdown');
    expect(app).toContain('v.isReadOnly');
  });

  it('树改键、重做别名、跳转恒在工具栏左段，列操作按矩形置灰', () => {
    expect(app).toContain("id: 'view.toggleTree', label: 'act.toggleTree', shortcut: 'Ctrl+Shift+B'");
    expect(app).toContain("shortcut: 'Ctrl+Shift+Z'");
    expect(app).toContain("{ action: 'find.find' }, { action: 'find.replace' }, { action: 'find.goto' }");
    for (const key of ['deleteCol', 'cutCol', 'sumCol', 'alignLeft', 'alignCenter', 'alignRight'])
      expect(app).toContain(`[$t('ed.${key}'), v.hasColumnRect() ?`);
    expect(app).toContain("$t('ed.columnFillToEnd')");
    expect(app).toContain('undoDepth(view.state)');
    expect(app).toContain('redoDepth(view.state)');
  });

  it('图片 checked 接线互斥（displayMode getter 由主会话补齐）', () => {
    expect(app).toContain("displayMode === 'fit'");
    expect(app).toContain("displayMode === '100'");
  });
});
