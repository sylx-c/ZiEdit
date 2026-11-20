---
description: "Task list for feature implementation"
---

# Tasks: Markdown 即时渲染重构（REQ-014）

**Input**: Design documents from `/specs/001-markdown-ir-rewrite/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: 本 Feature 的规格（FR-011）与既定阶段门禁明确要求测试。P0 先行测试锁行为（立即绿，非红绿流程）；新引擎、新挂件必须附新测试，旧实现测试按下方处置表迁移或删除。

**标准提交前门禁**：每次提交前 MUST 通过 `npm test`、`npx tsc --noEmit`、`cargo test --manifest-path src-tauri/Cargo.toml`、`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`、`cargo fmt --manifest-path src-tauri/Cargo.toml --check`、`npm run license:check`；涉及分发材料时加 `npm run license:dist`。各阶段检查点均包含此整套门禁，下列“标准提交前门禁 + 阶段门禁”不得解释为省略其中任何一项。

**Organization**: 用户故事与实施阶段 1:1 映射（US1=P1 单一投影器 … US5=P5 表格重构）。**阶段间严格串行**：每阶段门禁全绿才进下一阶段，前序阶段测试持续通过（已定夺的实施顺序，不并行推进跨阶段任务）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root（本 Feature 全部改动收敛于 `src/markdown-view/`、`src/styles.css`、`tests/gates/` 运行与 `docs/CHANGELOG.md`）

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 环境与基线就绪，确认改造前一切绿。

- [x] T001 验证门禁环境与基线：Windows 60Hz 本地物理控制台（确认无远程显示适配器活跃）、`npm ci`、标准提交前门禁全绿；记录 `npm test` 的 141 文件改造前基线与各项数值
- [x] T002 创建本地行为基准目录 `docs/tmp/ir-rewrite-baselines/`（已 gitignore，不入公开仓库）

**Checkpoint**: 基线全绿，可开始 P0。

---

## Phase 2: Foundational (Blocking Prerequisites) —— P0 行为基准

**Purpose**: 在改任何代码之前锁住当前行为事实；未完成前禁止任何用户故事开工。

- [x] T003 对五份基准语料（GFM 表格含粗体行内码 / 真 ATX 标题 1–6 / 围栏内假标题 / `---` 下划线行 / 嵌套列表+引用+行内公式）在即时渲染、分屏、独立预览三面截图，存 `docs/tmp/ir-rewrite-baselines/`
- [x] T004 [P] 审计 spec.md Edge Cases（空文档/单标题、跨块选区、解析未就绪、IME、表格 500/501 行、未闭合围栏）的现有测试覆盖并记录到 `docs/tmp/ir-rewrite-baselines/coverage.md`；在 `src/markdown-view/live-heading.test.ts` 增加「空光标在块外 / 块内 / 块边界」三种场景装饰断言，对审计发现的空缺在对应现有测试文件补回归测试
- [x] T005 [P] 在 `src/markdown-view/render-correctness.test.ts` 增加五份语料断言（不归一化 `s`/`del`）
- [x] T006 在 `src/markdown-view/ir-perf.ts` 增加四个计数探针：`typingRebuildMs` / `scrollReplaceCount` / `cursorWidthChange` / `decoRebuildRange`
- [x] T007 P0 检查点：标准提交前门禁全绿、四探针可读数；覆盖审计无未处置空缺

**Checkpoint**: 行为基准与探针就绪——用户故事（阶段）实现可以开始。

### 旧实现测试处置表（P1 开工前确认）

| 测试文件 | 阶段 | 处置 |
|---|---|---|
| `src/markdown-view/typing-window.test.ts` | P1 | 随 typing-window 快路删除；新键入路径由 md-view-plugin.test.ts 覆盖 |
| `src/markdown-view/geometry-refresh.test.ts` | P1 | 提前删除：其 liveBlockField/liveAnchorReady 对象在 P1 移除；滚动与停稳行为由新引擎测试及 P3 门禁承接 |
| `src/markdown-view/ir-cache.test.ts` | P1 | 提前删除：旧分片/缓存/高度模型随新引擎失效；五级重建与零替换由 md-view-plugin.test.ts 覆盖 |
| `src/markdown-view/input-order.test.ts` | P1、P5 | P1 迁移 liveViewport 依赖至新引擎；P5 迁移 cellRange 依赖至新表格接缝，保留输入顺序断言 |
| `src/markdown-view/block-height-cache.test.ts` | P3 | 随 block-height-cache 删除 |
| `src/markdown-view/row-height-cache.test.ts` | P3 | 随旧高度缓存/表格行高模型删除 |
| `src/markdown-view/spacing-contract.test.ts` | P3 | 随 JS 间距模型删除；CSS 间距由三面一致性与结构门禁承接 |
| `src/markdown-view/ir-layout.test.ts` | P3 | 与 ir-layout.ts 同阶段删除，禁止留到 P6 |
| `src/markdown-view/cooperative-table.test.ts` | P5 | 旧解析器专属断言随模块删除；共享行为迁入 table-widget.test.ts |
| `src/markdown-view/table-scroll.test.ts` | P5 | 可迁移的滚动行为改测 table-widget.ts；仅旧 TableViewport 私有实现断言删除 |
| `src/markdown-view/scroll-settle.test.ts` | P5 | 迁移至 table-widget.ts 的滚动停稳行为，不直接丢弃验收覆盖 |

---

## Phase 3: User Story 1 - 连续键入跟手 (Priority: P1) 🎯 MVP —— P1 单一投影器

**Goal**: 删除两套并行增量引擎，合并为单一投影器 + 单一 ViewPlugin；键入只执行一次同步纯函数视口投影，不进入旧管线。

**Independent Test**: 标准提交前门禁 + gate-ir-settle + gate-md-editing（独立 `ZIEDIT_GATE_RUN_DIR` + `node tests/gates/prepare-gate-build.mjs --build`）；探针 typingRebuildMs（汉字/空格/句号）P95 ≤8ms、scrollReplaceCount = 0。

### Implementation for User Story 1

- [x] T008 [US1] 新建 `src/markdown-view/active-block.ts`：实现 `activeBlocks(state): ActiveBlocks`，空光标返回零/一个块、非空选区按文档序返回全部相交块；逐字段依据 data-model.md §1 的 `ActiveBlock.from`、`ActiveBlock.to`、`ActiveBlock.kind`；在 `src/markdown-view/active-block.test.ts` 覆盖空光标、块边界与跨块选区
- [x] T009 [US1] 新建 `src/markdown-view/projector.ts`：从 `src/markdown-view/live-deco.ts` 提取投影核心为纯函数 `projectViewport(doc, tree, viewport, active: ActiveBlocks, refs, emojis, baseDir, remoteResolve?)`，契约按 contracts/rendering-seams.md §2；在 `src/markdown-view/projector.test.ts` 覆盖纯函数输入、行 class 与块级 replace 输出
- [x] T010 [US1] 新建 `src/markdown-view/md-view-plugin.ts`：单一 ViewPlugin（blockAtomic），`needsRebuild` 五级分级按 data-model.md §3（视口内变更只作一次同步投影/视口变化/ActiveBlocks 集合变化/同块纯选区/纯滚动）；在 `src/markdown-view/md-view-plugin.test.ts` 覆盖五级调度与已挂载块零替换
- [x] T011 [US1] `src/markdown-view/livepreview.ts` 换用新插件，移除 liveDeco ViewPlugin + liveBlockField StateField 装配；类壳精简（目标 ≤400 行，P6 复核）
- [x] T012 [US1] 新引擎测试稳定后删除 `src/markdown-view/live-block-field.ts`、`src/markdown-view/deco-window.ts`、`src/markdown-view/typing-window.ts`，并按处置表删除 `src/markdown-view/typing-window.test.ts`、`src/markdown-view/geometry-refresh.test.ts`、`src/markdown-view/ir-cache.test.ts`；迁移 `src/markdown-view/input-order.test.ts` 的 liveViewport 依赖，修复其余受影响引用
- [ ] T013 [US1] P1 检查点：标准提交前门禁 + gate-ir-settle + gate-md-editing 全绿；typingRebuildMs P95 ≤8ms、scrollReplaceCount = 0

**Checkpoint**: US1 独立可测交付——两套引擎已合一，键入跟手达标。

---

## Phase 4: User Story 2 - 标记显隐稳定、行宽不跳 (Priority: P2) —— P2 块级标记留白栏

**Goal**: `#` `>` `-` 走 CSS 左侧留白栏，光标进出不改行宽；行内标记重建收敛到 ActiveBlocks 集合内。

