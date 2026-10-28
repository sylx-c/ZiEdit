// @vitest-environment jsdom
// 性能：尾随台跟随链——索引完成后行数持续增长。
// TailBoard 轮询链 text_refresh → text_open 必须读到新 totalLines（备忘在 refresh 处失效），
// 修前备忘冻结会使 totalLines 恒为首次值，pendingTries 耗尽后尾随台停摆。
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

import { TailBoard } from '../src/text-view/tailboard';

const openInfo = (totalLines: number) => ({
  path: 'a.log', len: 1,
  encoding: { name: 'UTF-8', source: 'heuristic' as const, verified: true },
  newline: 'lf', mixed: false, totalLines, indexReady: false,
});

describe('尾随台轮询读新值', () => {
  afterEach(() => vi.useRealTimers());

  it('文件增长后下一轮轮询补齐新行（refresh 后 text_open 不读旧备忘）', async () => {
    vi.useFakeTimers();
    let total = 5;
    state.invoke.mockImplementation(async (cmd: string, args: { from?: number; to?: number }) => {
      if (cmd === 'text_refresh') return { changed: true, len: 1 };
      if (cmd === 'text_open') return openInfo(total);
      if (cmd === 'text_lines') {
        const out = [];
        for (let n = args.from!; n <= args.to!; n++) out.push({ no: n, text: `line-${n}` });
        return out;
      }
      return null;
    });
    const host = document.createElement('div');
    document.body.append(host);
    const tb = new TailBoard(host, { onPick: async () => null, intervalMs: 1200, onStatus: vi.fn() });
    tb.addSource('a.log');
    await vi.advanceTimersByTimeAsync(1200); // 首轮：索引未完，读得 5 行
    expect(host.querySelectorAll('.tb-row')).toHaveLength(5);

    total = 12; // 磁盘续写 + 后台索引完成：totalLines 终值
    await vi.advanceTimersByTimeAsync(1200); // 下一轮：refresh 已作废备忘 → 读到 12
    expect(host.querySelectorAll('.tb-row')).toHaveLength(12);
    tb.destroy();
    host.remove();
  });
});
