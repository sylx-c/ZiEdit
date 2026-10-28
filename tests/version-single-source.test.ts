// 版本单一来源（001 规则 30 关于对话框）：tauri.conf.json 为准，package.json 必须一致
// （__APP_VERSION__ 构建期取自 tauri.conf.json；发布前不一致会显示错误版本号）
import { describe, expect, it } from 'vitest';
import conf from '../src-tauri/tauri.conf.json';
import pkg from '../package.json';

describe('版本单一来源', () => {
  it('tauri.conf.json 与 package.json 版本一致', () => {
    expect(conf.version).toBe(pkg.version);
  });
  it('版本为语义化三段', () => {
    expect(conf.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('版本随发版台账升位（0.0.1 → 0.1.0）', () => {
    expect(conf.version).toBe('0.1.0');
  });
});
