import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, type Settings } from '../src/common/ipc';

const app = readFileSync(new URL('../src/shell/app.ts', import.meta.url), 'utf8');

describe('快照目录设置', () => {
  it('默认不覆盖目录，允许持久化自定义路径', () => {
    expect(DEFAULT_SETTINGS).not.toHaveProperty('snapshotDir');
    const settings: Settings = { ...DEFAULT_SETTINGS, snapshotDir: 'E:\\snapshots' };
    expect(JSON.parse(JSON.stringify(settings)).snapshotDir).toBe('E:\\snapshots');
  });

  it('备份卡包含目录选择、恢复默认与保存接线，Web 下安全跳过选择器', () => {
    expect(app).toContain("rowTarget, rowSnapDir, rowCloseAutoSave");
    expect(app).toContain("$t('set.snapDir')");
    expect(app).toContain("$t('set.snapDirBrowse')");
    expect(app).toContain("$t('set.snapDirDefault')");
    expect(app).toContain("if (!('__TAURI_INTERNALS__' in window)) return;");
    expect(app).toContain('openDialog({ directory: true, multiple: false, defaultPath: snapshotDir || undefined })');
    expect(app).toContain('snapshotDir: snapshotDir || undefined');
  });
});
