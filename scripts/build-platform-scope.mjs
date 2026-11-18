// CI 构建平台作用域（2026-11-18 项目所有者决定：仓库瘦身）。
// 平台限定（os/cpu 受限）的 npm 可选原生包只为本仓库实际构建的平台保留固定归档证据；
// 其余平台变体（android/freebsd/openharmony/s390x/win32-arm64…）是开发工具链的可选
// 安装目标，本仓库不在其上构建、测试或分发，逐平台证据不再采集与发布。
// 这是「范围证据」决定（仓库版权规则 §4：开发依赖或未分发项须有范围证据），不是静默忽略：
// 生成器仍会把作用域外变体记入清单（OUT_OF_BUILD_PLATFORM_SCOPE），可追溯、可复查。
export const BUILD_PLATFORM_VARIANTS = Object.freeze(new Set([
  'win32-x64-msvc',   // CI windows-latest（Windows 安装包）
  'linux-x64-gnu',    // CI ubuntu-latest（AppImage/deb/rpm）
  'darwin-arm64',     // CI macos-latest（aarch64 dmg）
]));
const VARIANT_SUFFIX = /-(?:android|freebsd|openharmony|linux|darwin|win32|sunos|aix|haiku)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 仅对 lock 里 os/cpu 受限的包调用；判定其平台变体后缀是否属于 CI 构建作用域。 */
export function inBuildPlatformScope(packageName) {
  const match = packageName.match(VARIANT_SUFFIX);
  return !match || BUILD_PLATFORM_VARIANTS.has(match[0].slice(1));
}
export const BUILD_PLATFORM_SCOPE_NOTE = 'Platform variant outside the CI build scope (win32-x64-msvc / linux-x64-gnu / darwin-arm64): development-toolchain optional native package, not built, tested or distributed by this repository; archived per-platform license evidence is intentionally not collected (owner decision 2026-11-18, see scripts/build-platform-scope.mjs).';
