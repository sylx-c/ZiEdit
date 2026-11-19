# Implementation Plan: Markdown 即时渲染重构（REQ-014）

**Branch**: `feat/markdown-ir-rewrite` | **Date**: 2026-11-19 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-markdown-ir-rewrite/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

以单一统一投影器（纯函数 `projector.ts`）+ 单一 ViewPlugin（`md-view-plugin.ts`）取代现行两套并行增量引擎（liveDeco ViewPlugin + liveBlockField StateField），块级标记（`#` `>` `-`）改走 CSS 左侧留白栏消除行宽跳动，删除高度预言机（block-height-cache / gapAnchor）与 JS 间距模型（layout / spacing），三面渲染统一由 `renderStaticHtml` 承载，表格重构为直接 `<table>` DOM 编辑。实施分 P0–P6 七阶段，每阶段独立可撤回、前序测试持续通过；IR 簇生产代码从基线 4,665 行降至 ≤3,000 行。

## Technical Context

**Language/Version**: TypeScript ~6.0.3（仅前端；本重构不涉及 Rust 侧）

**Primary Dependencies**: CodeMirror 6（`@codemirror/language` ^6.13.1 锁定、`@codemirror/view`、`@codemirror/state`）、@lezer/markdown 语法树（单棵三面共享）、markdown-it ^15.0.2（缩减为工具接缝：validateLink / unescapeAll / normalizeLink）。**零新增依赖。**

**Storage**: N/A（无持久化与数据格式变化）

**Testing**: vitest（`npm test`，tests/ 141 文件为回归基线）；原生门禁 `tests/gates/`：gate-ir-settle、gate-md-editing、gate-md-structure、gate-md-consistency、gate-scroll-position、gate-md-surfaces、run-all.mjs 汇总；`npx tsc --noEmit`。

**Target Platform**: Windows / macOS / Linux 桌面（Tauri 2 WebView）；性能门禁仅 Windows 60Hz 物理控制台，各阶段独立 `ZIEDIT_GATE_RUN_DIR`。

**Project Type**: desktop-app 前端子系统重构（brownfield）

**Performance Goals**: typingRebuildMs（汉字/空格/句号）P95 ≤8ms；键入事务 P95 ≤40ms、max ≤50ms、零 >100ms 长任务；cursorWidthChange = 0；scrollReplaceCount = 0（10 秒）；跳转/粘贴停稳顶部位移 ≤1px。

**Constraints**: 不更换 CM6；不动 reading-surface / blockcache / document-worker / document-model；渲染输入 LF 归一不变量（`src/common/text.ts` toLf）保持；共享 8ms 帧队列与 `src/common/user-scroll.ts` 用户意图滚动判定沿用；投影器纯函数（只读语法树+文本+光标，不读 DOM、不异步、无状态），整视口一次投影（±300 字符，同步 ≤2ms 无图无公式基准）。

**Scale/Scope**: 删除 13 个文件（约 1,700–2,400 行，行数随 b415a44 后实测）；IR 簇基线 4,665 行 → ≤3,000 行；表格三件套（cooperative-table / table-viewport / table-editor，共 648 行）替换为 table-widget.ts。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 评估 | 结论 |
|---|---|---|
| I 技术栈稳定 | 保留 CM6 重写投影层；零新依赖；不触碰构建链 | ✅ |
| II 遵循已登记决策 | 本 Feature 即 ADR 017 的实施（2026-11-19 所有者定夺路线 A） | ✅ |
| III 模块边界 | 改动收敛于 `src/markdown-view/` 与 `src/styles.css`；不新增跨模块依赖 | ✅ |
| IV 接口契约与兼容性 | 无 IPC / 持久化契约变化；markdown-it 缩减为进程内工具接缝 | ✅ |
| V 数据保护 | 不涉及用户数据写入路径 | ✅ |
| VI 质量门禁与测试 | 每阶段内置 npm test + tsc + 对应门禁；P6 全量 run-all | ✅ |
| VII 安全与许可红线 | 零新依赖、零新素材，无许可审查增量 | ✅ |
| VIII 复用优先 | 复用 Lezer 单树、renderStaticHtml、8ms 帧队列、user-scroll、toLf | ✅ |
| IX 变更节制 | 属已批准立项的大规模重构（独立立项 + 分七阶段可撤回 + 阶段门禁），满足 IX 的合规路径而非违规 | ✅ |
| X Agent 无关 | 本计划与工件以工具无关方式表述 | ✅ |

**Gate 结论：PASS**（Phase 0 前与 Phase 1 后复核均通过）。

## Project Structure

### Documentation (this feature)

```text
specs/001-markdown-ir-rewrite/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── rendering-seams.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/markdown-view/
├── projector.ts          ← 新（P1）：纯函数投影器，核心逻辑提取自 live-deco.ts
├── active-block.ts       ← 新（P1）：activeBlock(state) 计算，光标块唯一信号
├── md-view-plugin.ts     ← 新（P1）：单一 ViewPlugin（取代 liveDeco + liveBlockField）
├── table-widget.ts       ← 新（P5）：直接 <table> DOM 编辑挂件
├── livepreview.ts        ← 保留类壳，内部引擎替换，精简至 ≤400 行
├── live-state.ts         ← 保留，精简（referenceField / emojiField / mdTouchedField）
├── live-widgets.ts       ← 保留 Img/Render/Task 挂件，删 TableWidget
├── live-reporter.ts      ← 保留（统计/大纲上报）
├── writing.ts            ← 保留，键盘行为不变（P1–P5 不重构）
├── mdformat.ts / extensions.ts / editor-language.ts   ← 保留
├── blockcache.ts         ← 保留，fallback 路径简化（P4）
├── reading-surface.ts / reading-dom.ts                ← 保留不动
├── document-model.ts / document-client.ts / document-worker.ts ← 保留不动
├── static-html.ts        ← 保留，统一序列化微调（P4 载体）
├── headings.ts / preview.ts / md.ts / render-service.ts / render-model.ts
├── imagehost.ts / split-scroll.ts / preview-find.ts / table-model.ts   ← 保留
└── [删除 13 文件] live-block-field.ts、block-height-cache.ts、ir-layout.ts、
    deco-window.ts、typing-window.ts、layout.ts、spacing.ts、ir-perf.ts、
    spacing-contract.test.ts、row-height-cache.test.ts、geometry-refresh.test.ts、
    ir-cache.test.ts、ir-layout.test.ts

src/styles.css            ← P2：.mdir-h1…h6 / .mdir-quote / .mdir-list-line 加 padding-left + ::before 留白栏

tests/gates/              ← 既有门禁复用（gate-ir-settle / md-editing / md-structure /
                            md-consistency / scroll-position / md-surfaces / run-all）
docs/tmp/ir-rewrite-baselines/  ← P0 行为基准（本地目录，已 gitignore，不入公开仓库）
```

**Structure Decision**: 单项目既有结构内重构——全部改动收敛于 `src/markdown-view/`（新增 4 文件、删除 13 文件、原地精简若干）与 `src/styles.css`；不新建目录、不新建包、不动 `src-tauri/`。

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

无违规项。唯一需要说明的规模性变更（删除约 13 文件 / 重写投影层）已按 Constitution 原则 IX 的合规路径执行：所有者批准立项（2026-11-19 决策，ADR 017）+ 七阶段独立可撤回 + 阶段门禁映射（见 research.md 与 spec）。
