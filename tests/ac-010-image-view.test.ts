// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageView } from '../src/image-view/view';
import { imageProbe, openWithDefault } from '../src/common/ipc';

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: () => 'asset://x' }));
vi.mock('../src/common/ipc', () => ({
  zassetUrl: (p: string) => 'http://zasset.localhost/' + encodeURIComponent(p),
  imageProbe: vi.fn(async () => null),
  openWithDefault: vi.fn(async () => {}),
}));

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(private callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this);
  }
  trigger() { this.callback([], this as unknown as ResizeObserver); }
}

beforeEach(() => {
  MockResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
});

describe('图片信息条（ac-010）', () => {
  let host: HTMLDivElement;
  let view: ImageView;
  let img: HTMLImageElement;

  beforeEach(async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    host = document.createElement('div');
    document.body.appendChild(host);
    view = new ImageView(host, 'test.png');
    await view.mount();
    img = host.querySelector('img')!;
    img.dispatchEvent(new Event('load'));
  });

  afterEach(() => {
    view.destroy();
    host.remove();
    vi.unstubAllGlobals();
  });

  it('信息条有 −/百分比/+/适应窗口 四件', () => {
    const bar = host.querySelector('.img-info')!;
    expect(bar).not.toBeNull();
    expect(bar.querySelectorAll('button.img-ctrl:not(.img-rot)')).toHaveLength(2);
    expect(bar.querySelector('.img-pct')?.textContent).toBe('适应窗口');
    expect(bar.querySelector('.img-fitbtn')).not.toBeNull();
  });

  it('点击放大进入自由倍率并显示百分比', () => {
    host.querySelector<HTMLButtonElement>('.img-ctrl[title="放大"]')!.click();
    expect(view.displayMode).toBe('zoom');
    expect(host.querySelector('.img-pct')?.textContent).toBe('125%');
  });

  it('点击缩小回到 100%', () => {
    host.querySelector<HTMLButtonElement>('.img-ctrl[title="放大"]')!.click();
    host.querySelector<HTMLButtonElement>('.img-ctrl[title="缩小"]')!.click();
    expect(view.displayMode).toBe('100');
    expect(host.querySelector('.img-pct')?.textContent).toBe('100%');
  });

  it('双击循环 fit→100→fit', () => {
    img.dispatchEvent(new MouseEvent('dblclick'));
    expect(view.displayMode).toBe('100');
    img.dispatchEvent(new MouseEvent('dblclick'));
    expect(view.displayMode).toBe('fit');
  });

  it('自由倍率双击回到适应窗口，销毁移除监听', () => {
    view.zoomBy(1.25);
    img.dispatchEvent(new MouseEvent('dblclick'));
    expect(view.displayMode).toBe('fit');
    view.destroy();
    img.dispatchEvent(new MouseEvent('dblclick'));
    expect(view.displayMode).toBe('fit');
  });

  it('适应窗口按钮恢复适应窗口且重复更新不重建控件', () => {
    const fit = host.querySelector<HTMLButtonElement>('.img-fitbtn')!;
    view.zoomBy(1.25);
    expect(host.querySelector('.img-fitbtn')).toBe(fit);
    fit.click();
    expect(view.displayMode).toBe('fit');
  });
});

