// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { shell, startShell, settle } from './shell-behavior-harness';
import { loadSession, openFile } from '../src/common/ipc';
import { TabStore } from '../src/common/state';
import { t } from '../src/common/i18n';

describe('SEC-13 session draft limit', () => {
  it.each([10 * 1024 * 1024, 10 * 1024 * 1024 + 1])('checks the boundary at %i characters', length => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new TabStore();
      const content = 'x'.repeat(length);
      store.restore({ tabs: [{ path: 'draft://1', route: 'text', language: null, scroll: 0, draftContent: content }], activeIndex: 0 });
      expect(store.tabs[0].draftContent).toBe(length > 10 * 1024 * 1024 ? '' : content);
      expect(warn).toHaveBeenCalledTimes(length > 10 * 1024 * 1024 ? 1 : 0);
    } finally { warn.mockRestore(); }
  });
});

describe('SUG-1 binary warning', () => {
  it('restores binary metadata and shows a warning without locking editing', async () => {
    vi.mocked(loadSession).mockResolvedValueOnce({ tabs: [{ path: 'C:\\binary.txt', route: 'text', language: null, scroll: 0 }], activeIndex: 0 });
    vi.mocked(openFile).mockResolvedValueOnce({ path: 'C:\\binary.txt', route: 'text', language: null, len: 10, modifiedMs: 100, readonly: false, binary: true });
    await startShell();
    await settle();
    const warning = [...document.querySelectorAll<HTMLElement>('#statusbar .st-cell')].find(el => el.textContent === t('st.binary'));
    expect(warning?.title).toBe(t('st.tip.binary'));
    expect(shell.tabLock?.has('C:\\binary.txt')).toBe(false);
  });
});
