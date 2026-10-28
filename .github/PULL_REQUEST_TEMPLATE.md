# Pull Request

## 改动说明

<!-- 做了什么、为什么；关联 issue 请写 Fixes #N -->

## 自查清单

- [ ] `npx tsc --noEmit` 通过
- [ ] `npm test` 通过
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 通过
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` 通过
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --check` 通过
- [ ] 行为变化已同步 `docs/CHANGELOG.md`（未发布节）
- [ ] 不包含 `public/renderers/` 内第三方文件的手工改动

## 验证方式

<!-- 怎么验证的：新增/修改的测试、手动验证步骤、性能门禁结果（涉及渲染性能时） -->
