---
description: "Task list for tab context-menu rename"
---

# Tasks: 标签右键重命名

**Input**: Design documents from `/specs/002-tab-rename/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/tab-rename.md, quickstart.md

**Tests**: 规格 quickstart 要求回归覆盖。每个故事先写会失败的测试，再实现。

**Organization**: 按用户故事分阶段，故事可独立验收。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件，且不依赖未完成任务）
- **[Story]**: 所属用户故事（US1、US2、US3）
- 描述中给出准确文件路径

## Phase 1: Setup

**Purpose**: 确认现有改名入口与测试落点，不新建工程

- [X] T001 对照 `specs/002-tab-rename/contracts/tab-rename.md` 核对 `src/shell/app.ts` 的 `tabMenu` 与 `promptRename`，记下真实文件入口和目录前缀迁移的改动点
- [X] T002 [P] 对照 `src-tauri/src/commands/mod.rs` 的 `recent_add_tx` 与 `favorites_toggle_tx`，确认路径记录迁移将复用 `persistence_lock` 与 `store::save`

---

## Phase 2: Foundational

**Purpose**: 所有故事共用的精确路径替换。完成前不开始故事实现

**⚠️ CRITICAL**: 单文件改名不得复用目录前缀迁移

- [X] T003 在 `src/common/state.ts` 增加只替换完全相等路径的单文件改名，保留标签顺序、激活、滚动、书签和路由锁；按 `specs/002-tab-rename/data-model.md` 的「打开的文件标签.路径」执行，不迁移子路径
- [X] T004 在 `tests/ac-001-session.test.ts` 覆盖该精确替换：同前缀目录下的其他标签不变，标签身份字段保留

**Checkpoint**: 精确路径替换可单测，目录改名的既有前缀行为未被替换

---

## Phase 3: User Story 1 - 在打开的标签上直接改名 (Priority: P1) 🎯 MVP

**Goal**: 真实本地文件可从标签右键改名；成功后标签保持打开，未保存内容还在，界面显示新路径

**Independent Test**: 打开可写本地文件，右键标签重命名为合法新名称。原目录出现新文件，标签不关闭，未保存修改仍在，标题、状态栏和文件树显示新路径

### Tests for User Story 1

- [X] T005 [P] [US1] 在 `tests/ac-002-tab-rename.test.ts` 写失败测试：真实文件标签菜单含重命名，确认合法新名称后调用 `file_rename`，标签路径变为新路径且未保存脏标记仍在

### Implementation for User Story 1

- [X] T006 [US1] 在 `src/shell/app.ts` 的 `tabMenu` 为真实本地文件加入「重命名…」，调用现有 `promptRename`；菜单键与 Shift+F10 走同一菜单
- [X] T007 [US1] 在 `src/shell/app.ts` 把单文件成功迁移从目录前缀循环分开：只迁移 `specs/002-tab-rename/data-model.md` 的「打开的文件标签.路径」；活动 `EditView` 与 `LivePreviewView` 仍经 `relocate` 串行保存和改名
- [X] T008 [US1] 在 `src/shell/app.ts` 成功后按 `specs/002-tab-rename/data-model.md` 的「视图」原位更新路径，并刷新标签、窗口标题、状态栏与文件树；路由未变时不先销毁视图

**Checkpoint**: 用户故事 1 可独立演示。最近/收藏更新、失败文案细分和伪标签隐藏留在后续故事

---

## Phase 4: User Story 2 - 改名失败时工作不丢 (Priority: P2)

**Goal**: 非法名称、同名、文件不在、占用或权限失败时，文件与标签保持改名前状态

**Independent Test**: 对有未保存修改的已打开文件，分别提交同名、含斜杠的名称，以及一个不存在的源路径。每次结束后原标签路径不变，未保存内容仍在

### Tests for User Story 2

- [X] T009 [P] [US2] 在 `tests/ac-002-tab-rename.test.ts` 写失败测试：空名称、同名、含 `/` 或 `\` 不调用 `file_rename`；`EXISTS` 与 NotFound 不改变标签路径和脏标记

### Implementation for User Story 2

- [X] T010 [US2] 在 `src/shell/app.ts` 保持取消、空名称、同名和含分隔符时不调用改名；这些规则对应 `specs/002-tab-rename/data-model.md` 的「文件名.新名称」与「文件名.禁止」
- [X] T011 [P] [US2] 在 `src/common/i18n.ts` 补中英「文件已不在」改名失败文案，不改现有 `EXISTS` 文案
- [X] T012 [US2] 在 `src/shell/app.ts` 把 NotFound 映射到新文案，其他失败仍用「重命名失败」；仅磁盘成功后才迁移内存，对应 `specs/002-tab-rename/data-model.md` 的「状态迁移」

**Checkpoint**: 用户故事 1 和 2 都可独立验证。失败不会留下指向新路径的标签

---

## Phase 5: User Story 3 - 不能改名的标签不提供误导入口 (Priority: P3)

**Goal**: 伪标签没有重命名；图片、表格和文档预览可以改名；扩展名变化后按新类型展示；最近与收藏指向新路径

**Independent Test**: 草稿、对比、尾随台右键没有重命名。图片或表格标签可以改名并保持打开。改扩展名后按新类型展示且不另存。收藏和最近列表原位变为新路径且无重复

### Tests for User Story 3

- [X] T013 [P] [US3] 在 `tests/ac-002-tab-rename.test.ts` 写失败测试：`draft://`、`compare://`、`tail://` 菜单无重命名；图片或表格路由可重命名；扩展名变化更新路由但保留 `routeLocked`
- [X] T014 [P] [US3] 在 `src-tauri/src/commands/mod.rs` 的现有命令测试中写失败测试：路径记录原位替换完全相等项，新路径已存在时不产生重复，子路径不被替换

