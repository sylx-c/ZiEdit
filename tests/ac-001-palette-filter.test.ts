// @vitest-environment jsdom
// 001 命令面板过滤验收（H-6i 根修）：过滤口径必须与显示口径同源（L() 译文）。
// 修前缺陷：面板行显示 L(d.label) 译文（如「主题…」），过滤却按裸 key
// `d.label.toLowerCase().includes(q)` 匹配——中文用户输「主题」结果为空（key 是 'act.theme'），
// 只有碰巧含内部子串（theme/act/md…）才能命中（harness 实测：输入「主题」45 项 → 0 项）。
import { describe, expect, it, afterEach } from 'vitest';
import { ActionRegistry, openPalette } from '../src/shell/chrome';

function regWith(): ActionRegistry {
  const reg = new ActionRegistry();
  reg.add({ id: 'view.theme', label: 'act.theme', group: 'view', run: () => {} });
  reg.add({ id: 'tools.settings', label: 'act.settings', group: 'tools', run: () => {} });
  reg.add({ id: 'md.boldProxy', label: 'md.bold', group: 'edit', run: () => {} });
  return reg;
}

function filterFor(q: string): string[] {
  const input = document.querySelector('.cmd-input') as HTMLInputElement;
  input.value = q;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return [...document.querySelectorAll('.cmd-item')].map(e => e.textContent.trim());
}

describe('001 命令面板过滤（译文口径）', () => {
  afterEach(() => {
    document.querySelector('.cmd-overlay')?.remove();
  });

  it('空查询列出全部命令', () => {
    openPalette(regWith());
    expect(filterFor('').length).toBe(3);
  });

  it('中文按译文命中（H-6i 修复项）：「主题」→ 主题…', () => {
    openPalette(regWith());
    const hits = filterFor('主题');
    expect(hits).toEqual(['主题…']);
  });

  it('译文命中覆盖此前只有 key 能命中的场景：「加粗」→ 加粗', () => {
    openPalette(regWith());
    expect(filterFor('加粗')).toEqual(['加粗']);
  });

  it('裸 key 子串仍可命中（熟练用户路径）：theme → 主题…', () => {
    openPalette(regWith());
    expect(filterFor('theme')).toEqual(['主题…']);
  });

  it('无匹配为空列表', () => {
    openPalette(regWith());
    expect(filterFor('不存在的命令xyz')).toEqual([]);
  });
});
