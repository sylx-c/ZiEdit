// @vitest-environment jsdom
// 001 界面语言真相源回归锁（P3-30，ARCHITECTURE「单一判决」）：
// 修前两处存储可各自漂移——settings.json 的 language（设置面板写入）与 localStorage 的
// ziedit-lang（setLang 写入）谁生效全看启动顺序：initI18n 在 main.ts 跑（读 localStorage），
// settingsLoad 是 IPC 晚到，于是「改了 settings.json 或迁移配置目录」后界面语言不跟随设置。
// 判决：settings.language 为唯一真相，localStorage 仅是启动早期的探测缓存，启动重同步回写。
import { describe, expect, it, beforeEach } from 'vitest';
import { detectLang, getLang, setLang, syncLangFromSettings, t } from '../src/common/i18n';

const STORE_KEY = 'ziedit-lang';

describe('001 AC：界面语言真相源（P3-30）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('detectLang 首选启动缓存（settingsLoad 之前的第一屏语言）', () => {
    localStorage.setItem(STORE_KEY, 'en-US');
    expect(detectLang()).toBe('en-US');
    localStorage.setItem(STORE_KEY, 'zh-CN');
    expect(detectLang()).toBe('zh-CN');
  });

  it('settings.language 与缓存不一致时以设置为准，并回写缓存', () => {
    setLang('zh-CN');
    expect(syncLangFromSettings('en-US')).toBe(true); // 已切换：调用方须重建界面文案
    expect(getLang()).toBe('en-US');
    expect(localStorage.getItem(STORE_KEY)).toBe('en-US'); // 缓存被回写，下次首屏即为设置值
    expect(t('common.langEn')).toBeTruthy();
  });

  it('与当前一致/未设置/非法值 → 不切换（保持系统探测结果，不误伤）', () => {
    setLang('zh-CN');
    expect(syncLangFromSettings('zh-CN')).toBe(false);
    expect(syncLangFromSettings(undefined)).toBe(false);
    expect(syncLangFromSettings('fr-FR')).toBe(false);
    expect(getLang()).toBe('zh-CN');
  });

  it('切换到设置值后，再次同步为幂等（启动路径可重复调用）', () => {
    setLang('zh-CN');
    expect(syncLangFromSettings('en-US')).toBe(true);
    expect(syncLangFromSettings('en-US')).toBe(false);
    expect(getLang()).toBe('en-US');
  });
});
