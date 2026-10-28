// 性能：text_open 备忘的失效语义。
// 备忘只服务「打开事务内去重」；磁盘/索引状态演进（refresh、close、text-index 事件）
// 必须读到新值——尾随台轮询链（refresh→open）不得被冻结在打开瞬间的旧 totalLines。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ invoke: vi.fn(), handlers: [] as Array<(e: { payload: unknown }) => void> }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_ev: string, cb: (e: { payload: unknown }) => void) => {
    state.handlers.push(cb);
    return () => {};
  }),
}));

import { textOpen, textClose, textRefresh, onTextIndex } from '../src/common/ipc';

const info = (totalLines: number) => ({
  path: 'a.log', len: 1,
  encoding: { name: 'UTF-8', source: 'heuristic' as const, verified: true },
  newline: 'lf', mixed: false, totalLines, indexReady: true,
});

const openCalls = () => state.invoke.mock.calls.filter(([cmd]) => cmd === 'text_open');

describe('text_open 备忘（性能）', () => {
  beforeEach(() => {
    state.invoke.mockClear();
    state.handlers.length = 0;
    state.invoke.mockResolvedValue(info(10));
  });
  it('打开事务内并发与顺序调用去重，同一结果共享', async () => {
    state.invoke.mockResolvedValue(info(10));
    const [a, b] = await Promise.all([textOpen('dedup.log'), textOpen('dedup.log')]);
    expect(a).toBe(b); // 并发共享同一 Promise
    await textOpen('dedup.log'); // 事务内顺序复访同样命中
    expect(openCalls()).toHaveLength(1);
  });

  it('text_refresh 后不读旧值（尾随台轮询链）', async () => {
    state.invoke.mockResolvedValue(info(10));
    await textOpen('refresh.log');
    expect((await textOpen('refresh.log')).totalLines).toBe(10);
    state.invoke.mockResolvedValue(info(99)); // 磁盘已变/索引重建完成
    await textRefresh('refresh.log');
    expect((await textOpen('refresh.log')).totalLines).toBe(99); // 不得命中旧备忘
    expect(openCalls()).toHaveLength(2);
  });

  it('text_close 后重开重新探测', async () => {
    state.invoke.mockResolvedValue(info(10));
    await textOpen('close.log');
    await textClose('close.log');
    state.invoke.mockResolvedValue(info(21));
    expect((await textOpen('close.log')).totalLines).toBe(21);
    expect(openCalls()).toHaveLength(2);
  });

  it('text-index 事件（后台索引完成）作废备忘，totalLines 终值可读', async () => {
    state.invoke.mockResolvedValue(info(0));
    await textOpen('index.log');
    expect((await textOpen('index.log')).totalLines).toBe(0); // 打开瞬间索引未就绪的旧值
    await onTextIndex(() => {}); // 视图订阅（封装层对每个订阅者都挂失效）
    state.invoke.mockResolvedValue(info(42)); // 索引完成后的终值
    for (const h of state.handlers) h({ payload: { path: 'index.log', totalLines: 42 } });
    expect((await textOpen('index.log')).totalLines).toBe(42);
    expect(openCalls()).toHaveLength(2);
  });
});
