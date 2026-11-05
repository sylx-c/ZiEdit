// @vitest-environment jsdom
// 启动期陈旧 DOM 自愈回归锁（89bf712 记档风险收口）：normalizeEditorDom 在任意混合态下
// 都不得假设参照节点已就位——view/rail/main 不在预期父节点下时旧实现 insertBefore 会抛
// NotFoundError 使 boot 中断；本文件锁「任意退化形态 → 无抛错 → 归位权威结构」。
import { describe, expect, it } from 'vitest';
import { normalizeEditorDom } from '../src/shell/app';

/** 权威结构（与 index.html 一致）：editor-col > [ruler, editor-body > [viewarea, editorRail]] */
function authorityHtml(): string {
  return `
    <div class="editor-row" id="editorRow">
      <div class="editor-col" id="editorCol">
        <div class="ruler" data-od-id="ruler"><div class="ruler-marks" id="rulerMarks"></div></div>
        <div class="editor-body" id="editorBody">
          <div class="view" id="viewarea"></div>
          <div class="editor-rail" id="editorRail"></div>
        </div>
      </div>
    </div>`;
}

function expectAuthority(): void {
  const col = document.getElementById('editorCol')!;
  const body = document.getElementById('editorBody')!;
  const rail = document.getElementById('editorRail')!;
  const view = document.getElementById('viewarea')!;
  expect(document.getElementById('editorMain')).toBeNull();
  expect(col.children[0]).toMatchObject({ className: 'ruler' });
  expect(col.children[1]).toBe(body);
  expect(body.children[0]).toBe(view);
  expect(body.children[1]).toBe(rail);
}

describe('normalizeEditorDom 陈旧 DOM 自愈', () => {
  it('健康结构保持不变', () => {
    document.body.innerHTML = authorityHtml();
    const before = document.getElementById('editorCol')!.innerHTML;
    normalizeEditorDom();
    expect(document.getElementById('editorCol')!.innerHTML).toBe(before);
    expectAuthority();
  });

  it('旧包裹层 editorMain（内含 ruler+body）拆包归位', () => {
    document.body.innerHTML = `
      <div id="editorCol">
        <div id="editorMain">
          <div class="ruler"></div>
          <div id="editorBody"><div id="viewarea"></div><div id="editorRail"></div></div>
        </div>
      </div>`;
    normalizeEditorDom();
    expectAuthority();
  });

  it('view/rail 均不在 body 下（记档 NotFoundError 场景）不抛错并归位', () => {
    document.body.innerHTML = `
      <div id="editorCol">
        <div class="ruler"></div>
        <div id="editorBody"></div>
        <div id="viewarea"></div>
        <div id="editorRail"></div>
      </div>`;
    expect(() => normalizeEditorDom()).not.toThrow();
    expectAuthority();
  });

  it('游离的 editorMain 含 body 时先救出 body 再移除包裹层', () => {
    document.body.innerHTML = `
      <div id="editorCol">
        <div class="ruler"></div>
        <div id="editorRail"></div>
      </div>`;
    const main = document.createElement('div');
    main.id = 'editorMain';
    const body = document.createElement('div');
    body.id = 'editorBody';
    const view = document.createElement('div');
    view.id = 'viewarea';
    body.appendChild(view);
    main.appendChild(body);
    document.body.appendChild(main); // main 不在 col 下
    expect(() => normalizeEditorDom()).not.toThrow();
    expectAuthority();
  });

  it('editorMain 在 col 下但不含 body：ruler 归首位、包裹层移除', () => {
    document.body.innerHTML = `
      <div id="editorCol">
        <div id="editorMain"><div class="ruler"></div></div>
        <div id="editorBody"><div id="viewarea"></div><div id="editorRail"></div></div>
      </div>`;
    normalizeEditorDom();
    expectAuthority();
  });
});