describe('图片旋转（ac-010）', () => {
  let host: HTMLDivElement;
  let view: ImageView;
  let img: HTMLImageElement;

  beforeEach(async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    host = document.createElement('div');
    document.body.appendChild(host);
    view = new ImageView(host, 'test.png');
    await view.mount();
    img = host.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 800 });
    Object.defineProperty(img, 'naturalHeight', { value: 600 });
    const wrap = host.querySelector('.img-scroll')!;
    Object.defineProperty(wrap, 'clientWidth', { value: 1048, configurable: true });
    Object.defineProperty(wrap, 'clientHeight', { value: 1048, configurable: true });
    img.dispatchEvent(new Event('load'));
  });

  afterEach(() => {
    view.destroy();
    host.remove();
    vi.unstubAllGlobals();
  });

  it('100% 旋转交换 frame 宽高，转满一圈恢复', () => {
    view.zoom100();
    view.rotate(1);
    const frame = host.querySelector<HTMLElement>('.img-frame')!;
    expect([frame.style.width, frame.style.height]).toEqual(['648px', '848px']);
    view.rotate(1);
    expect([frame.style.width, frame.style.height]).toEqual(['848px', '648px']);
    view.rotate(1);
    view.rotate(1);
    expect(img.style.transform).toBe('translate(-50%,-50%) rotate(0deg)');
    expect([frame.style.width, frame.style.height]).toEqual(['848px', '648px']);
  });

  it('适应窗口旋转保留模式和 fit 类', () => {
    view.rotate(1);
    expect(view.displayMode).toBe('fit');
    expect(img.classList.contains('fit')).toBe(true);
    const wrap = host.querySelector('.img-scroll')!;
    const frame = host.querySelector<HTMLElement>('.img-frame')!;
    Object.defineProperty(wrap, 'clientWidth', { value: 448 });
    Object.defineProperty(wrap, 'clientHeight', { value: 448 });
    MockResizeObserver.instances[0].trigger();
    expect([frame.style.width, frame.style.height]).toEqual(['348px', '448px']);
    Object.defineProperty(wrap, 'clientWidth', { value: 0 });
    MockResizeObserver.instances[0].trigger();
    expect([frame.style.width, frame.style.height]).toEqual(['348px', '448px']);
    const observer = MockResizeObserver.instances[0];
    expect(observer.observe).toHaveBeenCalledWith(wrap);
    view.destroy();
    expect(observer.disconnect).toHaveBeenCalled();
  });

  it('解码失败立即断开 ResizeObserver', () => {
    img.dispatchEvent(new Event('error'));
    expect(MockResizeObserver.instances[0].disconnect).toHaveBeenCalled();
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.img-err')).not.toBeNull();
  });

  it('fit 同步实际倍率，缩小从 25% 到 20%', () => {
    const scroll = host.querySelector('.img-scroll')!;
    Object.defineProperty(scroll, 'clientWidth', { value: 248, configurable: true });
    Object.defineProperty(scroll, 'clientHeight', { value: 248, configurable: true });
    view.fitToWindow();
    expect(img.style.width).toBe('248px');
    expect(view.displayMode).toBe('fit');
    host.querySelector<HTMLButtonElement>('.img-ctrl[title="缩小"]')!.click();
    expect(host.querySelector('.img-pct')?.textContent).toBe('20%');
    expect(img.style.width).toBe('208px');
    expect(host.querySelector('.img-info')?.parentElement).toBe(scroll.parentElement);
    expect(scroll.contains(host.querySelector('.img-info'))).toBe(false);
  });

  it('zoom→fit→缩小不使用旧倍率，滚轮也以实际 fit 倍率为基数', () => {
    view.zoomBy(2);
    const scroll = host.querySelector('.img-scroll')!;
    Object.defineProperty(scroll, 'clientWidth', { value: 248 });
    Object.defineProperty(scroll, 'clientHeight', { value: 248 });
    view.fitToWindow();
    host.querySelector<HTMLButtonElement>('.img-ctrl[title="缩小"]')!.click();
    expect(img.style.width).toBe('208px');
    view.fitToWindow();
    scroll.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 100, bubbles: true }));
    expect(img.style.width).toBe('228px');
  });

  it('fit 低于 5% 时按钮与滚轮缩小均保持实际倍率和 fit 模式', async () => {
    view.destroy();
    view = new ImageView(host, 'large.png');
    await view.mount();
    img = host.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 16000 });
    Object.defineProperty(img, 'naturalHeight', { value: 1000 });
    const scroll = host.querySelector('.img-scroll')!;
    Object.defineProperty(scroll, 'clientWidth', { value: 648 });
    Object.defineProperty(scroll, 'clientHeight', { value: 1048 });
    view.fitToWindow();
    expect(img.style.width).toBe('648px');
    host.querySelector<HTMLButtonElement>('.img-ctrl[title="缩小"]')!.click();
    expect(view.displayMode).toBe('fit');
    expect(img.style.width).toBe('648px');
    scroll.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 100, bubbles: true }));
    expect(view.displayMode).toBe('fit');
    expect(img.style.width).toBe('648px');
    expect(host.querySelector('.img-pct')?.textContent).toBe('适应窗口');
  });

  it('信息条两个旋转按钮点击生效且位于缩放之前', () => {
    view.zoom100();
    const buttons = host.querySelectorAll<HTMLButtonElement>('.img-rot');
    expect(buttons).toHaveLength(2);
    expect(host.querySelector('.img-info button')).toBe(buttons[0]);
    const frame = host.querySelector<HTMLElement>('.img-frame')!;
    buttons[0].click();
    expect(img.style.transform).toContain('rotate(270deg)');
    expect([frame.style.width, frame.style.height]).toEqual(['648px', '848px']);
    buttons[1].click();
    expect(img.style.transform).toContain('rotate(0deg)');
    expect([frame.style.width, frame.style.height]).toEqual(['848px', '648px']);
  });
});

