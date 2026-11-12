# 批6 工程化收口：dependabot / CI audit / tests 类型检查（收口卡）

状态：B1/B2/B3 已实施；B3 结论「暂缓纳入 CI」。执行者：batch6-engineer，2026-11-12。

## 范围与纪律

写范围仅限 `.github/dependabot.yml`、`.github/workflows/ci.yml`、`tsconfig.test.json`、`package.json`（仅 scripts 新增）、本卡与 `docs/tmp/phase-b/` 日志。未改 `src/`、`src-tauri/`、`tests/`；未 git commit/push；未跑 tests/gates/ 原生门禁。实际结果：`package.json` 零改动（理由见 B3），其余四项落地。

## B1 Dependabot（.github/dependabot.yml，新增 12 行）

三生态最小配置：npm（`/`）、cargo（`/src-tauri`）、github-actions（`/`），均 `schedule.interval: weekly`。语法按 [GitHub 官方 options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)（github/docs main 分支核实）：必填键为顶层 `version`（恒为 `2`）+ `updates[].package-ecosystem / directory / schedule.interval`；未设 reviewers/labels/limit 等可选项。不引入任何运行时依赖。

## B2 CI 安全审计（ci.yml:70-92，新增独立 audit job）

### 摸底结果（真实漏洞，日志在 docs/tmp/phase-b/）

本地默认 registry 为 npmmirror，其 audit 端点未实现（`[NOT_IMPLEMENTED] /-/npm/v1/security/*`，见 `npm-audit-local-registry.log`），故摸底用 `--registry=https://registry.npmjs.org` 覆盖重跑；GitHub runner 默认官方 registry，CI 不受镜像限制。

`npm audit`（全依赖）与 `npm audit --omit=dev`（仅生产）结果一致（`npm-audit.log` / `npm-audit-omit-dev.log`）：

