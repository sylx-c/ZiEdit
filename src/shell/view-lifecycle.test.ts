// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ViewHostRegistry, ViewParking } from './view-lifecycle';

describe('视图生命周期', () => {
  it('宿主与视图绑定，独立创建', () => {
    const parent = document.createElement('div');
    const registry = new ViewHostRegistry();
    const view = {};
    const host = registry.create(parent);
    registry.register(view, host);
    expect(registry.get(view)).toBe(host);
    expect(host.className).toBe('view-host');
  });
  it('暂存采用 LRU，超限时只销毁最旧项', () => {
    const destroy = vi.fn();
    const parking = new ViewParking<{ key: string; host: HTMLElement; view: { destroy(): void } }>(2, destroy);
    for (const key of ['a', 'b', 'c']) parking.put(key, { key, view: { destroy() {} }, host: document.createElement('div') });
    expect(parking.get('a')).toBeUndefined();
    expect(destroy).toHaveBeenCalledOnce();
    expect(parking.get('b')).toBeDefined();
    expect(parking.get('c')).toBeDefined();
  });
  it('delete 只删除一次，不重复销毁', () => {
    const entry = { key: 'a', view: { destroy: vi.fn() }, host: document.createElement('div') };
    const parking = new ViewParking<typeof entry>(2, item => item.view.destroy());
    parking.put('a', entry);
    parking.delete('a');
    expect(entry.view.destroy).toHaveBeenCalledOnce();
    expect(parking.get('a')).toBeUndefined();
  });
});
