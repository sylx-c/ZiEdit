import { describe, expect, it } from 'vitest';
import { docOfLines, rectCaseChanges, rectDeleteChanges, rectFillChanges, rectFromCells, rectOf, rectText } from './rect';

const DOC = docOfLines(['12', '34', '5678']);

describe('rectOf（005 规则 2：矩形重建）', () => {
  it('三行选区推回矩形 [colStart, colEnd)', () => {
    // 第 1-3 行各选 1 个字符（"1/3/5"）：行 1 列 0 起
    const r = rectOf(
      [
        { from: 0, to: 1 },
        { from: 3, to: 4 },
        { from: 6, to: 7 },
      ],
      DOC
    );
    expect(r).toEqual({ fromLine: 1, toLine: 3, colStart: 0, colEnd: 1 });
  });
  it('短行空选区（钳到行尾）不参与列推算', () => {
    // 行 3 选 [7,9)（"78"），行 1/2 只到行尾后的空选区在 col 2 → 视为短行退化
    const r = rectOf(
      [
        { from: 2, to: 2 },
        { from: 5, to: 5 },
        { from: 7, to: 9 },
      ],
      DOC
    );
    expect(r).toEqual({ fromLine: 1, toLine: 3, colStart: 1, colEnd: 3 });
  });
  it('行不连续 → null', () => {
    const r = rectOf(
      [
        { from: 0, to: 1 },
        { from: 6, to: 7 },
      ],
      DOC
    );
    expect(r).toBeNull();
  });
  it('真跨行且行不连续 → null', () => {
    const r = rectOf(
      [
        { from: 0, to: 4 },
        { from: 6, to: 7 },
      ],
      DOC
    );
    expect(r).toBeNull();
  });
  it('CM 短行越界 range 钳回本行后仍是矩形', () => {
    // 12 / 34 / 56；每行 to 伸进下一行 1 个位置
    const lines = ['12', '34', '56'];
    const doc = docOfLines(lines);
    const r = rectOf(
      [
        { from: 0, to: 3 },
        { from: 3, to: 6 },
        { from: 6, to: 8 },
      ],
      doc
    );
    expect(r).toEqual({ fromLine: 1, toLine: 3, colStart: 0, colEnd: 2 });
    expect(rectText(r!, n => lines[n - 1]!)).toEqual(['12', '34', '56']);
  });
  it('单个 range → null（非矩形）', () => {
    expect(rectOf([{ from: 0, to: 2 }], DOC)).toBeNull();
  });
});

describe('rectFromCells / 列删除与填充', () => {
  it('竖直拖过同一格得到宽度 1 的矩形', () => {
    expect(rectFromCells({ line: 1, cell: 0 }, { line: 3, cell: 0 })).toEqual({
      fromLine: 1,
      toLine: 3,
      colStart: 0,
      colEnd: 1,
    });
  });
  it('同一行不是列矩形', () => {
    expect(rectFromCells({ line: 2, cell: 0 }, { line: 2, cell: 3 })).toBeNull();
  });
  it('删除第 1 列后右侧左移', () => {
    const lines = [
      { from: 0, text: '12' },
      { from: 3, text: '34' },
      { from: 6, text: '56' },
    ];
    const changes = rectDeleteChanges(
      { fromLine: 1, toLine: 3, colStart: 0, colEnd: 1 },
      n => lines[n - 1]!
    );
    expect(changes).toEqual([
      { from: 0, to: 1 },
      { from: 3, to: 4 },
      { from: 6, to: 7 },
    ]);
  });
  it('填充短行先补空格', () => {
    const lines = [
      { from: 0, text: 'ab' },
      { from: 3, text: 'c' },
    ];
    expect(
      rectFillChanges({ fromLine: 1, toLine: 2, colStart: 2, colEnd: 4 }, n => lines[n - 1]!, 'X')
    ).toEqual([
      { from: 2, to: 2, insert: 'X' },
      { from: 4, to: 4, insert: ' X' },
    ]);
  });
  it('大小写只动矩形内字符', () => {
    const lines = [{ from: 0, text: 'aBcd' }];
    expect(rectCaseChanges({ fromLine: 1, toLine: 1, colStart: 1, colEnd: 3 }, () => lines[0]!, 'upper')).toEqual([
      { from: 1, to: 3, insert: 'BC' },
    ]);
  });
});

describe('rectText（短行补齐到 colEnd）', () => {
  it('用户示例："12/34" 框选第 1 列 → "1\\n3"', () => {
    const lines = ['12', '34'];
    const doc2 = docOfLines(lines);
    const r = rectOf(
      [
        { from: 0, to: 1 },
        { from: 3, to: 4 },
      ],
      doc2
    )!;
    expect(rectText(r, n => lines[n - 1]!)).toEqual(['1', '3']);
  });
  it('短行补空格对齐', () => {
    const lines = ['ab', 'cdef', 'x'];
    const rect = { fromLine: 1, toLine: 3, colStart: 1, colEnd: 3 };
    // 第 3 行 'x' 在列 0（区间外）：slice(1) 得空串，补齐到 colEnd
    expect(rectText(rect, n => lines[n - 1]!)).toEqual(['b ', 'de', '  ']);
  });
});

// 005-01/005-03（审计 2026-10-17）回归锁：矩形三路（rectOf 推回 / rectText 切片 / 查看态）统一**视觉列**口径
// ——修前 rectOf 记字符索引、拖拽路径记视觉列，rectText 按字符切片，CJK 行复制内容错位。
describe('005-01 矩形视觉列口径（CJK）', () => {
  it('rectOf：多选区推回的列是视觉列（中行与英行同格对齐）', () => {
    const doc = docOfLines(['中文ab', 'english']);
    // 行1 选「文」(1..2 字符=视觉列 2..4)；行2 选「gl」(2..4 字符=视觉列 2..4)
    const rect = rectOf(
      [
        { from: 1, to: 2 },
        { from: '中文ab'.length + 1 + 2, to: '中文ab'.length + 1 + 4 },
      ],
      doc
    );
    expect(rect).toEqual({ fromLine: 1, toLine: 2, colStart: 2, colEnd: 4 });
  });

  it('rectText：视觉列切片——CJK 行按 2 格宽对齐英文行', () => {
    const rect = { fromLine: 1, toLine: 2, colStart: 2, colEnd: 4 };
    const out = rectText(rect, n => (n === 1 ? '中文ab' : 'english'));
    // 行1 视觉列 2..4 = 「文」；行2 = 「gl」——两行视觉对齐
    expect(out).toEqual(['文', 'gl']);
  });

  it('rectText：短行按视觉宽补齐（中行短于矩形时补空格到 2 格）', () => {
    const rect = { fromLine: 1, toLine: 2, colStart: 0, colEnd: 4 };
    const out = rectText(rect, n => (n === 1 ? '中' : 'abcd'));
    // 行1「中」占 2 格 → 补 2 空格；行2 前 4 字符
    expect(out).toEqual(['中  ', 'abcd']);
  });
});
