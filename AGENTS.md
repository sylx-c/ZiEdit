# AGENTS.md — ZiEdit 工作区说明

给 AI 代理与协作者的入口：先读本文，再按地图按需加载，不整包读入。

## 1. 项目说明

ZiEdit 是跨平台（Windows / macOS / Linux）、离线优先的桌面文件查看与编辑工具。Tauri 2 + Rust 后端 + TypeScript / CodeMirror 6 前端。核心场景：大文本与代码查看编辑、Markdown 写作预览、CSV / 图片 / Office 文档查看、双文件对比。

- 前端：`src/`（`shell/` 总装配与工作台、各 `*-view/` 视图模块、`common/` 基础设施与 i18n）。
- 后端：`src-tauri/src/`（`commands/` IPC 层、`file_engine/` 分块读取、`encoding/` 编码探测、`ooxml/` 有界提取、`compare/` 差异引擎、`kind_detect/` 文件路由）。
- 本地第三方资产：`public/renderers/`（MathJax、Mermaid、highlight.js、数学字体，均为 vendored，版本与许可清单见 `public/renderers/manifest.json`）、`public/fonts/`（JetBrains Mono）。
- 测试：`tests/`（vitest，按验收编号 ac-0XX 组织）与 `tests/gates/`（原生性能门禁，Windows）。

工程版本 1.0.1；公开发布状态以发布记录为准。CI 监听 `master` 分支的 push 与全部 PR（`.github/workflows/ci.yml`）。

## 2. 常用命令

