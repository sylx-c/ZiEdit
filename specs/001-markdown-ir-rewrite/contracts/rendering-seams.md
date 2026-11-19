# Rendering Seams（渲染接缝契约）: Markdown 即时渲染重构（REQ-014）

**Feature**: [spec.md](../spec.md) ｜ **Phase**: 1（Design & Contracts）｜ **Date**: 2026-11-19

> 本 Feature 不暴露对用户或其他系统的新外部接口；以下为重构后必须成立的**进程内接缝契约**——它们是「三面一致」与「删除冗余通路」的机器可验证形式。

## 1. 单一渲染政策接缝：`renderStaticHtml`

- **契约**：即时渲染（IR）、分屏预览、独立预览三面的静态 HTML 输出，一律由 `src/markdown-view/static-html.ts` 的 `renderStaticHtml(text, tree, metadata, from?, to?, appendFootnotes?)` 承载。
- **义务**：任何渲染政策变化（折行、转义、表格、标题层级、分隔线口径等）只允许改这一处；禁止在任何面重新实现序列化。
- **下游限制**：markdown-it 渲染函数（renderMarkdown / renderMarkdownBlock / renderMarkdownInline）在本重构完成后不存在；markdown-it 仅保留三个纯工具：`validateLink`、`unescapeAll`、`normalizeLink`。
- **回退语义**：Lezer 序列化失败时显示源码 + 错误提示，不再二次渲染（blockcache fallback 简化）。

## 2. 投影器纯函数契约：`projector.ts`

- 签名语义：`(doc, tree, viewport(±300 字符), active: ActiveBlocks, refs, emojis, baseDir, remoteResolve?) → DecorationSet`；`ActiveBlocks` 的定义见 data-model.md §1。
- **必须**：只读语法树 + 文本 + 光标集合；不读 DOM、不异步、不保存状态；同步完成（无图无公式正文 ≤2ms 基准）。
- **必须**：块级标记（`#` `>` `-`）只输出行 class（留白栏承载），不插入标记文本进正文行。
- **必须**：异步块（公式 / Mermaid / 图片 / 表格）只输出 `Decoration.replace({ block: true })`。
- **承载通道（2026-11-20 实施期修正）**：CM6 规定 ViewPlugin 装饰通道（经函数提供）不得含块级件；投影输出
  （行内 + 块级 + 行类合并）由一个**薄 StateField 宿主**存储并直接提供给 `EditorView.decorations`，重建时机
  全部由单一编排 ViewPlugin 按五级分级驱动——宿主不含独立调度逻辑，不构成第二引擎。

## 3. 表格操作契约（用户可见行为）

| 键位 | 行为 |
|---|---|
| Tab | 移到右侧格；末列末行 Tab 新建行 |
| Shift-Tab | 移到左侧格 |
| Mod-Enter | 跳出代码块新建段落（正文域）/ 表格内按既定语义 |
| 撤销一次 | 恢复单格内容（单事务写回保证） |
| >500 行表格 | 退化为源码显示 |

## 4. 既有不变量（本重构不得破坏）

- 外部文本进入 Markdown 渲染前归一 LF（`src/common/text.ts` toLf，三入口）。
- 共享 8ms 帧队列统一布局快照 / 锚定 / 地图采样。
- 用户意图滚动判定（`src/common/user-scroll.ts`）：程序化补偿不触发滚动占位/分片。
- IME 组合期间冻结块级装饰展开。
- 阅读面（reading-surface / blockcache）与文档会话（document-worker / document-model）架构不动。
