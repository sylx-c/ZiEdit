// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ open: vi.fn(), stat: vi.fn(), save: vi.fn(), norm: vi.fn(), enc: vi.fn() }));
vi.mock('../src/common/ipc', async importOriginal => ({ ...await importOriginal<object>(), compareOpen: mocks.open, fileStat: mocks.stat, normalizeSave: mocks.norm, encodeConvertSave: mocks.enc }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }));
import { CompareView } from '../src/compare-view/view';
import { normalizeSaveDialog, encodeConvertDialog, sameSavePath } from '../src/shell/panels';
import { t } from '../src/common/i18n';
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let view: CompareView | undefined;
afterEach(() => { view?.destroy(); view = undefined; document.body.innerHTML = ''; vi.useRealTimers(); vi.clearAllMocks(); });
const result = () => ({ binary: false, inputState: { aMtimeMs: 1, aSize: 1, bMtimeMs: 1, bSize: 1 }, blocks: [], metaA: { path: '/a', len: 1, lines: 0 }, metaB: { path: '/b', len: 1, lines: 0 }, encMarksA: [], encMarksB: [], degraded: false });
const create = (onClose = vi.fn(), readOnly = false) => {
  const host = document.createElement('div'); document.body.append(host);
  view = new CompareView(host, '/a', '/b', { onClose, onStatus: vi.fn(), flash: vi.fn(), isReadOnly: () => readOnly });
  return host;
};
it('菜单和注册表接入编码另存、大纲及前后书签，编码另存受只读闸约束', () => {
  const app = readFileSync('src/shell/app.ts', 'utf8');
  expect(app).toContain("{ action: 'edit.encSave' }");
  for (const id of ['view.outline', 'nav.prevBookmark', 'nav.nextBookmark']) expect(app).toContain(`id: '${id}'`);
  expect(app).toMatch(/normalize\|nlSave\|encSave/);
});
it('路径规范化拒绝同源目标', () => {
  expect(sameSavePath('C:\\a\\b.txt', 'c:/a/./x/../b.txt')).toBe(true);
  expect(sameSavePath('/a/b', '/a/c')).toBe(false);
});
for (const kind of ['normalize', 'encoding']) {
  const dialog = (readOnly: boolean, error: (s: string) => void) => kind === 'normalize'
    ? normalizeSaveDialog({ path: '/a', title: '', flash: vi.fn(), isReadOnly: () => readOnly, onError: error })
    : encodeConvertDialog({ path: '/a', fromEnc: 'UTF-8', title: '', flash: vi.fn(), isReadOnly: () => readOnly, onError: error });
  it(`${kind} 对话框只读拒绝且不弹保存`, async () => {
    const error = vi.fn(); const body = dialog(true, error);
    (body.querySelector('.primary') as HTMLButtonElement).click(); await flush();
    expect(error).toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.norm).not.toHaveBeenCalled(); expect(mocks.enc).not.toHaveBeenCalled();
  });
  it(`${kind} 对话框同源目标不写盘`, async () => {
    mocks.save.mockResolvedValue('/./a'); const error = vi.fn(); const body = dialog(false, error);
    (body.querySelector('.primary') as HTMLButtonElement).click(); await flush();
    expect(error).toHaveBeenCalled(); expect(mocks.norm).not.toHaveBeenCalled(); expect(mocks.enc).not.toHaveBeenCalled();
  });
}
it('二进制输入不渲染文本差异（提示后仅保留关闭）', async () => {
  mocks.open.mockResolvedValue({ ...result(), binary: true });
  const host = create(); await flush();
  expect(host.querySelector('.cmp-row')).toBeNull();
});
it('双端 stat 变化出现重比入口，点击重新打开相同路径', async () => {
  vi.useFakeTimers(); mocks.open.mockResolvedValue(result()); mocks.stat.mockResolvedValue({ modifiedMs: 2, len: 1 });
  const host = create(undefined, true); await flush();
  expect([...host.querySelectorAll('button')].find(b => b.textContent === t('act.encSave'))?.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  const reload = [...host.querySelectorAll('button')].find(b => b.textContent === t('cmp.inputsChanged'))!;
  expect(reload).toBeTruthy(); reload.click(); await flush(); expect(mocks.open).toHaveBeenCalledTimes(2);
});
it('加载期取消关闭并丢弃迟到结果', async () => {
  let resolve!: (value: unknown) => void; mocks.open.mockReturnValue(new Promise(r => { resolve = r; }));
  const close = vi.fn(); const host = create(close);
  [...host.querySelectorAll('button')].find(b => b.textContent === t('common.cancel'))!.click();
  resolve(result()); await flush(); expect(close).toHaveBeenCalledOnce(); expect(host.children.length).toBe(0);
});
