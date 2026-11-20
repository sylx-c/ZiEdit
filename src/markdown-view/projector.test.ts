// REQ-014 P1（T009）：统一投影器纯函数单元测试。
// 契约（contracts/rendering-seams.md §2）：只读 doc/tree/index/lens；本文件锁——
// 行 class 输出、行内标记显隐（活动态/触达门）、图片替换件、纯函数确定性。
// 块级件（表格/分隔线/显示公式）随 T010–T011 编排插件合并后并入本投影器，届时补块级断言。
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { editorMarkdown } from './editor-language';
import { referenceIndex } from './live-state';
import { loadMarkdownIt } from './md';
import { projectViewport, type ProjectionLens } from './projector';

beforeAll(async () => { await loadMarkdownIt(); });

function stateOf(doc: string) {
  const state = EditorState.create({ doc, extensions: [editorMarkdown()] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

const lensOf = (ranges: readonly { from: number; to: number }[] = [], overrides: Partial<ProjectionLens> = {}): ProjectionLens => ({
  ranges,
  touched: true,
  formatted: null,
  emojis: {},
  refs: () => new Map(),
  fenceEditing: () => false,
  ...overrides,
});

interface Collected { from: number; to: number; cls?: string; block?: boolean; widget?: boolean }

function collect(doc: string, ranges: readonly { from: number; to: number }[], overrides: Partial<ProjectionLens> = {}): Collected[] {
  const state = stateOf(doc);
  const set = projectViewport(state.doc, ensureSyntaxTree(state, doc.length, 5000)!, { from: 0, to: doc.length },
    referenceIndex(state.doc), lensOf(ranges, overrides), null);
  const out: Collected[] = [];
  for (let c = set.iter(); c.value; c.next()) {
    out.push({
      from: c.from, to: c.to,
      cls: c.value.spec.class,
      block: c.value.spec.block === true,
      widget: c.value.spec.widget != null,
    });
  }
  return out;
}

describe('REQ-014 T009：projectViewport 纯函数投影', () => {
  it('标题行输出 mdir-h1 行 class，正文行不输出', () => {
    const decos = collect('# 题\n\n正文\n', []);
    const line1 = decos.filter(d => d.cls === 'mdir-h1');
    expect(line1).toHaveLength(1);
    expect(line1[0]!.from).toBe(0);
    expect(decos.some(d => d.cls === 'mdir-h2')).toBe(false);
  });

  it('引用行输出 mdir-quote 行 class（带引用深度变量）', () => {
    const decos = collect('> 引用文字\n', []);
    expect(decos.some(d => d.cls === 'mdir-quote')).toBe(true);
  });

  it('非活动的加粗：定界符隐藏（replace 覆盖 **）且整节点带 mdir-strong mark', () => {
    const doc = '甲 **粗体** 乙\n';
    // 0甲 1' ' 2*3* 4粗5体6*7* 8' ' 9乙 → 位置：** = 2..4 与 6..8；StrongEmphasis 节点 = 2..8
    const decos = collect(doc, []);
    const hidden = decos.filter(d => d.widget !== true && d.cls === undefined);
    expect(hidden.some(d => d.from === 2 && d.to === 4)).toBe(true);
    expect(hidden.some(d => d.from === 6 && d.to === 8)).toBe(true);
    expect(decos.some(d => d.cls === 'mdir-strong' && d.from === 2 && d.to === 8)).toBe(true);
  });

  it('光标进入加粗内部（touched）：定界符不再隐藏、mark 不再输出（源码可见）', () => {
    const doc = '甲 **粗体** 乙\n';
    const decos = collect(doc, [{ from: 5, to: 5 }]);
    expect(decos.some(d => d.cls === 'mdir-strong')).toBe(false);
    expect(decos.some(d => d.from === 2 && d.to === 4 && d.cls === undefined && d.widget !== true)).toBe(false);
  });

  it('标题井号 P2 留白栏：井号常隐（正文范围恒定），活动态只切换留白栏类（不受 touched 门影响的是显隐位置而非隐藏）', () => {
    const doc = '# 题\n';
    // 未触达 + 贴内光标：井号隐藏（0..2），无 marks-on 类（留白栏只显级别色条）。
    const untouched = collect(doc, [{ from: 2, to: 2 }], { touched: false });
    expect(untouched.some(d => d.from === 0 && d.to === 2 && d.cls === undefined && d.widget !== true)).toBe(true);
    expect(untouched.some(d => typeof d.cls === 'string' && d.cls.includes('mdir-marks-on'))).toBe(false);
    // 触达且光标在标题内部：井号仍隐藏，但行类带 mdir-marks-on（留白栏显示井号，宽度不变）。
    const touched = collect(doc, [{ from: 2, to: 2 }], { touched: true });
    expect(touched.some(d => d.from === 0 && d.to === 2 && d.cls === undefined && d.widget !== true)).toBe(true);
    expect(touched.some(d => typeof d.cls === 'string' && d.cls.includes('mdir-marks-on'))).toBe(true);
    expect(touched.some(d => typeof d.cls === 'string' && d.cls.includes('data-marks') === false && d.cls.includes('mdir-h1'))).toBe(true);
  });

  it('图片语法整体替换为图片件（widget replace，覆盖 ![alt](url)）', () => {
    const decos = collect('![替代](https://example.test/a.png)\n', []);
    const image = decos.find(d => d.widget === true);
    expect(image).toBeDefined();
    expect(image!.from).toBe(0);
    expect(image!.to).toBe('![替代](https://example.test/a.png)'.length);
  });

  it('纯函数确定性：相同输入两次调用产出完全相同的装饰集合', () => {
    const doc = '# 题\n\n甲 **粗** 乙\n\n> 引\n\n- 列表项\n';
    const a = collect(doc, [{ from: 20, to: 20 }]);
    const b = collect(doc, [{ from: 20, to: 20 }]);
    expect(a).toEqual(b);
  });

  it('视口裁剪：区间外的标记不产出（行 class 仅落在视口内行）', () => {
    const doc = '# 题\n\n甲 **粗** 乙\n';
    const state = stateOf(doc);
    const set = projectViewport(state.doc, ensureSyntaxTree(state, doc.length, 5000)!, { from: 5, to: doc.length },
      referenceIndex(state.doc), lensOf([]), null);
    const out: Collected[] = [];
    for (let c = set.iter(); c.value; c.next()) out.push({ from: c.from, to: c.to, cls: c.value.spec.class, widget: c.value.spec.widget != null });
    expect(out.some(d => d.cls === 'mdir-h1')).toBe(false);
    expect(out.some(d => d.cls === 'mdir-strong')).toBe(true);
  });
});