describe('图片拖拽平移（ac-010）', () => {
  let host: HTMLDivElement;
  let view: ImageView;
  let img: HTMLImageElement;
  let wrap: HTMLDivElement;

  beforeEach(async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    host = document.createElement('div');
    document.body.appendChild(host);
    view = new ImageView(host, 'test.png');
    await view.mount();
    img = host.querySelector('img')!;
    img.dispatchEvent(new Event('load'));
    wrap = host.querySelector('.img-scroll')!;
  });

  afterEach(() => {
    view.destroy();
    host.remove();
    vi.unstubAllGlobals();
  });

  it('拖拽改变滚动位置', () => {
    for (const button of [0, 1]) {
      wrap.scrollLeft = 0;
      wrap.scrollTop = 0;
      img.dispatchEvent(new MouseEvent('pointerdown', { button, clientX: 100, clientY: 100 }));
      img.dispatchEvent(new MouseEvent('pointermove', { clientX: 80, clientY: 90 }));
      expect(wrap.scrollLeft).toBe(20);
      expect(wrap.scrollTop).toBe(10);
      expect(wrap.classList.contains('panning')).toBe(true);
      img.dispatchEvent(new MouseEvent('pointerup'));
      expect(wrap.classList.contains('panning')).toBe(false);
      img.dispatchEvent(new MouseEvent('pointermove', { clientX: 60, clientY: 70 }));
      expect(wrap.scrollLeft).toBe(20);
      expect(wrap.scrollTop).toBe(10);
    }
  });

  it('无移动的按下抬起不平移', () => {
    img.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 }));
    img.dispatchEvent(new MouseEvent('pointerup', { clientX: 100, clientY: 100 }));
    expect(wrap.scrollLeft).toBe(0);
    expect(wrap.scrollTop).toBe(0);
    img.dispatchEvent(new MouseEvent('pointerdown', { button: 1, clientX: 100, clientY: 100 }));
    img.dispatchEvent(new MouseEvent('pointercancel'));
    expect(wrap.classList.contains('panning')).toBe(false);
    img.dispatchEvent(new MouseEvent('pointermove', { clientX: 80, clientY: 90 }));
    expect(wrap.scrollLeft).toBe(0);
    expect(wrap.scrollTop).toBe(0);
  });

  it('destroy 后派发事件无异常', () => {
    img.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 }));
    view.destroy();
    expect(() => {
      img.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 }));
      img.dispatchEvent(new MouseEvent('pointermove', { clientX: 80, clientY: 90 }));
      img.dispatchEvent(new MouseEvent('pointerup'));
      wrap.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -100 }));
    }).not.toThrow();
    expect(host.childElementCount).toBe(0);
    expect(wrap.classList.contains('panning')).toBe(false);
    expect(wrap.scrollLeft).toBe(0);
    expect(wrap.scrollTop).toBe(0);
    expect(view.displayMode).toBe('fit');
  });

  it('解码失败后销毁实际解绑图片监听并结束平移', () => {
    const remove = vi.spyOn(img, 'removeEventListener');
    img.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 }));
    img.dispatchEvent(new Event('error'));
    expect(wrap.classList.contains('panning')).toBe(false);
    expect(() => view.destroy()).not.toThrow();
    for (const type of ['dblclick', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'load', 'error']) {
      expect(remove).toHaveBeenCalledWith(type, expect.any(Function));
    }
    expect(() => {
      img.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 }));
      img.dispatchEvent(new MouseEvent('pointermove', { clientX: 80, clientY: 90 }));
      img.dispatchEvent(new MouseEvent('pointerup'));
      img.dispatchEvent(new MouseEvent('dblclick'));
      img.dispatchEvent(new Event('load'));
      img.dispatchEvent(new Event('error'));
    }).not.toThrow();
    expect(wrap.scrollLeft).toBe(0);
    expect(wrap.scrollTop).toBe(0);
    expect(host.childElementCount).toBe(0);
    expect(view.displayMode).toBe('fit');
    remove.mockRestore();
  });
});