**Independent Test**: 标准提交前门禁 + P1 原生门禁 + gate-md-structure + gate-md-consistency；cursorWidthChange = 0；五语料三面输出与 P0 基准一致。

### Implementation for User Story 2

- [x] T014 [US2] `src/styles.css`：为 `.mdir-h1`…`.mdir-h6`、`.mdir-quote`、`.mdir-list-line` 增加 `padding-left` + `::before` 伪元素留白栏（IR 与预览共用令牌口径）
- [x] T015 [US2] `src/markdown-view/projector.ts`：删除「活动时插回 `#` 文本」逻辑，所有情况只加 CSS class；光标在标题内时经 `data-heading-level` 等属性让 `::before` 显示级别符号（不推正文）
- [x] T016 [US2] `src/markdown-view/md-view-plugin.ts` + `src/markdown-view/projector.ts`：行内标记（`**` `*` `~~` `` ` `` `[]()`）显隐改为 ActiveBlocks 集合内重建（同块内移动只更新该块行内装饰）
- [ ] T017 [US2] P2 检查点：标准提交前门禁 + P1 原生门禁 + gate-md-structure + gate-md-consistency 全绿；cursorWidthChange = 0；五语料三面对比 P0 基准一致

**Checkpoint**: US2 交付——光标移动零行宽变化。

---

## Phase 5: User Story 3 - 滚动与停稳不位移 (Priority: P3) —— P3 删除高度预言机

**Goal**: 删除 block-height-cache / gapAnchor / JS 间距模型整套；异步块只更新高度图不写 scrollTop；间距改 CSS 承载。

**Independent Test**: 标准提交前门禁 + P2 原生门禁 + gate-scroll-position + gate-md-surfaces；大纲/查找跳转与粘贴大段后停稳顶部位移 ≤1px；连续滚动 10 秒 scrollReplaceCount = 0。

### Implementation for User Story 3

- [x] T018 [US3] `src/markdown-view/live-widgets.ts`：公式/Mermaid/图片挂件 `toDOM()` 先渲染固定高度占位（estimatedHeight 初值语义按 data-model.md §5），挂载完成后 `view.requestMeasure()` 仅更新高度图、不写 scrollTop
- [x] T019 [US3] 删除 `src/markdown-view/ir-layout.ts`（gapAnchor）及 `src/markdown-view/livepreview.ts` 中 `liveAnchorReady` / `revealWhenReady` 依赖高度预言机的路径（直接 dispatch，不追加 scrollIntoView）；同阶段删除 `src/markdown-view/ir-layout.test.ts`
- [x] T020 [US3] 删除 `src/markdown-view/block-height-cache.ts`、`src/markdown-view/layout.ts`、`src/markdown-view/spacing.ts` 及处置表指定的 `src/markdown-view/block-height-cache.test.ts`、`src/markdown-view/row-height-cache.test.ts`、`src/markdown-view/spacing-contract.test.ts`；同步解除 `src/markdown-view/livepreview.ts`、`src/markdown-view/live-widgets.ts`、`src/markdown-view/table-viewport.ts` 对三类旧模型的引用；IR 段落间距在 `src/styles.css` 改由 line class 单边 `margin-top` 承载
- [ ] T021 [US3] P3 检查点：标准提交前门禁 + P2 原生门禁 + gate-scroll-position + gate-md-surfaces 全绿；停稳 ≤1px、10 秒滚动零替换

**Checkpoint**: US3 交付——滚动与停稳稳定。

---

## Phase 6: User Story 4 - 三面渲染一致 (Priority: P4) —— P4 统一渲染政策

**Goal**: 删除 markdown-it 渲染路径（保留三个纯工具），三面输出统一由 renderStaticHtml 承载；消除 md-space-fold 折行差。

**Independent Test**: 标准提交前门禁 + P3 原生门禁 + gate-md-structure（五份新语料）；三面截图对比完全一致（不归一化）。

### Implementation for User Story 4

- [ ] T022 [US4] 删除 `src/markdown-view/preview.ts` 中 `renderMarkdown` / `renderMarkdownBlock` / `renderMarkdownInline`，三面输出统一走 `src/markdown-view/static-html.ts` 的 `renderStaticHtml`（契约 contracts/rendering-seams.md §1）
- [ ] T023 [US4] `src/markdown-view/blockcache.ts` fallback 路径改为：Lezer 序列化失败时显示源码 + 错误提示，不再二次渲染
- [ ] T024 [US4] 表格单元格行内渲染改为调用 `renderStaticHtml`（传入单元格子树片段）——过渡期接缝，P5 随新表格挂件收口
- [ ] T025 [US4] `src/markdown-view/md.ts` 删除全部渲染逻辑，仅保留 `loadMarkdownIt()` 用于工具注入（validateLink / unescapeAll / normalizeLink）；删除 `src/markdown-view/projector.ts` 从旧实现继承的 `md-space-fold` IR 独有折行差，并清理 `src/styles.css` 对应规则
- [ ] T026 [US4] P4 检查点：标准提交前门禁 + P3 原生门禁 + gate-md-structure（五份新语料）全绿；五语料三面截图不归一化一致（对照 `docs/tmp/ir-rewrite-baselines/` 更新基准）

**Checkpoint**: US4 交付——三面一致。

---

## Phase 7: User Story 5 - 表格直接编辑 (Priority: P5) —— P5 表格重构

**Goal**: 删除 cooperative-table / table-viewport / table-editor 三件套，改为直接 `<table>` DOM 编辑；完整保持键位与撤销语义。

**Independent Test**: 标准提交前门禁 + P4 原生门禁 + gate-md-editing（表格操作）；Tab/Shift-Tab 导航正确、末列末行 Tab 新建行、撤销一次恢复单格内容；>500 行表格退化源码显示。

### Implementation for User Story 5

- [ ] T027 [US5] 新建 `src/markdown-view/table-widget.ts`：`TableEditWidget` 块级挂件，`toDOM()` 生成真 `<table>`，单元格 `contenteditable`；`TableEditWidget.data-row` 与 `TableEditWidget.data-col` 分别遵循 data-model.md §4 的同名字段定义；blur 读文本→解析→比对→单事务写回；≤500 行全渲染、>500 行退化源码；在 `src/markdown-view/table-widget.test.ts` 覆盖坐标、写回、阈值与撤销
- [ ] T028 [US5] 从 `src/markdown-view/live-table-actions.ts` 提取 Tab / Shift-Tab / 末行新建 / Mod-Enter 键位逻辑接入新挂件；同步改造 `src/markdown-view/extensions.ts`（移除 cooperativeTableParser/Nodes 注册）、`src/markdown-view/livepreview.ts`、`src/markdown-view/live-widgets.ts`、`src/markdown-view/live-table-actions.ts`，使生产代码不再引用旧表格三件套
- [ ] T029 [US5] 生产引用迁移通过后删除 `src/markdown-view/table-viewport.ts`、`src/markdown-view/table-editor.ts`、`src/markdown-view/cooperative-table.ts`；按处置表迁移 `src/markdown-view/input-order.test.ts`、`src/markdown-view/table-scroll.test.ts`、`src/markdown-view/scroll-settle.test.ts`，删除 `src/markdown-view/cooperative-table.test.ts` 及仅适用于旧实现的断言；保留 `src/markdown-view/table-model.ts` 纯函数
- [ ] T030 [US5] P5 检查点：标准提交前门禁 + P4 原生门禁 + gate-md-editing（表格操作）全绿；撤销恢复单格内容验证通过

**Checkpoint**: US5 交付——表格直接编辑完整可用。

---

## Phase 8: Polish & Cross-Cutting Concerns —— P6 清理

**Purpose**: 删除残留、行数收口、全量验证与文档。

- [ ] T031 删除 `src/markdown-view/ir-perf.ts`，清理无调用者的分支、临时开关与旧计数探针；确认 geometry-refresh.test.ts、ir-cache.test.ts、ir-layout.test.ts 已按处置表在 P1/P3 删除，不重复等待到 P6
- [ ] T032 行数核验：IR 簇（`live-*` / `writing` / `table*` / `layout` / `spacing` 分类生产代码，口径见 research.md §3）≤3,000 行（基线 4,665）
- [ ] T033 全量门禁：标准提交前门禁全绿；独立 `ZIEDIT_GATE_RUN_DIR` 下执行 `node tests/gates/prepare-gate-build.mjs --build`、`node tests/gates/run-all.mjs` 默认完整集，并重跑未纳入默认集的本 Feature 阶段门禁（gate-ir-settle / gate-md-consistency / gate-scroll-position / gate-md-editing）
- [ ] T034 按 `specs/001-markdown-ir-rewrite/quickstart.md` 全部手动验证场景执行并记录结果
- [ ] T035 更新 `docs/CHANGELOG.md` 未发布节（面向使用者口径，不写内部术语）；收尾汇报 MUST 提醒所有者同步其本地维护的需求与架构资料，但不自动修改这些资料

---

## Dependencies & Execution Order

### Phase Dependencies（严格串行——已定夺的实施顺序）

- **Phase 1 → Phase 2（P0）**：环境基线 → 行为基准（P0 未完成禁止动实现代码）
- **P0 → US1(P1) → US2(P2) → US3(P3) → US4(P4) → US5(P5) → Polish(P6)**：每阶段门禁全绿才进下一阶段；**前序阶段的测试在后续阶段必须继续通过**；每阶段独立可撤回（git 提交粒度对齐阶段）
- 用户故事在本 Feature 中映射为串行阶段（后段建立在前段新引擎上），独立性体现为**每阶段有独立门禁与检查点、可独立撤回**，而非并行开发
- 旧实现测试的迁移/删除以 P0 处置表为准；不得让后续阶段继续引用已删除模块

### Within Each User Story

- 新建文件与新测试 → 装配替换 → 同步迁移全部引用方 → 删除旧文件及旧实现专属测试 → 阶段检查点（标准提交前门禁 + 原生门禁）
- 删除任务与引用迁移必须在同一阶段闭环，禁止留下无法编译的中间检查点

### Parallel Opportunities

- Phase 2：T004 与 T005（不同测试文件）可并行
- 同阶段内互不依赖的不同文件任务（已标 [P]）
- 各阶段检查点内部的前端与 Rust 侧固定检查互不影响（本 Feature 不改 Rust，但仍执行其提交前门禁）

---

## Parallel Example: Phase 2 (P0)

```text
Task: "live-heading.test.ts 三场景装饰断言与边界覆盖审计"（src/markdown-view/live-heading.test.ts、docs/tmp/ir-rewrite-baselines/coverage.md）
Task: "render-correctness.test.ts 五语料断言"（src/markdown-view/render-correctness.test.ts）
```

---

## Implementation Strategy

### MVP First（Phase 1–3，即 P0+P1）

1. 完成 Setup 与 P0 行为基准（锁行为）
2. 完成 US1（P1 单一投影器）并过 P1 门禁
3. **STOP and VALIDATE**：此时已消除两套引擎与打字慢路根因，可独立交付/演示；后续每阶段为一个增量交付点，任一阶段失败仅撤回该阶段

### Incremental Delivery

P0 基准 → P1 键入跟手（MVP）→ P2 行宽稳定 → P3 滚动稳定 → P4 三面一致 → P5 表格 → P6 清理收口；每阶段后 CHANGELOG 不动（收口时统一记入未发布节）。

---

## Notes

- [P] tasks = different files, no dependencies
- 旧测试不是一概删除：可迁移的用户行为必须迁至新引擎/新挂件测试；仅旧私有实现专属断言随模块移除
- 设计稿根因行号有漂移（research.md §4）：实施以文件名与行为语义定位为准
- Commit after each task or logical group（每次提交须所有者授权且先过标准提交前门禁，按 Constitution 工作流）
- Stop at any checkpoint to validate story independently
