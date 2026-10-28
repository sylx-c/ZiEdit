# 贡献指南

感谢关注 ZiEdit。本文说明如何在本地跑起来、提交前需要过哪些门禁。

## 环境要求

- Node.js ≥ 20 + npm
- Rust stable（rustup）
- Linux：`sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
- macOS：Xcode Command Line Tools
- Windows：WebView2 运行时（一般系统自带）

## 本地运行

```bash
npm ci
npm run tauri dev
```

## 提交前自查（与 CI 门禁一致）

CI（`.github/workflows/ci.yml`）在每次 PR 与 `main` push 上运行，请在本地先跑：

```bash
npx tsc --noEmit                                                        # 类型检查
npm test                                                                # 前端测试（vitest）
cargo test --manifest-path src-tauri/Cargo.toml                         # Rust 测试
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

任一项未过，CI 会拒绝；请修到全绿再提交。

## 测试组织

- `tests/`：vitest 用例，按验收编号组织（`ac-0XX-*.test.ts`，如 ac-007 为 Markdown/IR 组）；共享 harness 见 `tests/shell-behavior-harness.ts`
- `src/**/*.test.ts`：模块内单测
- `tests/gates/`：原生性能门禁（Windows，需先 `node tests/gates/prepare-gate-build.mjs` 构建被测 exe，再 `node tests/gates/run-all.mjs`）——涉及渲染/滚动性能的改动请跑对应门禁

## 约定

- 行为变化请同步更新 `docs/CHANGELOG.md`（未发布节）
- `public/renderers/` 是本地 vendored 第三方资产，不要手改其中文件；升级流程保持 `public/renderers/manifest.json` 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 同步
- 换行符统一 LF（`.gitattributes` 已固定）
- 提交信息用简体中文或英文均可，一行说清「改了什么、为什么」

## 行为准则

保持友善与对事不对人；不收录人身攻击、骚扰或与项目无关的推销内容。发现问题请通过 issue 反馈。

## 报告问题

- 缺陷请用缺陷模板（含系统、版本、复现步骤）
- 功能建议请先在需求模板中描述场景，再谈方案
- 安全漏洞请勿公开讨论，见 [SECURITY.md](SECURITY.md)
