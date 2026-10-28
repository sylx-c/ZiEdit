import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { execSync } from "node:child_process";
import tauriConf from "./src-tauri/tauri.conf.json" with { type: "json" };
const host = process.env.TAURI_DEV_HOST;

/** 构建标识（001 规则 30 版本口径）：短 SHA 取自 git，非 git 环境回退 "unknown"；工作树有改动加 "-dirty" */
function gitSha(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim() !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

// https://vite.dev/config/
export default defineConfig(() => ({
  // 版本号单一来源 = tauri.conf.json（001 规则 30 关于对话框：Web 开发模式回退此构建期注入值）
  // 构建渠道：ZIEDIT_CHANNEL=release 为正式版，缺省为开发版（dev）
  define: {
    __APP_VERSION__: JSON.stringify(tauriConf.version),
    __GIT_SHA__: JSON.stringify(gitSha()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
    __BUILD_CHANNEL__: JSON.stringify(process.env.ZIEDIT_CHANNEL === "release" ? "release" : "dev"),
  },
  // 验收测试按子 PRD 的 AC 编号命名放 tests/
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    // 代码分割：把大体积第三方依赖拆为独立 chunk，避免单 chunk 超阈值警告、改善缓存与首屏
    // 注意：本项目 Vite 8 底层为 rolldown，manualChunks 须为函数形式
    // 解析器语言包由 highlight.ts / edit.ts 按需动态导入；不要把 lang-* 强行合并到
    // 常驻 codemirror chunk，否则任一种语言首次着色都会下载全部语法包。
    // @lezer 同理：common/lr/highlight 是编辑器核心依赖（随 codemirror chunk 常驻），
    // 其余 11 个是各语言的解析器数据（真正的大头），必须跟随 lang-* 的动态导入分块。
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/@codemirror/lang-')) return undefined;
          const lezer = /node_modules\/@lezer\/([^/]+)/.exec(id);
          if (lezer && !['common', 'lr', 'highlight'].includes(lezer[1]!)) return undefined;
          if (id.includes('node_modules/@codemirror') || id.includes('node_modules/@lezer')) {
            return 'codemirror';
          }
          return undefined;
        },
      },
    },
    // 恢复默认 500KB 告警阈值（此前 900 掩盖了 865KB 的大 chunk）——诚实告警，大块留给汇聚构建验证
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
