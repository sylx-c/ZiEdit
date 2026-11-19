# ZiEdit Constitution

ZiEdit 项目级工程规范，对所有功能开发、重构与协作参与者（人类协作者及 DSH / Codex / Claude Code / OpenCode 等 AI Agent）一体适用。本文件只承载跨功能的工程原则：产品需求与既定技术决策的权威记录由所有者在本地维护（不入公开仓库），具体 Feature 的规格、计划与任务属于 `.specify/features/`，均不在此复制。每项原则附公开仓库内可核验的「依据锚点」；无锚点、仅凭偏好的约束不得进入本文件。

## Core Principles

### I. 技术栈稳定（Verified Stack First）
ZiEdit 的既定技术栈为 Tauri 2 + Rust（edition 2024）+ TypeScript + CodeMirror 6，前端 Vite / Vitest，渲染器（MathJax、Mermaid、highlight.js、数学字体）vendored 本地加载。核心库（编辑器、Markdown 渲染器、Office 提取内核、PDF 渲染）的更换或大版本升级属于架构级变更：MUST 先获得所有者批准并登记决策，禁止在任何 Feature 中顺手替换。桌面产物 MUST 经 `npm run tauri build` / `npm run tauri dev` 构建（custom-asset 特性），禁止以 `cargo build --release` 直接产出桌面可执行文件。

依据锚点：`package.json`、`src-tauri/Cargo.toml`、`public/renderers/manifest.json`、`src-tauri/tauri.conf.json`、`scripts/build-verified.mjs`。

### II. 遵循已登记决策（Registered Decisions Prevail）
源码注释中登记的 ADR / 决策编号（决策 002/003/005，ADR 010/012/014/015/016 及后续登记项）是现行实现的组成部分，开发 MUST 遵循。新增技术决策或推翻既有决策 MUST 先经所有者确认并登记，再动代码；实现与登记决策冲突即视为缺陷。

依据锚点：`src-tauri/src/file_engine/mod.rs`（决策 002）、`src-tauri/src/encoding/mod.rs`（决策 003）、`src-tauri/src/store.rs`（决策 005）、`src-tauri/src/compare/mod.rs`（ADR 010）、`src-tauri/src/commands/recovery.rs`（ADR 012）、`src-tauri/src/paths.rs`（ADR 014）、`src-tauri/src/lib.rs`（ADR 015）、`src-tauri/src/commands/s3.rs`（ADR 016）。

### III. 模块边界与依赖规则（Module Boundaries）
- Rust 侧：`src-tauri/src/commands/` 是 IPC 薄层，MUST 只做参数校验与转发；业务逻辑 MUST 位于引擎模块（file_engine / encoding / compare / ooxml / kind_detect），引擎保持纯 Rust、不依赖 tauri 运行时、可独立单测。
- 前端侧：`src/shell/` 负责总装配（标签、会话、视图分发、菜单、状态栏）；视图能力住在各 `*-view/` 模块；跨视图公共能力 MUST 优先沉淀在 `src/common/`。视图之间复用既有基础设施组件（查找条、语法高亮、格式化命令等）时 MUST 保持文件级依赖单向，禁止新增循环依赖（现行文件级依赖无环）。
- 资源读取红线：任何路径 MUST NOT 将整个大文件读入内存（64KB 分块 + LRU 块缓存 + 行锚点）；一切提取与输出 MUST 携带显式上限哨兵，绝不静默截断。

依据锚点：`src-tauri/src/commands/mod.rs`、`src-tauri/Cargo.toml`（thiserror 契约注释）、`src/` 目录结构、`src/common/`、`src/markdown-view/` 复用 `src/text-view/`（findbar / highlight）与 `src/text-view/edit.ts` 复用 `src/markdown-view/mdformat` 的既有单向引用。