| 场景 | 命令 |
|---|---|
| 安装依赖 | `npm ci` |
| 前端开发（仅 WebView） | `npm run dev` |
| 桌面应用开发 | `npm run tauri dev` |
| 前端构建 | `npm run build`（tsc + vite build） |
| 打安装包 | `npm run tauri build`（正式渠道需环境变量 `ZIEDIT_CHANNEL=release`） |
| 桌面构建警示 | 勿直接用 `cargo build --release` 构建桌面 exe，须走 `npm run tauri build` / `npm run tauri dev`[^desktop-build] |
| 前端测试 | `npm test`（vitest run） |
| 类型检查 | `npx tsc --noEmit` |
| Rust 测试 | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Rust lint | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` |
| Rust 格式 | `cargo fmt --manifest-path src-tauri/Cargo.toml --check` |
| 性能门禁 | 先 `node tests/gates/prepare-gate-build.mjs --build`，再 `node tests/gates/run-all.mjs`（仅 Windows） |

[^desktop-build]: 直接 `cargo build --release` 缺少 `custom-asset` 特性，初始导航被拦且资产未嵌入，启动为白屏。

无前端 ESLint/Prettier 配置（截至 2026-10 的事实）。文档体检用 polaris skill 的 `scripts/check.py --root .`（本地工具，路径随安装位置）。

## 3. 文档地图

需求入口：[PRD](docs/PRD.md)

| 文件 | 用途 |
|---|---|
| [README](README.md) | 对外入口：是什么、怎么装、怎么跑 |
| [CHANGELOG](docs/CHANGELOG.md) | 面向使用者的变化流水（常设「未发布」节） |
| `docs/changes/` | 活跃任务草稿与收口卡 |
| [CONTRIBUTING](CONTRIBUTING.md) | 贡献指南与提交前门禁清单 |
| [SECURITY](SECURITY.md) | 安全策略与漏洞报告方式 |
| [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md) | 随应用分发的第三方许可声明 |
| `LICENSE` | 本项目许可证（MIT） |

工程根文件约定（不放 docs/）：`index.html` = Vite 入口 HTML；`tsconfig.json` / `vite.config.ts` = 前端工程与分包配置；根级 `.md` 均为仓库级契约（贡献 / 安全 / 许可 / 第三方声明），正式项目文档一律在 `docs/`。

## 4. 免费开源与版权规则（开发时即执行）

- 写代码、添加依赖、复制代码片段或引入字体、图标、图片、Emoji 数据、示例文档、网站素材前，先核实来源与适用许可。仅使用自有且权属明确的内容，或允许本项目用途及再分发的免费开源/开放授权内容；不得引入付费未授权、禁止商用、禁止再分发或来源不明的内容。没有许可证不能默认可以使用，搜索结果、AI 生成或“免费可下载”也不能代替权属证据。
- 审查固定版本、提交或原始归档，记录官方来源、版本、文件散列、完整版权与许可原文，以及本地修改。代码许可不能代替字体字形、图像、内嵌组件或数据各自的许可；双许可 OR 与同时履行 AND 必须区分。不得凭相似图形推定原创、使用通用许可模板覆盖原版权，或用最新版许可替代实际版本。
- 引入时同步满足署名、NOTICE、修改声明、对应源码/构建材料、源码获取方式、字体保留名等义务；更新 `THIRD-PARTY-NOTICES.md`、相关资产清单及逐包证据。保留既有合法功能；来源不能证明时先寻找许可清楚的等价替代，不能悄悄删功能或改变用户已定稿的布局。
- 检查实际打包内容，覆盖传递/内嵌依赖、vendored 文件、原生库、各目标平台可选包及官网素材。开发依赖或未分发项须有范围证据，不能直接忽略。安装包必须实际包含可读的许可原文与 NOTICE；对应源码与审计证据不实体入包，统一发布在公开仓库 `compliance/` 固定路径，并在随包的 `third-party-licenses/SOURCE-OFFERS.txt` 中提供获取指引（2026-11-06 定稿）。旧发布包不因源码修复而自动合规。
- 依赖或素材变化后运行对应来源/许可门禁，提交前至少执行 `npm run license:check`（汇总字体、逐包许可、vendored 内嵌、素材来源与对应源码门禁），构建后执行 `npm run license:dist` 核对实际前端分发材料。单项命令包括 `node scripts/verify-font-licenses.mjs` 和 `node scripts/generate-third-party-licenses.mjs --check --strict`。未决项必须明确保留并报告，不得删除待审记录、跳过失败或把收集成功写成合规放行；构建/测试通过也不等于版权审查通过。
- 新增内容证据不齐不得进入发行物。最终审查只能陈述已验证的范围与义务完成情况，不承诺绝对无侵权风险；商标、专利和存在争议的权属另行核查。提交、推送和发布仍须用户授权。

## 5. Release 说明固定版式（每次发布都这样写）

Release 标题就是「ZiEdit <版本号>」（如「ZiEdit 1.0.0」），不加副词修饰；正文**不重复标题行**，直接从一句话简介开始。其余固定结构：

1. **一句话简介**：产品定位 + 核心格式 + 本地离线/无账号特征。
2. **下载**：平台 × 文件名 × SHA-256 表格（每个附件一行；哈希取自实际上传资产的 digest，不抄本地构建值）。
3. **测试状态**：双语标注「仅 Windows 经实机测试；macOS/Linux CI 构建、未经实机验证」——如实反映当轮验证范围，平台覆盖变化时同步改写。
4. **构建说明**：同源提交链接与标签、本地验证构建/CI 构建的分工、逐平台清单文件（`build-manifest.json`）指引。
5. **本版亮点**：3–5 组能力要点，面向使用者，不写内部实现细节。
6. **验证**：门禁与溯源声明（许可门禁未决数、安装包解包核验、发布验收清单及其当前状态）+ 指向 CHANGELOG 链接。验收未全部完成前，文字必须如实写明「全部通过后方转公开」之类的门槛状态。

CI 自动生成的「Full Changelog」正文一律替换为上述版式；写好的 notes 存 `docs/tmp/release-<版本>/notes.md` 留档。

## 6. 三原则引用

入口精简，详情按需 / 事实归位，再做收口 / 一事一处权威，文件恢复现场。（出处：polaris skill `SKILL.md`；提交与推送永远等用户授权。）
