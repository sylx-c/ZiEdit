// 002-AC-21 v2.6 直接编辑面回归锁（UX-B 批，用户 2026-10-17：删「查看/编辑」双模式）：
// ≤10MB 文本（含磁盘只读）打开即编辑面；>10MB 流式查看面且无任何编辑入口；
// defaultOpenMode 废止；键入即编辑/Alt+C 进列/Ctrl+E/「进入编辑」右键项全删。
// 配套 007 v0.15：Markdown 三形态（'md' 独立渲染预览删除，mdDefaultMode 历史值 preview 迁移 source）。
// 纯函数侧行为锁在 src/common/mode.test.ts；本组锁 mode.ts 类型面与 app.ts 源码契约（入口不得回漂）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dict } from '../src/common/i18n';

const app = readFileSync(fileURLToPath(new URL('../src/shell/app.ts', import.meta.url)), 'utf8');
const mode = readFileSync(fileURLToPath(new URL('../src/common/mode.ts', import.meta.url)), 'utf8');

describe('002-AC-21 v2.6：删双模式（源码契约锁）', () => {
  it('ViewMode 包含独立预览 md，view 仍仅流式查看面', () => {
    const m = /export type ViewMode = ([^;]+);/.exec(mode);
    expect(m).toBeTruthy();
    expect(m![1].trim()).toBe("'view' | 'md' | 'edit' | 'split' | 'wysiwyg' | 'csv'");
  });

  it('editableFile 判决不再看只读位（磁盘只读照常进编辑面，E1003/另存为在保存侧兜底）', () => {
    const m = /export function editableFile[\s\S]{0,220}?\n\}/.exec(mode);
    expect(m).toBeTruthy();
    expect(m![0]).toMatch(/meta\.size <= EDIT_LIMIT/);
    expect(m![0]).not.toMatch(/readonly/);
  });

  it('ModeSettings 无 defaultOpenMode 字段（废止；mdDefaultMode 历史值 preview 读入迁移 source）', () => {
    const m = /export interface ModeSettings \{[\s\S]{0,200}?\}/.exec(mode);
    expect(m).toBeTruthy();
    expect(m![0]).not.toMatch(/defaultOpenMode\??\s*:/); // 注释里提及不算，字段不得复活
    // preview 迁移：defaultModeFor 出厂 ir；非 ir（source 与历史值 preview）一律按源码即编辑面走
    const d = /const pref = settings\.mdDefaultMode \?\? 'ir';/.exec(mode);
    expect(d).toBeTruthy();
  });

  it('app.ts 无任何「进入编辑」入口回漂（函数/动作/工具栏/文案键全删）', () => {
    expect(app).not.toMatch(/function enterEditMode/);
    expect(app).not.toMatch(/function toggleEditMode/);
    expect(app).not.toMatch(/view\.editToggle/); // 注册表动作 + TOOLBAR_SPEC + buildMenus 三处共用此 id
    expect(app).not.toMatch(/pendingTypeChar|pendingColumnMode|onTypeIntent|onEnterColumnMode|onRequestReplaceMode/);
    expect(app).not.toMatch(/ctx\.enterEdit|msg\.enteringEdit|msg\.enterEditTimeout/);
    expect(app).not.toMatch(/ro\.blocked|ro\.openHint/);
    expect(app).not.toMatch(/settings\.defaultOpenMode/); // 设置面板行已删，历史值读入即忽略
    expect(app).not.toMatch(/'Ctrl\+E'/); // 快捷键注册随动作删除
  });

  it('mdModeMenuItems 四形态含独立预览', () => {
    const m = /function mdModeMenuItems[\s\S]*?\n  \}/.exec(app);
    expect(m).toBeTruthy();
    expect(m![0]).toMatch(/act\.mdSource/);
    expect(m![0]).toMatch(/setMode\(tab, 'edit'\)/);
    expect(m![0]).toMatch(/act\.mdSplit/);
    expect(m![0]).toMatch(/act\.mdWysiwyg/);
    expect(m![0]).toMatch(/act\.mdPreview/);
    expect(m![0]).not.toMatch(/setMode\(tab, 'view'\)/); // 源码项不再回落查看态
  });

  it('流式查看面右键无编辑类/行批入口（textViewMenu 两口径）', () => {
    const m = /function textViewMenu[\s\S]{0,1600}?\n  \}/.exec(app);
    expect(m).toBeTruthy();
    expect(m![0]).not.toMatch(/enterEdit|lineBatch/);
  });

  it('i18n：恢复预览键，废止的双模式入口仍不复活', () => {
    for (const lang of ['zh-CN', 'en-US'] as const) {
      const d = dict(lang);
      expect(d['act.editToggle']).toBeUndefined();
      expect(d['act.mdPreview']).toBeTruthy();
      expect(d['ctx.enterEdit']).toBeUndefined();
      expect(d['set.openMode']).toBeUndefined();
      expect(d['set.mdPreview']).toBeUndefined();
      expect(d['st.quick.preview']).toBeUndefined();
      expect(d['tb.mdPreview']).toBeUndefined();
      // 保留：>10MB 流式提示与分屏超限提示仍在用
      expect(d['edit.tooLarge']).toBeTruthy();
      expect(d['msg.mdPreviewTooLarge']).toBeTruthy();
      expect(d['msg.mdIrTooLarge']).toBeTruthy();
    }
  });
});
