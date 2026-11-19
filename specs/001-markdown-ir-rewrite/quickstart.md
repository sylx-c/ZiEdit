# Quickstart: Markdown 即时渲染重构（REQ-014）验证指南

**Feature**: [spec.md](spec.md) ｜ **Phase**: 1（Design & Contracts）｜ **Date**: 2026-11-19

> 端到端验证指南：证明 Feature 可用与各阶段门禁通过的最小操作集。实现细节见 tasks.md（后续 `/speckit-tasks` 生成）。

## 前置条件

- Node 24（满足 pdfjs-dist engines）、`npm ci` 已安装依赖。
- 单元/集成验证：`npm test`、`npx tsc --noEmit`。
- 原生性能门禁（仅 Windows）：**60Hz 本地物理控制台**（远程虚拟屏 32Hz 会让帧节律门禁全挂，先确认无远程显示适配器活跃）；每阶段独立运行目录，不跨阶段复用 profile。

## 阶段门禁矩阵（每阶段必须全绿才进下一阶段）

| 阶段 | 命令 | 通过条件 |
|---|---|---|
| P0–P6 通用 | `npm test` ＋ `npx tsc --noEmit` | 141 测试文件全绿、类型零错误 |
| P1 | gate-ir-settle、gate-md-editing | 探针 typingRebuildMs P95 ≤8ms；scrollReplaceCount = 0 |
| P2 | + gate-md-structure、gate-md-consistency | cursorWidthChange = 0；五语料三面截图一致 |
| P3 | + gate-scroll-position、gate-md-surfaces | 停稳顶部位移 ≤1px |
| P4 | + gate-md-structure（五份新语料） | 三面完全一致（不归一化） |
| P5 | + gate-md-editing（表格操作） | Tab/Shift-Tab/新建行/单格撤销正确 |
| P6 | `node tests/gates/run-all.mjs` 全量 ＋ 行数核验 | 全绿；IR 簇 ≤3,000 行 |

原生门禁执行方式（每阶段）：

```powershell
$env:ZIEDIT_GATE_RUN_DIR = "<独立运行目录 rN>"
node tests/gates/prepare-gate-build.mjs --build
# 然后运行上表对应 gate-*.mjs
```

## 手动验证场景（桌面 `npm run tauri dev`）

1. **键入跟手**：打开中文正文 → IR 模式连续键入汉字/空格/标点 → 全程无重卡、无跳动。
2. **标记显隐**：光标逐个进出标题/加粗/链接 → 标记就地显示/隐藏，行宽与正文起始位置不动（块级标记在左侧留白栏）。
3. **滚动稳定**：长文滚过已渲染表格/公式/图片 10 秒 → 内容不被替换重挂；大纲跳转/粘贴大段后停稳 → 顶部不位移。
4. **三面一致**：五份基准语料（GFM 表格含粗体行内码 / 真 ATX 标题 1–6 / 围栏内假标题 / `---` 分隔线 / 嵌套列表+引用+行内公式）分别在 IR、分屏、独立预览查看 → 输出一致。
5. **表格编辑**：单元格点击编辑、Tab/Shift-Tab 遍历、末列末行 Tab 新建行、改一格撤销一次 → 仅该格恢复；构造 >500 行表格 → 源码态显示。

## 行为基准（P0 产出）

P0 阶段对五份语料三面截图并记录至 `docs/tmp/ir-rewrite-baselines/`（本地目录，已 gitignore）；P2/P4 的「三面一致」以该基准对比验收。

## 预期结果汇总

全部阶段完成后：spec 的 SC-001～SC-007 逐项可测通过（指标见 [spec.md](spec.md) Success Criteria），`npm test` / `tsc` / `run-all.mjs` 全绿，IR 簇生产代码 ≤3,000 行。
