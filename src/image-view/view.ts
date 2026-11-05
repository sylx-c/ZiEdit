// image-view —— 图片查看视图（批 D-1，007 增强视图）：png/jpg/gif/webp/svg/bmp
// asset 协议加载本地文件（不经前端读字节，符合性能红线）；适应窗/100%/Ctrl+滚轮缩放；
// 解码失败显示错误占位（007 规则）。

import { t, tf } from '../common/i18n';
import { imageProbe, openWithDefault } from '../common/ipc';
import { GUARD_MAX_PIXELS, GUARD_MAX_SIDE, isProbeableImage, shouldGuard } from './guard';
import { zassetUrl } from '../common/ipc';

export class ImageView {
  private host: HTMLElement;
  private path: string;
  private wrap!: HTMLDivElement;
  private img: HTMLImageElement | null = null;
  private frame!: HTMLDivElement;
  private scroll!: HTMLDivElement;
  private resizeObserver?: ResizeObserver;
  private rotation = 0;
  private resize = () => {
    if (this.fitMode === 'fit') this.applyFit();
  };
  private fitMode: 'fit' | '100' | 'zoom' = 'fit';
  get displayMode() { return this.fitMode; }
  private scale = 1;
  private destroyed = false;
  private forceLoad = false;
  private ctrlWheel?: (e: WheelEvent) => void;
  private doubleClick = () => this.toggleFitMode();
  private panPosition: { x: number; y: number } | null = null;
  private panDown = (e: PointerEvent) => this.onPanDown(e);
  private panMove = (e: PointerEvent) => this.onPanMove(e);
  private panUp = () => this.onPanUp();
  private imageLoad = () => {
    if (this.destroyed) return;
    this.applyFit();
    this.showInfo();
  };
  private imageError = () => {
    if (this.destroyed || !this.img) return;
    this.resizeObserver?.disconnect();
    this.unbindImageListeners(this.img);
    this.img.remove();
    this.img = null;
    this.showError(t('img.decodeFail'));
  };

  constructor(host: HTMLElement, path: string) {
    this.host = host;
    this.path = path;
  }

  async mount(): Promise<void> {
    this.host.innerHTML = '';
    this.wrap = document.createElement('div');
    this.wrap.className = 'img-view';
    this.host.appendChild(this.wrap);
    if (!this.forceLoad && isProbeableImage(this.path)) {
      const info = await imageProbe(this.path);
      if (this.destroyed) return;
      if (info && shouldGuard(info.width, info.height)) {
        this.showGuardCard(info);
        return;
      }
    }
    await this.loadImage();
  }

