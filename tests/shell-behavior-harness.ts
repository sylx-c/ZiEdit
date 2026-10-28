import { vi } from 'vitest';

const shell = vi.hoisted(() => ({
  store: null as any, tabLock: null as Set<string> | null, settings: null as any, mode: null as string | null,
  actions: null as any,
  edit: null as any,
  tree: null as any,
  cli: null as any,
  confirm: vi.fn(), alert: vi.fn(), flash: vi.fn(), saveDialog: vi.fn(), invoke: vi.fn(async () => null),
}));
export { shell };
vi.mock('@tauri-apps/api/core', () => ({ invoke: shell.invoke, convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: shell.saveDialog }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => 'C:\\', resolveResource: async (p: string) => p }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, onResized: async () => () => {}, isMaximized: async () => false }) }));
vi.mock('../src/shell/chrome', async importOriginal => {
  const original = await importOriginal<typeof import('../src/shell/chrome')>();
  return { ...original,
    ActionRegistry: class extends original.ActionRegistry { constructor() { super(); shell.actions = this; } },
    initTitlebar: vi.fn(), refreshTitlebar: vi.fn(),
    buildMenubar: () => ({ refresh() {}, dispose() {}, open() {} }),
    buildToolbar: () => ({ refresh() {} }),
    dlgConfirm: shell.confirm, dlgAlert: shell.alert, flash: shell.flash,
  };
});
vi.mock('../src/text-view/edit', () => ({ EDIT_LIMIT: 10 * 1024 * 1024,
  EditView: class {
    filePath: string | null; opts: any; dirty = false;
    constructor(_host: unknown, opts: any) { this.filePath = opts.path; this.opts = opts; shell.edit = this; queueMicrotask(() => opts.onReady?.()); }
    goToLine = vi.fn();
    destroy() {} focus() {} setFontSize() {} setWrap() {} setReadOnly = vi.fn(); setLanguage() {}
    openFindBar = vi.fn(); openReplace = vi.fn();
    getContent() { return 'edited'; }
    async save() {
      if (!this.filePath) { this.opts.onSaveAsNeeded('edited'); return true; }
      const { textSave } = await import('../src/common/ipc');
      const stat = await textSave(this.filePath, 'edited', 'UTF-8');
      this.opts.onSaved(this.filePath, stat, true); return true;
    }
  },
}));
vi.mock('../src/file-tree/tree', () => ({ kindOf: () => 'text', FileTree: class {
  opts: any; constructor(_host: unknown, _roots: unknown, opts: any) { this.opts = opts; shell.tree = this; }
  async mount() {} async render() {} setActive() {} async reveal() {} async refresh() {} destroy() {} setFilter() {}
} }));

vi.mock('../src/common/ipc', async importOriginal => {
  const original = await importOriginal<typeof import('../src/common/ipc')>();
  const mocked = Object.fromEntries(Object.entries(original).map(([key, value]) => [key,
    typeof value === 'function' ? vi.fn(async () => null) : value]));
  return { ...mocked,
    settingsLoad: vi.fn(async () => ({})), loadSession: vi.fn(async () => ({ tabs: [], activeIndex: 0 })),
    namedSessionsLoad: vi.fn(async () => ({})), cliTakePending: vi.fn(async () => []),
    onCliOpen: vi.fn(async (cb: unknown) => { shell.cli = cb; return () => {}; }),
    recentList: vi.fn(async () => []), favoritesList: vi.fn(async () => []),
    recoveryList: vi.fn(async () => ({ crashed: false, items: [] })),
    fileStat: vi.fn(async () => ({ len: 10, modifiedMs: 100, isDir: false })),
    openFile: vi.fn(async (path: string) => ({ path, len: 10, modifiedMs: 100, route: 'text', language: null, readonly: false })),
    textOpen: vi.fn(async () => ({ len: 10, encoding: { name: 'UTF-8', source: 'heuristic', verified: true }, newline: 'lf', totalLines: 1, indexReady: true })),
    textReadAll: vi.fn(async () => 'hello'), textSave: vi.fn(async () => ({ len: 20, modifiedMs: 200 })),
  };
});

export async function startShell() {
  vi.clearAllMocks();
  shell.saveDialog.mockReset();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = ['sidebar', 'sbResize', 'tabbar', 'viewarea', 'statusbar', 'menubar', 'toolbar'].map(id => `<div id="${id}"></div>`).join('');
  localStorage.setItem('ZiEdit-welcomed-v1', '1');
  (globalThis as { __zieditTest?: unknown }).__zieditTest = shell;
  const { boot } = await import('../src/shell/app');
  await boot();
  await settle();
}
export async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
export function tabNames() { return [...document.querySelectorAll('.tab-name')].map(el => el.textContent); }
export function clickText(selector: string, text: string) {
  const el = [...document.querySelectorAll<HTMLElement>(selector)].find(el => el.textContent === text);
  if (!el) throw new Error(`Missing ${selector}: ${text}`);
  el.click();
}