### IV. 接口契约与兼容性（API & Compatibility）
- IPC 命令的参数、返回结构与错误哨兵字符串是前后端契约（错误在 command 边界序列化为可读字符串，前端按展示 / contains 判别）。修改契约 MUST 同步更新 `src/common/ipc.ts` 封装，并保持既有调用方兼容或显式迁移。
- OS 配置目录分文件 JSON（settings / session / recent / favorites / 命名会话）是持久化契约：新增字段 MUST 提供安全默认值，MUST NOT 改变旧字段语义；读取侧保持损坏自愈。
- 渲染输入不变量：外部文本进入 Markdown 渲染前 MUST 归一为 LF（`src/common/text.ts` 的 `toLf`）；新增渲染入口同样遵守。
- 版本号 MUST 三处同步：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`。

依据锚点：`src-tauri/Cargo.toml` thiserror 注释、`src-tauri/src/store.rs`、`src/common/text.ts`、三处版本文件（当前 1.0.2）。

### V. 数据保护（Data Protection）
本项目无数据库；「迁移」指配置 JSON 的向后兼容演进与恢复目录约定的稳定。数据保护不可协商：
- 用户文件写入 MUST 原子化（临时文件 + rename）；写前滚动备份失败 MUST 可观测但不阻断保存（备份是保护不是前置）。
- 崩溃恢复快照与存活标记：Windows MUST 使用 DPAPI 用户级加密，Unix MUST 使用 0600/0700 权限；解密失败 MUST 保留磁盘原文件，MUST NOT 以空会话覆盖用户数据。
- 涉及用户数据的操作（保存、删除、覆盖、恢复）失败 MUST 显式上报，禁止静默吞掉或降级为部分完成。

依据锚点：`src-tauri/src/commands/misc.rs`（ADR 012 备份注释）、`src-tauri/src/commands/recovery.rs`、`src-tauri/src/store.rs`、`src-tauri/src/paths.rs`。

### VI. 质量门禁与测试（Quality Gates & Testing）
- 提交前 MUST 至少通过：`npm test`、`npx tsc --noEmit`、`cargo test`、`cargo clippy --all-targets -- -D warnings`、`cargo fmt --check`、`npm run license:check`；涉及分发材料时构建后 MUST 加 `npm run license:dist`。
- 既有测试（`tests/` 按验收编号组织）与原生门禁（`tests/gates/`）是行为基线：改动 MUST NOT 使既有测试变红；行为修正 MUST 附带回归测试。
- 风格工具链维持现状（无前端 ESLint / Prettier，由 tsc + 测试承担）；MUST NOT 擅自引入新的风格工具链。`tests/` 的类型检查维持暂缓（`tsconfig.test.json` 评估用途），不强行纳入。
- 性能敏感改动 MUST 跑对应原生门禁（Windows 60Hz 物理控制台环境），失败判别结论随汇报提交；禁止不加判别地重跑刷绿。

依据锚点：`package.json` scripts、`tests/`、`tests/gates/run-all.mjs`、`tsconfig.test.json`、`.github/workflows/ci.yml`。

### VII. 安全与许可红线（Security & License Red Lines）
- 零网络红线：除既有 S3 图床两条命令（`s3_put_object` / `s3_get_image`）外 MUST NOT 新增任何出网能力；HTTP 客户端保持禁重定向、禁代理、仅访问用户配置地址。
- 主窗编程创建 + 导航白名单 MUST 保持；外链一律交系统浏览器。路径边界（设备路径拒绝、zasset 运行期动态放行、单文件 256MB 上限）MUST NOT 放宽。
- 许可合规是硬门禁：新增任何依赖、字体、图标、图片、数据前 MUST 核实来源与许可；固定版本、记录官方来源与散列，同步更新 `THIRD-PARTY-NOTICES.md` 与逐包证据；未决项如实保留，禁止跳过失败或把收集成功当作合规放行。vendored 渲染器不升级；确需升级 MUST 先重审许可。

依据锚点：`src-tauri/src/commands/s3.rs`（ADR 016）、`src-tauri/src/lib.rs`（导航拦截）、`src-tauri/src/zasset.rs`、`THIRD-PARTY-NOTICES.md`、`scripts/verify-license-compliance.mjs`、`public/third-party-licenses/`。

### VIII. 复用优先（Reuse over Rebuild）
新功能 MUST 优先复用既有基础设施：类型化 IPC 封装（`src/common/ipc.ts`）、双语 i18n、编辑缓冲与滚动锚定、共享 8ms 帧队列、用户意图滚动判定（`src/common/user-scroll.ts`）、LF 归一（`toLf`）、zasset 资产协议、JSON 持久化（store）、ActionRegistry 动作注册等。仅当复用确不满足需求时才新建平行机制，且 MUST 在 Feature 计划中说明理由。

依据锚点：`src/common/`（ipc / i18n / editor-buffer / scroll-anchor / render-queue / user-scroll / text）、`src-tauri/src/store.rs`、`src-tauri/src/zasset.rs`。

### IX. 变更节制（Refactor Restraint）
未经所有者批准 MUST NOT 进行大规模重构；重构类工作 MUST 独立立项、分阶段推进、每阶段独立可撤回并带门禁。已经验收的行为（交互、键盘、渲染口径）默认保持：改动 MUST 有明确需求或缺陷依据，并在计划中显式列出回归面。

依据锚点：`docs/CHANGELOG.md`（批次化推进 + 逐批验收记录的演进实践）、git 提交历史。

### X. Agent 无关的仓库规范（Agent-Agnostic）
本 Constitution 与工程工件（`.specify/`、`.dsh/` 技能清单、脚本）以工具无关的方式表述与存放；任何 Agent 与人类协作者按同一规范工作，Agent 特有机制只作便利层，MUST NOT 成为规范的唯一载体。协作卫生对所有参与者一致：提交信息 MUST NOT 包含本地资料路径与内部术语；本地工作资料（需求、规划、过程文档）MUST NOT 进入公开仓库。

依据锚点：`.specify/`（模板与 PowerShell 脚本，平台选择见 `init-options.json`）、`.dsh/skills/`、`.gitignore`（本地资料忽略条目）。

## 工程硬约束速查（Hard Constraints Quick Reference）

| # | 约束 | 锚点 |
|---|---|---|
| 1 | 桌面构建只走 `npm run tauri build` / `tauri dev` | `scripts/build-verified.mjs`、`src-tauri/tauri.conf.json` |
| 2 | 除 S3 两命令外零出网；禁重定向禁代理 | `src-tauri/src/commands/s3.rs` |
| 3 | 大文件分块读取，整文件不驻留内存 | `src-tauri/src/file_engine/mod.rs` |
| 4 | 提取/输出显式哨兵，绝不静默截断 | `src-tauri/src/ooxml/mod.rs` |
| 5 | Markdown 渲染输入先归一 LF | `src/common/text.ts` |
| 6 | 原子写 + 可观测备份 + DPAPI/0600 快照 | `src-tauri/src/store.rs`、`src-tauri/src/commands/recovery.rs` |
| 7 | 新增依赖/素材先过许可审查与门禁 | `THIRD-PARTY-NOTICES.md`、`package.json` license 脚本 |
| 8 | 提交/推送/发布须所有者授权 | Governance、发布工作流实践 |

## 开发工作流（Development Workflow）

- 分支策略：功能开发在 `feat/<slug>` 分支进行，从干净的 `master` 切出；合回前过全部提交前门禁（2026-11-19 所有者确认）。
- 规格驱动：Feature 依 `.specify/` 流程推进（specify → clarify（可选）→ plan → tasks → analyze（可选）→ implement）；Feature 工件（spec / plan / tasks）MUST NOT 与本 Constitution 冲突，出现冲突先修订本文件或提请所有者裁决。
- 提交、推送、发布永远等待所有者授权；发布（候选构建 → 验收 → 试用 → CI → 证据绑定 → 放行）遵循仓库既定发布工作流，细节由所有者维护的本地发布手册承载，本文件不复制。
- 需求对账：每个需求完成并验证后，收尾汇报时提醒所有者同步其本地维护的需求与架构资料，防止规格与实现漂移。

## Governance

- 效力顺序：所有者明示裁决 > 本 Constitution > Feature 工件 > 实现细节。
- 修订程序：任何修订以文档形式提出，注明动机与影响面，经所有者批准后生效；版本号按语义化规则递增（原则新增 / 实质扩展 = MINOR，措辞澄清 = PATCH，原则删除 / 重定义 = MAJOR），并同步批准 / 修订日期。
- 合规审查：每次 Feature 的 plan 与 code review 应对照本文件原则与硬约束表核验；无法追溯依据锚点的约束不具约束力，应提请修订或删除。

**Version**: 1.0.0 | **Ratified**: 2026-11-19 | **Last Amended**: 2026-11-19