### Implementation for User Story 3

- [X] T015 [P] [US3] 在 `src-tauri/src/commands/mod.rs` 实现 `paths_rename_records`，在 `persistence_lock` 内原位更新 `recent.json` 与 `favorites.json`；只替换 `specs/002-tab-rename/data-model.md` 的「路径记录.匹配」，并遵守「路径记录.重复」与「路径记录.顺序」
- [X] T016 [P] [US3] 在 `src-tauri/src/lib.rs` 注册 `paths_rename_records`，并在 `src/common/ipc.ts` 增加类型化封装
- [X] T017 [US3] 在 `src/shell/app.ts` 用快速扩展名识别更新 `specs/002-tab-rename/data-model.md` 的「打开的文件标签.路由 / 语言」；路由变化才销毁并重挂，用户锁定路由不覆盖
- [X] T018 [US3] 在 `src/shell/app.ts` 于磁盘改名成功后调用路径记录迁移并刷新侧栏；配置写失败只警告，对应 `specs/002-tab-rename/data-model.md` 的「路径记录.失败」

**Checkpoint**: 三个故事都可独立验证

---

## Phase 6: Polish

**Purpose**: 跨故事核对与门禁

- [X] T019 [P] 按 `specs/002-tab-rename/quickstart.md` 核对主路径、拒绝、伪标签、扩展名和最近/收藏场景
- [X] T020 运行 `npm test` 与 `npx tsc --noEmit`；Rust 改动另运行 `cargo test --manifest-path src-tauri/Cargo.toml`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖
- **Foundational (Phase 2)**: 依赖 Setup，阻塞所有故事
- **User Stories (Phase 3+)**: 都依赖 Foundational
- **Polish**: 依赖所选故事完成

### User Story Dependencies

- **User Story 1 (P1)**: Foundational 后即可开始，不依赖其他故事
- **User Story 2 (P2)**: Foundational 后即可开始。它收紧同一 `promptRename` 的失败路径，建议在 US1 迁移落地后集成
- **User Story 3 (P3)**: Foundational 后即可开始。菜单隐藏可与 US1 并行；扩展名重挂和记录迁移依赖 US1 的成功迁移点

### Within Each User Story

- 先写该故事的失败测试
- 精确路径模型先于壳层迁移
- 磁盘成功先于内存迁移和配置迁移
- 完成当前故事后再进入下一优先级

### Parallel Opportunities

- T001 与 T002 可并行
- T005、T009、T013、T014 在各自前置完成后可并行写测试
- T011 与 T010 可并行
- T015 与 T016 可并行；T017 依赖 US1 迁移点，不与 T007 并行

---

## Parallel Example: User Story 3

```bash
# 两个测试文件可同时写：
Task: "在 tests/ac-002-tab-rename.test.ts 覆盖伪标签与扩展名路由"
Task: "在 src-tauri/src/commands/mod.rs 覆盖 recent/favorites 原位替换"

# 后端命令与前端封装可同时改：
Task: "在 src-tauri/src/commands/mod.rs 实现 paths_rename_records"
Task: "在 src/common/ipc.ts 增加类型化封装，并在 src-tauri/src/lib.rs 注册"
```

---

## Implementation Strategy

### MVP First

1. 完成 Phase 1 和 Phase 2
2. 完成 Phase 3 的用户故事 1
3. 停止并按独立测试验收：标签右键可改名，内容不丢
4. 再做失败保护与伪标签/记录迁移

### Incremental Delivery

1. Setup + Foundational → 精确替换可用
2. User Story 1 → 主路径可演示
3. User Story 2 → 失败不丢工作
4. User Story 3 → 入口边界、扩展名和路径记录完整
5. Polish → 跑 quickstart 与门禁

---

## Notes

- 不新增第三方依赖，不新增风格工具链
- 目录改名继续使用现有前缀迁移；只有标签上的单文件改名使用精确替换
- 配置记录写失败不回滚已经成功的磁盘改名
- 提交仍等待所有者授权
