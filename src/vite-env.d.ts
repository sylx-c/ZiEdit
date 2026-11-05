/// <reference types="vite/client" />

/** 应用版本号（vite define 注入，来源 src-tauri/tauri.conf.json；Tauri 运行时优先 getVersion） */
declare const __APP_VERSION__: string;
/** 构建时 git 短 SHA（工作树有改动带 -dirty；非 git 环境为 unknown） */
declare const __GIT_SHA__: string;
/** 构建日期 YYYY-MM-DD */
declare const __BUILD_DATE__: string;
/** 构建渠道：release 正式版 / dev 开发版（环境变量 ZIEDIT_CHANNEL 决定） */
declare const __BUILD_CHANNEL__: 'release' | 'dev';
