# Data Model: Markdown 即时渲染重构（REQ-014）

**Feature**: [spec.md](spec.md) ｜ **Phase**: 1（Design & Contracts）｜ **Date**: 2026-11-19

> 本 Feature 无持久化数据与跨进程数据交换；以下为运行期核心概念模型（实现载体为 TS 类型，语义在此冻结）。

## 1. ActiveBlock（活动块）

| 字段 | 类型 | 语义 |
|---|---|---|
| from / to | number | 最小包含语法节点（Document 直接子节点级）的文档区间 |
| kind | string | 节点类型（Heading / Paragraph / ListItem / …） |

- 计算：空光标 → 自光标向上找最小包含节点直至 Document 子节点；非空选区 → 所有相交的 Document 子节点集合。
- **状态迁移**：`null ⇄ ActiveBlock ⇄ ActiveBlock'`——仅当光标 head 越过上一活动块边界时视为变化；该变化是触发「重建光标块装饰」的唯一信号（替代现行散布的七处 active(from,to) 闭包）。

## 2. 投影输出（DecorationSet）

- 纯函数 `(doc, tree, viewport, active, refs, emojis, baseDir, …) → DecorationSet`；行内装饰与块级装饰合并在同一 ViewPlugin 输出（blockAtomic）。
- 装饰分三类语义：行内标记显隐（mark replace）、块级替换（异步块：公式 / Mermaid / 图片 / 表格）、行类标记（留白栏 class）。

## 3. needsRebuild 重建分级（引擎调度状态）

| 触发 | 动作 |
|---|---|
| 文档变更（视口内） | 重建视口内区间 |
| 视口变化 | 重建新视口 |
| activeBlock 边界跨越 | 只重建光标前后各一块 |
| 纯选区变化 | 只更新光标块行内装饰 |
| 纯滚动 | 对新进视口区间增量投影，不动已挂载装饰 |

## 4. 表格编辑模型（直接 DOM）

| 概念 | 语义 |
|---|---|
| TableEditWidget | 块级替换挂件；`toDOM()` 生成真 `<table>`，单元格 `contenteditable` + `data-row` / `data-col` |
| 单格写回 | blur 时读单元格文本 → 解析 → 与文档比对 → 单事务写回 CM6 |
| 导航键位 | Tab 右移 / Shift-Tab 左移 / 末列末行 Tab 新建行 / Mod-Enter 跳出或新建行（沿用 live-table-actions 语义） |
| 退化阈值 | >500 行整表退化为源码显示，不渲染挂件 |

## 5. 异步块高度（占位 → 实测）

占位初值 = 挂件 estimatedHeight；渲染完成 → `requestMeasure` 仅更新高度图，**不写 scrollTop**（删除 gapAnchor / liveAnchorReady 整套预言机状态）。

## 6. 既有实体保持不变（边界声明）

Lezer 增量语法树、稳定块身份（document-model / document-worker）、阅读面块几何（reading-surface / blockcache）、滚动锚定（scroll-anchor / user-scroll）均为既有实体，本重构不改其结构。