  /** 正常加载与用户确认强制加载共用，不重复探测。 */
  private async loadImage(): Promise<void> {
    const src = await this.fileSrc();
    if (this.destroyed) return;
    if (src === null) {
      this.showError(t('img.loadFail'));
      return;
    }
    const img = document.createElement('img');
    img.className = 'img-canvas';
    img.draggable = false;
    img.alt = '';
    img.src = src;
    this.img = img;
    this.frame = document.createElement('div');
    this.frame.className = 'img-frame';
    this.frame.appendChild(img);
    this.scroll = document.createElement('div');
    this.scroll.className = 'img-scroll';
    this.scroll.appendChild(this.frame);
    this.wrap.appendChild(this.scroll);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(this.scroll);
    img.addEventListener('dblclick', this.doubleClick);
    img.addEventListener('pointerdown', this.panDown);
    img.addEventListener('pointermove', this.panMove);
    img.addEventListener('pointerup', this.panUp);
    img.addEventListener('pointercancel', this.panUp);
    img.addEventListener('load', this.imageLoad);
    img.addEventListener('error', this.imageError);
    // Ctrl+滚轮缩放（与文本视图字号缩放同手势；无 Ctrl 不拦截，交给滚动）
    this.ctrlWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !this.img) return;
      e.preventDefault();
      this.applyZoomFactor(e.deltaY < 0 ? 1.1 : 0.9, 'zoom');
    };
    this.wrap.addEventListener('wheel', this.ctrlWheel, { passive: false });
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.onPanUp();
    if (this.ctrlWheel) this.wrap.removeEventListener('wheel', this.ctrlWheel);
    if (this.img) {
      this.unbindImageListeners(this.img);
      this.img.src = '';
    }
    this.host.innerHTML = '';
  }

  /** 解码失败与正常销毁共用解绑，不能依赖图片脱离 DOM 清理监听。 */
  private unbindImageListeners(img: HTMLImageElement): void {
    this.onPanUp();
    img.removeEventListener('dblclick', this.doubleClick);
    img.removeEventListener('pointerdown', this.panDown);
    img.removeEventListener('pointermove', this.panMove);
    img.removeEventListener('pointerup', this.panUp);
    img.removeEventListener('pointercancel', this.panUp);
    img.removeEventListener('load', this.imageLoad);
    img.removeEventListener('error', this.imageError);
  }

  private onPanDown(e: PointerEvent): void {
    if (this.destroyed || (e.button !== 0 && e.button !== 1)) return;
    e.preventDefault();
    this.panPosition = { x: e.clientX, y: e.clientY };
    this.scroll.classList.add('panning');
    // 捕获让指针离开图片后仍可拖动；测试环境或失效指针可能不支持。
    try {
      this.img?.setPointerCapture?.(e.pointerId);
    } catch {
      // 捕获失败不影响图片范围内的平移。
    }
  }

  private onPanMove(e: PointerEvent): void {
    if (!this.panPosition) return;
    this.scroll.scrollLeft -= e.clientX - this.panPosition.x;
    this.scroll.scrollTop -= e.clientY - this.panPosition.y;
    this.panPosition = { x: e.clientX, y: e.clientY };
  }

  private onPanUp(): void {
    this.panPosition = null;
    this.scroll?.classList.remove('panning');
  }

  /** 缩放模式切换（H-2 图片上下文组）：适应窗 ↔ 100% 循环 */
  toggleFitMode(): void {
    this.fitMode = this.fitMode === 'fit' ? '100' : 'fit';
    this.scale = 1;
    this.applyFit();
    this.showInfo();
  }

  /** 工具栏接线（H-2 图片上下文组）：适应窗 / 100% / 缩放± */
  fitToWindow(): void {
    this.fitMode = 'fit';
    this.applyFit();
    this.showInfo();
  }

  zoom100(): void {
    this.fitMode = '100';
    this.scale = 1;
    this.applyFit();
    this.showInfo();
  }

  zoomBy(factor: number): void {
    this.applyZoomFactor(factor);
  }

  private applyZoomFactor(factor: number, mode?: 'zoom'): void {
    const next = clamp(this.scale * factor, 0.05, 32);
    // fit 可能低于自由缩放下限，缩小不能被 clamp 反向放大。
    if (factor < 1 && next > this.scale) return;
    this.scale = next;
    // 恰好回到原尺寸时与工具栏的 100% 选中态保持一致。
    this.fitMode = mode ?? (this.scale === 1 ? '100' : 'zoom');
    this.applyFit();
    this.showInfo();
  }

  /** 旋转只改变方向，保留当前适应窗或自由倍率。 */
  rotate(delta: 1 | -1): void {
    this.rotation = ((this.rotation + delta * 90) % 360 + 360) % 360;
    this.applyFit();
    this.showInfo();
  }

  /** Tauri 环境 convertFileSrc（asset 协议）；Web harness 回退（无本地文件，直接失败占位） */
  private async fileSrc(): Promise<string | null> {
    if (!('__TAURI_INTERNALS__' in window)) return null;
    return zassetUrl(this.path);
  }

  private applyFit(): void {
    const img = this.img;
    if (!img) return;
    img.classList.toggle('fit', this.fitMode === 'fit');
    img.style.transform = `translate(-50%,-50%) rotate(${this.rotation}deg)`;
    const w = img.naturalWidth || 100;
    const h = img.naturalHeight || 100;
    const [rw, rh] = this.rotation % 180 ? [h, w] : [w, h];
    let s = this.fitMode === '100' ? 1 : this.scale;
    if (this.fitMode === 'fit') {
      const availW = this.scroll.clientWidth - 48;
      const availH = this.scroll.clientHeight - 48;
      // 隐藏视图及 jsdom 没有有效视口；保留已设尺寸，避免负值与布局跳变。
      if (availW <= 0 || availH <= 0) return;
      s = Math.min(availW / rw, availH / rh, 1);
      this.scale = s;
    }
    // transform 不参与布局，frame 按旋转后尺寸占位；图片仍按原方向缩放。
    // .img-canvas 的 24px padding 在 border-box 下须补偿 48px。
    this.frame.style.width = `${rw * s + 48}px`;
    this.frame.style.height = `${rh * s + 48}px`;
    img.style.width = `${w * s + 48}px`;
    img.style.height = `${h * s + 48}px`;
  }

  private showInfo(): void {
    let bar = this.wrap.querySelector<HTMLDivElement>('.img-info');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'img-info';
      this.buildControls(bar);
      this.wrap.appendChild(bar);
    }
    const img = this.img;
    const mode =
      this.fitMode === 'fit' ? t('img.modeFit') : this.fitMode === '100' ? t('img.mode100') : `${Math.round(this.scale * 100)}%`;
    bar.querySelector<HTMLSpanElement>('.img-pct')!.textContent = mode;
    bar.querySelector<HTMLSpanElement>('.img-dim')!.textContent = img
      ? `${img.naturalWidth}×${img.naturalHeight}` : '';
  }

  /** 控件只构建一次，更新倍率时保留按钮与键盘焦点。 */
  private buildControls(bar: HTMLDivElement): void {
    const pct = document.createElement('span');
    pct.className = 'img-pct';
    const dim = document.createElement('span');
    dim.className = 'img-dim';
    bar.append(
      this.infoButton('img-ctrl img-rot', '⟲', t('img.rotateL'), () => this.rotate(-1)),
      this.infoButton('img-ctrl img-rot', '⟳', t('img.rotateR'), () => this.rotate(1)),
      this.infoButton('img-ctrl', '−', t('img.zoomOut'), () => this.zoomBy(0.8)),
      pct,
      this.infoButton('img-ctrl', '+', t('img.zoomIn'), () => this.zoomBy(1.25)),
      this.infoButton('img-fitbtn', t('img.fit'), t('img.fit'), () => this.fitToWindow()),
      dim,
    );
  }

  private infoButton(className: string, text: string, title: string, action: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = text;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.addEventListener('click', action);
    return btn;
  }

  private showError(msg: string): void {
    const box = document.createElement('div');
    box.className = 'img-err';
    box.textContent = msg;
    this.wrap.appendChild(box);
  }

  private showGuardCard(info: { width: number; height: number }): void {
    const card = document.createElement('div');
    card.className = 'img-guard';
    const title = document.createElement('div');
    title.className = 'img-guard-title';
    title.textContent = t('img.guardTitle');
    const desc = document.createElement('div');
    desc.className = 'img-guard-desc';
    desc.textContent = tf('img.guardDesc', info.width, info.height, GUARD_MAX_SIDE, GUARD_MAX_PIXELS / 1e6);
    const actions = document.createElement('div');
    actions.className = 'img-guard-actions';
    const error = document.createElement('div');
    error.className = 'img-guard-desc';
    error.setAttribute('role', 'alert');
    actions.append(
      this.infoButton('', t('img.guardOpen'), t('img.guardOpen'), () => {
        if (this.destroyed) return;
        void openWithDefault(this.path).catch((err: unknown) => {
          if (!this.destroyed && card.isConnected) {
            error.textContent = tf('img.guardOpenFail', err instanceof Error ? err.message : String(err));
          }
        });
      }),
      this.infoButton('', t('img.guardLoad'), t('img.guardLoad'), () => {
        if (this.destroyed || this.forceLoad) return;
        this.forceLoad = true;
        card.remove();
        void this.loadImage();
      }),
    );
    card.append(title, desc, actions, error);
    this.wrap.appendChild(card);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