- **1 条 high：markdown-it 15.0.0–15.0.2**（本地实装 15.0.2，见 `node_modules/markdown-it/package.json`），属 `dependencies`（package.json:27）→ **非 dev-only，随发行物分发**。两条 advisory（OSV 核实）：
  - [GHSA-gfr2-rv44-r23c](https://api.osv.dev/v1/vulns/GHSA-gfr2-rv44-r23c)（CVE-2026-111758，HIGH，npm 汇总级别来源）：多行链接引用定义二次时间渲染，**默认选项即可触发**。本项目全仓库 markdown-it 实例均为 `html:false`（src/markdown-view/md.ts:29、headings-worker.ts:9、document-worker.ts:7 默认），本条仍可触发：用户打开恶意构造的 .md，预览异常回退路径或大纲 worker 渲染时主线程卡顿（离线应用无网络攻击面，但外部来源文件是真实场景）。
  - [GHSA-vfgh-jcmw-g37q](https://api.osv.dev/v1/vulns/GHSA-vfgh-jcmw-g37q)（CVE-2026-111766，LOW）：inline HTML 二次时间 DoS，需 `html: true`，**本项目无此配置，不触发**。
- 修复版均为 15.0.3（14.x 线为 14.3.3），在 `^15.0.2` 声明范围内，`npm audit fix` 即可修——但更新 package-lock 与运行时依赖超出本批写范围，**未处理，归 Lead**。升级后需按 AGENTS.md 跑 `npm run license:check` 与 `license:dist`。
- cargo audit：本地未装（`cargo audit --version` → no such command）；本仓库 Cargo.lock 为 `version = 4` 新格式。

### CI 方案与取舍（ci.yml）

新增独立 `audit` job（ubuntu 单机），不动既有 job 与 `build.needs: [frontend, rust, licenses]`——审计与构建并行，最小侵入；是否设为必需检查由分支保护决定（仓库设置，不在文件内）。

- **npm audit**：`npm audit --audit-level=high`（无需 npm ci，只读 lockfile）。high 及以上失败；low/moderate 放行，避免离线桌面应用被低级别噪声长期打红。**已知状态：markdown-it 这条 high 在升级前该步骤如实失败**——未用 continue-on-error/ignore 硬压（口径：上游已修，正确出路是升级而非压红）。
- **cargo audit**：`cargo install cargo-audit --locked` + `cargo audit --file src-tauri/Cargo.lock`，放弃 rustsec/audit-check@v2.0.0 action。代价评估：
  - audit-check（MIT，已核实）：免编译较快，但镜像内 cargo-audit 版本固定（v2.0.0 为多年前发布），对本仓库 Cargo.lock v4 的解析兼容存疑；且 fork PR 上 Checks API 失败只能退化为 stdout 输出。
  - cargo install --locked：每次取最新发布版，对 lockfile v4 兼容好、行为与本地一致；代价是每次编译数分钟（单 ubuntu job，无 rust-cache 可复用价值）。
  - 未引入新第三方 action（dtolnay/rust-toolchain 为既有引用）；cargo-audit 仅存在于 CI 环境，不进仓库、不进发行物（RustSec 官方，MIT/Apache-2.0）。
- cargo audit 失败口径：存在漏洞 advisory 即失败；unmaintained 等 warning 不失败（Tauri 生态 unmaintained crate 噪声大，清零不在本批范围，如需收紧可加 `--deny warnings`）。

## B3 tests 类型检查（tsconfig.test.json，新增 8 行，评估用途）

核实：tsconfig.json:22 `"include": ["src"]`，tests/ 从未被 tsc 检查（vitest 运行时不查类型）。新建 tsconfig.test.json（extends + include `["src","tests"]`），两轮实测：

| 轮次 | 配置 | 错误条数 | 涉及文件 | 日志 |
|---|---|---|---|---|
| 1 | 仅 extends + include | 148 | 54 | tsc-tests.initial.log |
| 2 | 补 `lib: ["ES2022","DOM"]` | 138 | 47 | tsc-tests.log |

第 2 轮消除的 10 条全部是 TS2550（`Array.prototype.at`，ES2020 lib 太旧——测试实际跑在 Node 24/Chromium，提升合理）。138 条分布（按错误码）：TS2591=57、TS2304=30（合计 87 条为 Node 类型缺失：node:fs/node:path/node:url/node:vm/__dirname/process，需引入 `@types/node`）；TS2339=12、TS2341=11（私有成员访问 tableTab/host、getMode 等）、TS6133=6（未用变量）、TS18047=5、TS2322/2345 各 5、TS2551=4、TS2493/2349/7016 各 1。**src/ 0 条，全部在 tests/**。

**决定：暂缓纳入。** 未加 `typecheck:test` script、`package.json` 零改动。理由：清零需 ① 新 devDependency `@types/node`（87 条，超出本批「仅 scripts 新增」写范围，且 vite.config.ts 现状即以 @ts-expect-error 规避 Node 类型）＋ ② 修改约 20 个 tests/ 文件的私有成员访问/形状不匹配（51 条，tests/ 归 Lead）；强行清零会动测试语义或大面积改测试。tsconfig.test.json 保留评估用途，后续如纳入：装 @types/node → Lead 批量修 tests/ → 加 script。

## 决策

- audit job 不进 build 依赖链：审计结果不阻塞安装包构建，是否必需检查由仓库分支保护设置决定。
- npm audit 阈值 high（非默认 low）：离线桌面应用的 low/moderate 噪声收益比不划算；当前唯一 high 如实失败，修法是升级 markdown-it ≥15.0.3（范围内 `npm audit fix`）。
- cargo audit 用 cargo install 而非 action：lockfile v4 兼容优先于 CI 时长。

## 验证

- 改动单元后 `npx tsc --noEmit` 三次（B1 后、B2 后、终检）：均 0 错误（src 口径）。
- `npm run license:check`：exit 0，`unresolved: []`、`releaseAllowed: true`（license-check.log）。本批未引入第三方 action/依赖，属预期基线确认。
- 日志留档：docs/tmp/phase-b/（npm-audit.log、npm-audit-omit-dev.log、npm-audit-local-registry.log、tsc-tests.initial.log、tsc-tests.log、license-check.log）。
- 未验证：ci.yml 的 audit job 未实际在 GitHub Actions 跑过（需 push 后观察）；dependabot 配置生效需仓库 Settings 确认（公共仓库默认可用）。

## 后续处置（Lead，2026-11-12）

- markdown-it 15.0.2→15.0.3 升级已由 Lead 执行（`npm update markdown-it`，package-lock.json 9 行变更、package.json 未动，argparse 随动 3.0.2→3.0.4；两者 LICENSE 原文哈希不变：`9cf0095570`/`eb17fba428`）。
- `public/third-party-licenses/` 已再生成（`node scripts/generate-third-party-licenses.mjs`），`--check --strict` 复验 exit 0（1373 份文档、0 issue）；完整 `npm run license:check` 复跑 **releaseAllowed: true、unresolved: []**（`docs/tmp/phase-a/license-check-final.log`）。
- 官方 registry 复验 `npm audit --audit-level=high`：**found 0 vulnerabilities**（exit 0）——CI audit 步骤升级后预期绿，留 CI 首跑确认。
- B3 暂缓决定维持：tsconfig.test.json 保留评估用途；138 条历史类型错误未清零（87 条需 @types/node、51 条需改 tests/，见上），不强行纳入。

## 后续处置续（Lead，2026-11-12 晚）

- CI 首跑（e00ee82 标签流水线）证实 audit job 按口径如实红：**cargo audit 报 quick-xml 0.37.5 RUSTSEC-2026-0194（HIGH 7.5，起始标签重复属性平方级解析，修复 ≥0.41.0）**。已升级直接依赖 0.37→0.42（与 lock 内其他 crate 既有 0.41/0.42 收敛为同版），并迁移 API：`local_name().as_ref()` 改 str 比较、`unescape` 改自由函数、属性取值 `normalized_value(Implicit1_0)`；**0.42 起 Reader 把实体引用拆成独立 `GeneralRef` 事件**，ooxml 三处文本回调显式解码（命名实体/数字引用，未定义实体有界报错）——cargo test 161/161（含 `A&amp;B`、`shared & text` 实体语义用例）、clippy -D warnings 0、fmt 通过。
- 同轮 CI 的 macOS 前端门失败为表格窗口断言的慢机竞态（首帧 109 行 <160 阈值未分窗；同提交重跑即绿、本地 40 连跑 0 失败）：`ac-007-writing` 就绪条件补「等全表 220 行扩展完成」，断言本身不变。
