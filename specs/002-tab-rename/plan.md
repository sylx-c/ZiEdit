# Implementation Plan: 标签右键重命名

**Branch**: `002-tab-rename` | **Date**: 2026-11-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-tab-rename/spec.md`

## Summary

已打开的本地文件可以从标签右键改名，不必关闭标签再去系统文件管理器。磁盘操作复用现有 `file_rename`；成功后按精确路径迁移该标签的未保存内容、视图记忆和路径记录。草稿、对比、尾随台不提供入口。目录改名仍只在文件树，避免单文件改名误迁子路径。

## Technical Context

**Language/Version**: TypeScript 5.6（前端）、Rust edition 2024（Tauri 2 命令层）

**Primary Dependencies**: 现有标签菜单、`dlgPrompt`、`fileRename`、`TabStore`、`DocumentSessionStore`、recent/favorites JSON 持久化。不新增第三方依赖。

**Storage**: 用户文件只做同目录 `rename`。应用配置只原位更新 `recent.json` 与 `favorites.json` 中的路径字符串，不改字段。

**Testing**: Vitest（`tests/` 与壳层单测）、`tsc --noEmit`；持久化迁移附 Rust 单测。

**Target Platform**: Windows / macOS / Linux 桌面应用，离线。

**Project Type**: 跨平台桌面文件查看与编辑器。

**Performance Goals**: 改名是一次目录项重命名，不读文件正文。确认后界面在 2 秒内显示新名称；不引入整文件读入内存。

**Constraints**: 命令层只做校验与转发；不新增出网；不覆盖已存在目标；失败不得先改内存；配置写失败不回滚已成功的磁盘改名；不新建风格工具链。

**Scale/Scope**: 一次一个已打开文件。影响标签菜单、改名成功后的状态迁移、最近/收藏路径记录。不包含批量改名、目录改名或跨目录移动。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 结果 |
|---|---|
| I 技术栈稳定 | 通过。不换编辑器、渲染器或构建方式。 |
| II 已登记决策 | 通过。沿用原子写与现有错误哨兵，不推翻 ADR。 |
| III 模块边界 | 通过。新的记录迁移放在持久化侧，命令层只校验和转发；前端迁移动作留在壳层，不把标签策略写进 Rust 引擎。 |
| IV 接口契约 | 通过。`file_rename` 参数与哨兵不变。新增操作只改路径字符串，旧 JSON 字段语义不变。 |
| V 数据保护 | 通过。先磁盘成功再迁内存；不覆盖；不把未保存内容写到新路径或丢弃。配置写失败可观测且不阻断已完成的改名。 |
| VI 质量门禁 | 通过。实现阶段补回归测试，提交前跑既有前端与 Rust 门禁。 |
| VII 安全与许可 | 通过。无新出网、无新依赖、不放宽路径边界。 |
| VIII 复用优先 | 通过。复用标签菜单、改名对话框、`fileRename`、文档会话 `rename`。 |
| IX 变更节制 | 通过。不重构标签栏。唯一行为修正是单文件迁移不再走目录前缀，避免误迁子标签。 |
| X Agent 无关 | 通过。工件在 `specs/002-tab-rename/`，不含本地资料路径。 |

Phase 1 设计后复检：仍通过。没有需要记入 Complexity Tracking 的违规。

## Project Structure

### Documentation (this feature)

```text
specs/002-tab-rename/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── tab-rename.md
└── tasks.md             # /speckit-tasks 生成，本命令不创建
```

### Source Code (repository root)

```text
src/shell/app.ts                 # 标签菜单入口；成功后的精确迁移与视图更新
src/common/state.ts              # 单文件路径替换，保留标签身份
src/common/ipc.ts                # 路径记录迁移的类型化封装
src/common/i18n.ts               # 文件已不在时的改名失败文案（中英）
src-tauri/src/commands/mod.rs    # recent/favorites 原位路径替换
tests/                           # 菜单可用性、精确迁移、失败不迁状态
```

**Structure Decision**: 使用现有桌面应用结构。前端壳层拥有交互，Rust 命令层只增加配置记录迁移。不新增视图模块。

## Complexity Tracking

无违规，不填。

## Phase 0: Research

已完成，见 [research.md](research.md)。没有未解决的 NEEDS CLARIFICATION。

关键决定：复用 `promptRename` 与 `file_rename`；标签改名按精确路径迁移；扩展名变化用快速识别更新路由；最近与收藏原位替换。

## Phase 1: Design

- 实体与迁移规则：[data-model.md](data-model.md)
- 菜单、输入、错误哨兵与持久化契约：[contracts/tab-rename.md](contracts/tab-rename.md)
- 手工与回归验证：[quickstart.md](quickstart.md)

## Implementation Notes

1. `tabMenu` 在复制路径之前加入重命名，仅 `isRealFilePath`。伪标签即使带有比较双方的真实路径，也不从标签改其中一方。
2. 把「磁盘成功后的迁移」从目录前缀循环里分出单文件精确路径。文件树重命名目录时仍迁移该目录下已打开文件。
3. 活动 `EditView` / `LivePreviewView` 继续经 `relocate` 串行化保存与改名。其他活动视图不先销毁；路由不变则原位改路径，路由变化才重挂。
4. `paths_rename_records` 与 recent/favorites 共用持久化锁，只替换完全相等的规范化路径。
5. NotFound 使用明确的「文件已不在」文案。EXISTS 继续用「同名项已存在」。
