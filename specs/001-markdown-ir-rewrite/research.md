# Research: Markdown 即时渲染重构（REQ-014）

**Feature**: [spec.md](spec.md) ｜ **Phase**: 0（Outline & Research）｜ **Date**: 2026-11-19

> 本 Feature 的关键决策均已于 2026-11-19 由所有者定夺在案；本文件将既有调研结论收敛为可追溯记录，Technical Context 无 NEEDS CLARIFICATION 项需要新研究任务。

## 1. 路线决策：统一投影器（路线 A）

- **Decision**: 保留 CodeMirror 6，重写投影层——单一纯函数投影器 + 单一 ViewPlugin 取代两套并行增量引擎；删除高度预言机与 JS 间距模型；三面渲染统一由 `renderStaticHtml` 承载；表格改直接 DOM 编辑。
- **Rationale**: 三类已验证症状的共同根源是架构性的——
  1. 两套引擎（liveDeco ViewPlugin + liveBlockField StateField）各自分片、各自调度、各自测量，条件爆炸导致快路可达性低于慢路（`src/markdown-view/livepreview.ts`、`src/markdown-view/live-block-field.ts`）；
  2. 快路字符类只认 `\p{L}\p{N}`，空格与全部标点触发整视口重建；复用判定扫描整个装饰集，视口含任一非文本挂件即失效（`src/markdown-view/typing-window.ts:12` 实测 `/^[\p{L}\p{N}]*$/u`）；
  3. 高度预言机对 CM6 高度图预测偏差产生停稳位移（block-height-cache / gapAnchor）；CSS 间距在 JS 中重算（layout / spacing）必然与真值漂移；四条渲染通路政策各写一遍导致三面不一致。
- **Alternatives considered**:
  - **路线 B「渐进收紧」**（不重写引擎，仅放宽键入快路、空光标不改行宽、纯滚动不换已挂载块、补等价测试，约 4–6 天）：落选——两套引擎的条件爆炸仍在，快路可达性提升有上限，治标不治本；原稿维持归档可溯源。
  - **contenteditable 块编辑器方案**：排除——源码模式必须共用同一引擎，块编辑器无法满足。
  - **更换第三方 Markdown 编辑器库**：排除——违反技术栈稳定原则（Constitution I），且现有四模式/阅读面/查找体系深度耦合 CM6。

## 2. 关键机制可行性（已验证的事实依据）

- **ViewPlugin 承载块级装饰**：CM6 6.x 允许 ViewPlugin 提供块级装饰（blockAtomic 前提），由此可消除 liveBlockField 的 StateField——这是「两套合一」的技术前提。
- **needsRebuild 五级分级**：视口内文档变更→重建视口内；视口变化→重建新视口；光标块进出（activeBlock 边界跨越）→只重建光标前后各一块；纯选区变化→只更新光标块行内装饰；纯滚动→对新进视口区间增量投影，不动已挂载装饰。
- **异步块高度策略**：挂件 estimatedHeight 给占位初值，渲染完成后 `requestMeasure` 仅更新高度图、不写 scrollTop——取代高度预言机。
- **块级标记留白栏**：`Decoration.line({ class })` + CSS `::before` 伪元素承载 `#` `>` `-`，不把标记文本插入正文行——消除行宽跳动的关键。
- **表格直接 DOM**：现行 cooperative-table（Lezer 扩展）+ table-viewport（行虚拟化）+ table-editor（内嵌 CM6）共 648 行是「DOM 当状态」最重的部分；替换为 `TableWidget.toDOM()` 生成真 `<table>`、单元格 contenteditable、blur 单事务写回；≤500 行全渲染、>500 行退化源码显示（Typora 行为）。Tab/Shift-Tab/Mod-Enter 操作逻辑从 live-table-actions.ts 提取保留。
- **markdown-it 去留**：渲染逻辑（renderMarkdown 系列）全部删除；保留 validateLink / unescapeAll / normalizeLink 三个纯工具接缝。

## 3. 口径决策记录（所有者 2026-11-19 确认）

| 事项 | 决策 | 说明 |
|---|---|---|
| P0 行为基准存放位置 | `docs/tmp/ir-rewrite-baselines/`（本地，已 gitignore） | 原设计稿所写目录体系已撤并，改用本地证据目录 |
| 行数统计口径（REQ-014.7） | `live-*` / `writing` / `table*` / `layout` / `spacing` 分类生产代码，不含测试 | 基线实测 4,665 行（b415a44 后）；四个支撑文件（typing-window / deco-window / block-height-cache / ir-perf）均在删除清单内，验收时已不存在 |
| 分支策略 | `feat/markdown-ir-rewrite` 从干净 master 切出 | 已执行 |
| 阶段门禁 | P0–P6 每阶段独立 `ZIEDIT_GATE_RUN_DIR` + `prepare-gate-build.mjs --build`，不跨阶段复用 profile | 见 quickstart.md |

## 4. 根因行号漂移说明

设计原稿中的根因定位行号取自其撰写时点；其后 b415a44（Markdown 展示一致性修复）落地改动了 live-block-field / live-deco / md / headings / extensions / static-html 等文件，个别文件行数与行号有漂移（如 typing-window.ts 34 行 vs 原稿 83）。**实施时以文件名与行为语义定位为准，行号仅作参考。**
