// H-5 T6/T8/T10：快捷键统一派发与自动保存旁路的单元验收。
// - ActionRegistry.chordOf/dispatch：和弦归一化、查表派发、enabled 门控（keydown 单一来源的机制保证）
// - autosaveAction/startAutosaveTimers：sidecar/file/skip 决策矩阵与定时调度（伪定时器）
import { describe, expect, it, vi } from 'vitest';
import { ActionRegistry } from '../src/shell/chrome';
import { autosaveAction, startAutosaveTimers, type AutosaveCtx } from '../src/shell/autosave';

function ev(partial: Partial<KeyboardEvent>): KeyboardEvent {
  return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, key: '', ...partial } as KeyboardEvent;
}

describe('AC 和弦归一化（chordOf）', () => {
  it('修饰键序：Ctrl+Alt+Shift+Key；单字母大写', () => {
    expect(ActionRegistry.chordOf(ev({ ctrlKey: true, shiftKey: true, key: 'p' }))).toBe('Ctrl+Shift+P');
    expect(ActionRegistry.chordOf(ev({ altKey: true, key: 'z' }))).toBe('Alt+Z');
    expect(ActionRegistry.chordOf(ev({ ctrlKey: true, key: ',' }))).toBe('Ctrl+,');
    expect(ActionRegistry.chordOf(ev({ ctrlKey: true, shiftKey: true, key: 'O' }))).toBe('Ctrl+Shift+O');
  });
  it('无修饰：仅功能键可派发，字母/符号返回 null（不打字干扰）', () => {
    expect(ActionRegistry.chordOf(ev({ key: 'F5' }))).toBe('F5');
    expect(ActionRegistry.chordOf(ev({ key: 'a' }))).toBeNull();
    expect(ActionRegistry.chordOf(ev({ key: 'Enter' }))).toBeNull();
  });
  it('单独的修饰键按下返回 null', () => {
    expect(ActionRegistry.chordOf(ev({ ctrlKey: true, key: 'Control' }))).toBeNull();
  });
});

