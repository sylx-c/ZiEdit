// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { startShell } from './shell-behavior-harness';
import { settingsLoad, traySetLanguage } from '../src/common/ipc';
import { setLang } from '../src/common/i18n';

afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });
it.each([undefined, 'zh-CN', 'en-US'])('启动托盘按实际界面语言同步（设置语言=%s）', async language => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  setLang('zh-CN');
  vi.mocked(settingsLoad).mockResolvedValueOnce(language ? { language } : {});
  await startShell();
  expect(traySetLanguage).toHaveBeenCalledWith(language ?? 'zh-CN');
});
