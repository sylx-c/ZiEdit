// 临时探针（用后即删）：自校正钉扎是否落地。
// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { LivePreviewView } from './livepreview';

vi.mock('../common/ipc', () => ({ textOpen: async () => ({ encoding: 'UTF-8', newline: 'lf' }), textSave: async () => ({ len: 0, modifiedMs: 0 }), textReadAll: async () => '' }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

it('probe self-correct pin', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const v = new LivePreviewView(host, { path: 'E:/a.md', encoding: 'UTF-8',
    initialDoc: '| A | B |\n|---|---|\n| 1 | 2 |\n\n尾\n', onStatus: () => {}, onSaved: () => {} });
  await vi.waitFor(() => expect(v.view).toBeDefined());
  await vi.waitFor(() => expect(!!host.querySelector('.mdir-tablebox')).toBe(true), { timeout: 3000 });
  for (const ms of [100, 400, 1200]) {
    await new Promise(r => setTimeout(r, ms === 100 ? 100 : ms - (ms === 400 ? 100 : 400)));
    const box = host.querySelector('.mdir-tablebox') as HTMLElement;
    console.log(ms, 'ms pin:', box?.style.height, 'boxH:', box ? Math.round(box.getBoundingClientRect().height * 10) / 10 : '?');
  }
  v.destroy(); host.remove();
}, 8000);