describe('超大图守护（ac-010）', () => {
  let host: HTMLDivElement;
  let view: ImageView;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    host = document.createElement('div');
    document.body.appendChild(host);
    view = new ImageView(host, 'large.png');
  });

  afterEach(() => {
    view.destroy();
    host.remove();
    vi.unstubAllGlobals();
  });

  it('超大 png 展示守护卡片且不建 img', async () => {
    vi.mocked(imageProbe).mockResolvedValueOnce({ width: 20000, height: 20000, format: 'png' });
    await view.mount();
    expect(host.querySelector('.img-guard')).not.toBeNull();
    expect(host.querySelector('.img-view img')).toBeNull();
    expect(host.querySelector('.img-guard')?.textContent).toContain('20000×20000');
  });

  it('仍要加载进入正常加载', async () => {
    vi.mocked(imageProbe).mockResolvedValueOnce({ width: 20000, height: 20000, format: 'png' });
    await view.mount();
    host.querySelector<HTMLButtonElement>('.img-guard-actions button:last-child')!.click();
    await vi.waitFor(() => expect(host.querySelector('img')).not.toBeNull());
    expect(host.querySelector('.img-guard')).toBeNull();
    expect(imageProbe).toHaveBeenCalledTimes(1);
  });

  it('用系统查看器打开', async () => {
    vi.mocked(imageProbe).mockResolvedValueOnce({ width: 20000, height: 20000, format: 'png' });
    await view.mount();
    host.querySelector<HTMLButtonElement>('.img-guard-actions button:first-child')!.click();
    expect(openWithDefault).toHaveBeenCalledExactlyOnceWith('large.png');
  });

  it('系统查看器拒绝时卡片显示错误并保留两个入口', async () => {
    vi.mocked(imageProbe).mockResolvedValueOnce({ width: 20000, height: 20000, format: 'png' });
    vi.mocked(openWithDefault).mockRejectedValueOnce(new Error('权限不足'));
    await view.mount();
    host.querySelector<HTMLButtonElement>('.img-guard-actions button:first-child')!.click();
    await vi.waitFor(() => expect(host.querySelector('.img-guard [role="alert"]')?.textContent)
      .toBe('用系统查看器打开失败：权限不足'));
    expect(host.querySelectorAll('.img-guard-actions button')).toHaveLength(2);
  });

  it('探测失败 fail-open', async () => {
    vi.mocked(imageProbe).mockResolvedValueOnce(null);
    await view.mount();
    expect(host.querySelector('img')).not.toBeNull();
    expect(host.querySelector('.img-guard')).toBeNull();
  });

  it('svg 不探测', async () => {
    view = new ImageView(host, 'a.svg');
    await view.mount();
    expect(imageProbe).not.toHaveBeenCalled();
    expect(host.querySelector('img')).not.toBeNull();
  });
});