describe('AC 表驱动派发（dispatch，T8 单一来源）', () => {
  it('命中已注册和弦执行动作；调用方据此 preventDefault', () => {
    const reg = new ActionRegistry();
    const run = vi.fn();
    reg.add({ id: 'x.save', label: '保存', shortcut: 'Ctrl+S', group: 'file', run });
    expect(reg.dispatch(ev({ ctrlKey: true, key: 's' }))).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('未注册/不匹配返回 false（放行默认行为）', () => {
    const reg = new ActionRegistry();
    reg.add({ id: 'x.save', label: '保存', shortcut: 'Ctrl+S', group: 'file', run: () => {} });
    expect(reg.dispatch(ev({ ctrlKey: true, key: 'k' }))).toBe(false);
    expect(reg.dispatch(ev({ key: 'k' }))).toBe(false);
  });
  it('enabled=false 拦截派发（与菜单/工具栏同源）', () => {
    const reg = new ActionRegistry();
    const run = vi.fn();
    reg.add({ id: 'x.save', label: '保存', shortcut: 'Ctrl+S', group: 'file', run, enabled: () => false });
    expect(reg.dispatch(ev({ ctrlKey: true, key: 's' }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it('H-6 已消费事件短路：编辑器命中绑定即 preventDefault，同和弦不得二次执行', () => {
    // 实测回归：Ctrl+Z 在编辑态撤销两步、Alt+C 列模式开了又关（CM6 keymap 与注册表各跑一遍）
    const reg = new ActionRegistry();
    const run = vi.fn();
    reg.add({ id: 'x.column', label: '列模式', shortcut: 'Alt+C', group: 'edit', run });
    expect(reg.dispatch(ev({ altKey: true, key: 'c', defaultPrevented: true }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
    // 未消费（编辑器无绑定 / 失焦）时照常派发
    expect(reg.dispatch(ev({ altKey: true, key: 'c' }))).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('AC 自动保存决策（autosaveAction，T10）', () => {
  it('矩阵：关/不脏=snapshot 链路上都不落盘', () => {
    expect(autosaveAction({ autoSaveSec: 0 }, true)).toBe('skip');
    expect(autosaveAction({ autoSaveSec: 15 }, false)).toBe('skip');
    expect(autosaveAction({ autoSaveSec: 15, autoSaveTarget: 'sidecar' }, true)).toBe('snapshot');
    expect(autosaveAction({ autoSaveSec: 15, autoSaveTarget: 'file' }, true)).toBe('file');
    expect(autosaveAction({ autoSaveSec: 15 }, true)).toBe('snapshot'); // 缺省 sidecar（出厂）
  });
});

describe('AC 自动保存调度（伪定时器）', () => {
  function fakeCtx(over: Partial<AutosaveCtx> = {}): AutosaveCtx {
    return {
      getSettings: () => ({ autoSaveSec: 15, autoSaveTarget: 'sidecar' }),
      activeInfo: () => ({ path: '/a.txt', draft: false }),
      isDirty: () => true,
      content: () => 'hello',
      snapshot: () => {},
      saveNow: () => Promise.resolve(true),
      onFileSaved: () => {},
      onSaveFailed: () => {},
      isSwitchPending: () => false,
      ...over,
    };
  }
  function fakeTimers() {
    const cbs: Array<() => void> = [];
    return {
      setInterval: (fn: () => void) => (cbs.push(fn), cbs.length),
      clearInterval: () => {},
      tick: () => cbs.forEach(cb => cb()),
      now: 0,
    };
  }

  it('sidecar：脏满 15s 触发快照，绝不 saveNow', () => {
    const timers = fakeTimers();
    const snap = vi.fn();
    const saveNow = vi.fn();
    const realNow = Date.now;
    let t = 1000;
    Date.now = () => t;
    try {
      startAutosaveTimers(fakeCtx({ snapshot: snap, saveNow }), timers);
      for (let i = 0; i < 12; i++) {
        t += 1500;
        timers.tick();
      }
      expect(snap.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(saveNow).not.toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });
  it('file：脏满 15s 直写原文件（saveNow），成功走 onFileSaved', async () => {
    const timers = fakeTimers();
    const snap = vi.fn();
    const saveNow = vi.fn(() => Promise.resolve(true));
    const saved = vi.fn();
    const realNow = Date.now;
    let t = 1000;
    Date.now = () => t;
    try {
      startAutosaveTimers(
        fakeCtx({ getSettings: () => ({ autoSaveSec: 15, autoSaveTarget: 'file' }), snapshot: snap, saveNow, onFileSaved: saved }),
        timers
      );
      for (let i = 0; i < 12; i++) {
        t += 1500;
        timers.tick();
      }
      await Promise.resolve();
      expect(saveNow).toHaveBeenCalled();
      expect(saved).toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });
  it('R5 确认挂起期间暂停（isSwitchPending=true 不触发任何写）', () => {
    const timers = fakeTimers();
    const snap = vi.fn();
    const saveNow = vi.fn();
    const realNow = Date.now;
    let t = 1000;
    Date.now = () => t;
    try {
      startAutosaveTimers(fakeCtx({ snapshot: snap, saveNow, isSwitchPending: () => true }), timers);
      for (let i = 0; i < 12; i++) {
        t += 1500;
        timers.tick();
      }
      expect(snap).not.toHaveBeenCalled();
      expect(saveNow).not.toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });
  it('大文档sidecar仅30秒写一次，切标签不继承上一文件的计时', () => {
    const timers = fakeTimers();
    const snap = vi.fn();
    const realNow = Date.now;
    let now = 1000;
    let path = '/big.md';
    Date.now = () => now;
    try {
      startAutosaveTimers(fakeCtx({ getSettings: () => ({ autoSaveSec: 1, autoSaveTarget: 'sidecar' }),
        sizeHint: () => 9 * 1024 * 1024, snapshot: snap, activeInfo: () => ({ path, draft: false }) }), timers);
      timers.tick();
      now += 29000; timers.tick();
      expect(snap).not.toHaveBeenCalled();
      now += 1000; timers.tick();
      expect(snap).toHaveBeenCalledTimes(1);
      now += 29000; timers.tick();
      path = '/second.md';
      timers.tick();
      now += 2000; timers.tick();
      expect(snap).toHaveBeenCalledTimes(1);
    } finally { Date.now = realNow; }
  });
});
