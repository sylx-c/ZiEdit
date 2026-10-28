// 005-AC 列粘贴来源标记回归锁（P1-3，规则 5 v2.2）：
// 修前缺陷——Alt+拖拽一次性矩形复制后矩形被单击清掉，粘贴门禁只认「矩形仍活动或列模式开」，
// 于是落普通粘贴（竖着复制横着贴）；右键菜单 cmPaste 更是永不列展开（与键位两套口径）。
// 判决：来源标记 markRectCopy/wasRectCopy（rect.ts）——剪贴板无元数据，用「标记+文本比对」：
// 中途任何其它复制（含原生 Ctrl+C，不经应用代码）都会改剪贴板内容，比对即失效。
import { describe, expect, it, beforeEach } from 'vitest';
import { markRectCopy, wasRectCopy } from '../src/text-view/rect';

describe('005 AC：列复制来源标记（规则 5 v2.2）', () => {
  beforeEach(() => {
    markRectCopy(false); // 模块级状态，逐例重置
  });

  it('矩形复制置位、普通复制清除', () => {
    expect(wasRectCopy()).toBe(false);
    markRectCopy(true, 'aa\nbb');
    expect(wasRectCopy()).toBe(true);
    expect(wasRectCopy('aa\nbb')).toBe(true); // 剪贴板内容与复制文本一致 → 命中
    markRectCopy(false);
    expect(wasRectCopy()).toBe(false);
  });

  it('文本比对：中途其它复制改了剪贴板 → 标记失效（防普通多行文本误列展开）', () => {
    markRectCopy(true, 'aa\nbb');
    expect(wasRectCopy('其它内容')).toBe(false); // 原生 Ctrl+C 场景
    expect(wasRectCopy('aa\nbb')).toBe(true);
  });

  it('未记文本的置位（空串）只做弱标记——剪贴板恰为空串时仍命中', () => {
    markRectCopy(true, '');
    expect(wasRectCopy()).toBe(true);
    expect(wasRectCopy('')).toBe(true);
    expect(wasRectCopy('x')).toBe(false);
  });

  // v2.3 行尾归一比对：平台剪贴板可能把 LF 复制文本自行转成 CRLF 再转回——直接字符串
  // 比对会让来源标记无端失效（矩形复制出来的块粘贴判不出列来源），比对前两头归一为 LF。
  it('v2.3：CRLF/CR 剪贴板与 LF 复制文本同内容命中；内容不同（多行/异文）仍失效', () => {
    markRectCopy(true, 'aa\nbb');
    expect(wasRectCopy('aa\r\nbb')).toBe(true); // Windows 剪贴板往返
    expect(wasRectCopy('aa\rbb')).toBe(true); // 孤立 CR 同口径归一
    expect(wasRectCopy('aa\nbb\n')).toBe(false); // 多出一行 = 内容变了 → 失效
    expect(wasRectCopy('aa\nbc')).toBe(false); // 异文 → 失效
    markRectCopy(true, 'x\r\ny'); // 复制端带 \r（防御口径）：同样归一比对
    expect(wasRectCopy('x\ny')).toBe(true);
  });
});
