// 001-AC 目录跟随判决回归锁（P1-5，规则 25 v2.0/v2.5）：
// 修前 localRoot 只在「打开」时设置——切标签不跟随、关最后一个标签树不清空。
// 判决收口 common/paths.ts deriveTreeRoot（切标签/关标签/会话恢复同口径）：
// 无标签 → null（树空）；草稿/伪标签 → 按 hasRealTabs 分岔（v2.5）；真实文件 → 其目录。
import { describe, expect, it } from 'vitest';
import { deriveTreeRoot } from '../src/common/paths';

describe('001 AC：活动标签决定树根（规则 25 v2.0）', () => {
  it('无标签 → null（关掉最后一个标签树清空，修前残留旧目录）', () => {
    expect(deriveTreeRoot(null, 'E:\\work\\editor')).toBeNull();
    expect(deriveTreeRoot(null, null)).toBeNull();
  });

  it('真实文件标签：异根换根、同根 keep（切不同目录的标签树随之变换）', () => {
    expect(deriveTreeRoot('E:\\A\\a.txt', 'E:\\B')).toBe('E:\\A');
    expect(deriveTreeRoot('E:\\A\\sub\\a.txt', 'E:\\A')).toBe('E:\\A\\sub');
    expect(deriveTreeRoot('E:\\A\\b.md', 'E:\\A')).toBe('keep');
    expect(deriveTreeRoot('C:\\root.md', null)).toBe('C:\\'); // 盘符根兜底带分隔符
  });

  it('草稿/对比/尾随台伪标签 → keep（无对应目录，保持现根）', () => {
    expect(deriveTreeRoot('draft://scratch-1', 'E:\\A')).toBe('keep');
    expect(deriveTreeRoot('compare://a|b', 'E:\\A')).toBe('keep');
    expect(deriveTreeRoot('tail://', 'E:\\A')).toBe('keep');
  });
});

describe('001 AC：仅剩伪路径标签树清空（规则 25 v2.5）', () => {
  it('伪标签 + 仍有真实文件标签存续 → keep（切到草稿不动树）', () => {
    expect(deriveTreeRoot('draft://1', 'E:\\A', true)).toBe('keep');
    expect(deriveTreeRoot('compare://a|b', 'E:\\A', true)).toBe('keep');
    expect(deriveTreeRoot('tail://', 'E:\\A', true)).toBe('keep');
  });

  it('伪标签 + 无任何真实文件标签 → null（树清空回空态，修前关掉全部真实文件只剩草稿时树残留旧目录）', () => {
    expect(deriveTreeRoot('draft://1', 'E:\\A', false)).toBeNull();
    expect(deriveTreeRoot('draft://2', null, false)).toBeNull();
    expect(deriveTreeRoot('compare://a|b', 'E:\\A', false)).toBeNull();
    expect(deriveTreeRoot('tail://', 'E:\\A', false)).toBeNull();
  });

  it('真实文件标签不受 hasRealTabs 影响；无标签恒清树', () => {
    expect(deriveTreeRoot('E:\\A\\b.md', 'E:\\A', false)).toBe('keep');
    expect(deriveTreeRoot('E:\\B\\c.txt', 'E:\\A', false)).toBe('E:\\B');
    expect(deriveTreeRoot(null, 'E:\\A', false)).toBeNull();
  });
});
