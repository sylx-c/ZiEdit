// mode —— 视图模式裁决纯函数单测（UX-B：删双模式与三形态收敛，002 规则 7b v2.6 / 007 v0.15）
import { describe, expect, it } from 'vitest';
import {
  defaultModeFor,
  editableFile,
  lineBatchAllowed,
  mdSplitEligibleFile,
  sanitize,
  wysiwygEligibleFile,
  type ModeMeta,
} from './mode';

const md = (over: Partial<ModeMeta> = {}): ModeMeta => ({
  language: 'Markdown',
  isDraft: false,
  readonly: false,
  size: 1000,
  ...over,
});
const code = (over: Partial<ModeMeta> = {}): ModeMeta => ({
  language: 'TypeScript',
  isDraft: false,
  readonly: false,
  size: 1000,
  ...over,
});

describe('editableFile（v2.6：磁盘只读不再阻止编辑）', () => {
  it('草稿恒可编辑', () => {
    expect(editableFile(code({ isDraft: true, size: 99 * 1024 * 1024 }))).toBe(true);
  });
  it('只读文件同样可编辑（Ctrl+S E1003/另存为口径在保存侧兜底）；超 10MB 不可编辑', () => {
    expect(editableFile(code({ readonly: true }))).toBe(true);
    expect(editableFile(code({ size: 10 * 1024 * 1024 + 1 }))).toBe(false);
    expect(editableFile(code({ size: 10 * 1024 * 1024 }))).toBe(true);
  });
});

describe('defaultModeFor（v2.6：≤10MB 恒编辑面，defaultOpenMode 废止）', () => {
  it('出厂设置：文本默认 edit，Markdown 默认 wysiwyg（IR）', () => {
    expect(defaultModeFor(code(), {})).toBe('edit');
    expect(defaultModeFor(md(), {})).toBe('wysiwyg');
  });
  it('defaultOpenMode=view 历史值不再参与裁决（废止；≤10MB 照常 edit）', () => {
    expect(defaultModeFor(code(), { defaultOpenMode: 'view' } as never)).toBe('edit');
  });
  it('Markdown 按 mdDefaultMode：source→edit（源码即编辑面）；preview 恢复独立渲染预览', () => {
    expect(defaultModeFor(md(), { mdDefaultMode: 'source' })).toBe('edit');
    expect(defaultModeFor(md(), { mdDefaultMode: 'preview' })).toBe('md');
    expect(sanitize('md', md())).toBe('md');
    expect(sanitize('md', md({ size: 2 * 1024 * 1024 + 1 }))).toBeNull();
  });
  it('性能门禁：IR为4MiB，分屏保持2MiB，4–10MiB源码可编辑，超10MiB流式查看', () => {
    expect(defaultModeFor(md({ size: 4 * 1024 * 1024 }), {})).toBe('wysiwyg');
    expect(defaultModeFor(md({ size: 4 * 1024 * 1024 + 1 }), {})).toBe('edit');
    expect(sanitize('wysiwyg', md({ size: 9 * 1024 * 1024 }))).toBeNull();
    expect(sanitize('wysiwyg', md({ size: 10 * 1024 * 1024 }))).toBeNull();
    expect(defaultModeFor(md({ size: 3 * 1024 * 1024 }), { mdDefaultMode: 'source' })).toBe('edit');
    expect(defaultModeFor(md({ size: 10 * 1024 * 1024 + 1 }), {})).toBe('view');
  });
  it('只读文件同权进默认编辑面（code 与 md 皆然）', () => {
    expect(defaultModeFor(code({ readonly: true }), {})).toBe('edit');
    expect(defaultModeFor(md({ readonly: true }), {})).toBe('wysiwyg');
  });
  it('超 10MB 代码/文本走流式查看面', () => {
    expect(defaultModeFor(code({ size: 10 * 1024 * 1024 + 1 }), {})).toBe('view');
  });
});

describe('sanitize（v2.6：‘md’ 已删；split/wysiwyg 共用 2MB 闸）', () => {
  it('csv 仅 CSV/TSV；wysiwyg 须 eligible；split 须 mdSplitEligible', () => {
    expect(sanitize('csv', code())).toBeNull();
    expect(sanitize('wysiwyg', md({ size: 10 * 1024 * 1024 + 1 }))).toBeNull();
    expect(sanitize('wysiwyg', md())).toBe('wysiwyg');
    expect(sanitize('split', md())).toBe('split');
    expect(sanitize('split', md({ size: 3 * 1024 * 1024 }))).toBeNull();
    expect(sanitize('split', code())).toBeNull();
    expect(sanitize('csv', code({ language: 'CSV' }))).toBe('csv');
  });
  it('edit：≤10MB（含只读）合法；>10MB 非法；草稿合法', () => {
    expect(sanitize('edit', code({ readonly: true }))).toBe('edit');
    expect(sanitize('edit', code({ size: 10 * 1024 * 1024 + 1 }))).toBeNull();
    expect(sanitize('edit', code({ isDraft: true }))).toBe('edit');
  });
  it('undefined 与 view 恒可清洗', () => {
    expect(sanitize(undefined, md())).toBeNull();
    expect(sanitize('view', code())).toBe('view');
  });
  it('007 v0.15：只读 .md 同权进 IR/分屏（保存侧 E1003 兜底，IR 不再单独设只读闸）', () => {
    expect(sanitize('wysiwyg', md({ readonly: true }))).toBe('wysiwyg');
    expect(wysiwygEligibleFile(md({ readonly: true }))).toBe(true);
    expect(sanitize('split', md({ readonly: true }))).toBe('split');
    expect(mdSplitEligibleFile(md({ readonly: true }))).toBe(true);
  });
});

describe('Markdown 草稿格式', () => {
  it('Markdown 草稿可进入 Markdown 形态，并采用默认形态', () => {
    const draft = md({ isDraft: true });
    expect(wysiwygEligibleFile(draft)).toBe(true);
    expect(mdSplitEligibleFile(draft)).toBe(true);
    expect(defaultModeFor(draft, { mdDefaultMode: 'ir' })).toBe('wysiwyg');
  });
  it('未指定语言的草稿保持源码编辑', () => {
    const draft = code({ language: null, isDraft: true });
    expect(wysiwygEligibleFile(draft)).toBe(false);
    expect(mdSplitEligibleFile(draft)).toBe(false);
    expect(defaultModeFor(draft, {})).toBe('edit');
    expect(sanitize('wysiwyg', draft)).toBeNull();
  });
});

describe('lineBatchAllowed（005 规则 14 v1.4 / H-6d：注册表与两处右键菜单共用的唯一判决）', () => {
  it('Markdown 与结构化格式（JSON/XML/CSV/TSV）不启用', () => {
    for (const lang of ['Markdown', 'JSON', 'XML', 'CSV', 'TSV']) {
      expect(lineBatchAllowed(lang)).toBe(false);
    }
  });
  it('纯文本（null）、代码与日志启用', () => {
    expect(lineBatchAllowed(null)).toBe(true);
    expect(lineBatchAllowed('TypeScript')).toBe(true);
    expect(lineBatchAllowed('Log')).toBe(true);
  });
});
