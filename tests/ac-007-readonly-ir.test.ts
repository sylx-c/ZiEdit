// MD-001 语义反转回归锁（007 v0.15，UX-B 批）：只读 .md 同权进即时渲染。
// v2.6 起「查看/编辑」双模式删除——所有形态都在编辑缓冲内承载，只读不再是 IR 的独立闸
// （写盘失败统一走 E1003、另存为可用，007 规则 6 v0.15：只读 .md 不再禁入任何形态）。
// 纯函数侧锁在 src/common/mode.test.ts（sanitize 只读 md 选 wysiwyg → 'wysiwyg'）。
// 源码契约锁：UI 闸 wysiwygEligible 不得回漂引入只读判断。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = readFileSync(fileURLToPath(new URL('../src/shell/app.ts', import.meta.url)), 'utf8');

describe('MD-001 v0.15：只读 Markdown 同权进即时渲染（源码契约锁）', () => {
  it('UI 闸 wysiwygEligible 不再含只读判断（形态闸只剩 Markdown/≤2MB；草稿按语言放行，大小按 0）', () => {
    const m = /const wysiwygEligible = \(tab: TabState\): boolean =>[\s\S]{0,340}?;/.exec(app);
    expect(m).toBeTruthy();
    expect(m![0]).toMatch(/tab\.language === 'Markdown'/);
    expect(m![0]).not.toMatch(/!tab\.path\.startsWith\('draft:\/\/'\)/); // 草稿格式切换后按 language 放行，不得回漂排除草稿
    expect(m![0]).toMatch(/<= WYSIWYG_LIMIT/);
    expect(m![0]).not.toMatch(/fileReadonly/); // 只读闸不得回漂（保存侧 E1003 统一兜底）
  });
});
