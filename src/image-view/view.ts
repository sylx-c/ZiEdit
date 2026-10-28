// image-view —— 图片查看视图（批 D-1，007 增强视图）：png/jpg/gif/webp/svg/bmp
// asset 协议加载本地文件（不经前端读字节，符合性能红线）；适应窗/100%/Ctrl+滚轮缩放；
// 解码失败显示错误占位（007 规则）。

import { t } from '../common/i18n';
import { convertFileSrc } from '@tauri-apps/api/core';

export class ImageView {
  private host: HTMLElement;
  private path: string;
  private wrap!: HTMLDivElement;
  private img: HTMLImageElement | null = null;
  private fitMode: 'fit' | '100' | 'zoom' = 'fit';
  get displayMode() { return this.fitMode; }
  private scale = 1;
  private destroyed = false;
  private ctrlWheel?: (e: WheelEvent) => void;

  constructor(host: HTMLElement, path: string) {
    this.host = host;
    this.path = path;
  }

  async mount(): Promise<void> {
    this.host.innerHTML = '';
    this.wrap = document.createElement('div');
    this.wrap.className = 'img-view';
    this.host.appendChild(this.wrap);
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
    this.wrap.appendChild(img);
    img.addEventListener('load', () => {
      if (this.destroyed) return;
      this.applyFit();
      this.showInfo();
    });
    img.addEventListener('error', () => {
      if (this.destroyed) return;
      img.remove();
      this.img = null;
      this.showError(t('img.decodeFail'));
    });
    // Ctrl+滚轮缩放（与文本视图字号缩放同手势；无 Ctrl 不拦截，交给滚动）
    this.ctrlWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !this.img) return;
      e.preventDefault();
      this.fitMode = 'zoom';
      this.scale = clamp(this.scale * (e.deltaY < 0 ? 1.1 : 0.9), 0.05, 32);
      this.applyFit();
      this.showInfo();
    };
    this.wrap.addEventListener('wheel', this.ctrlWheel, { passive: false });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.ctrlWheel) this.wrap.removeEventListener('wheel', this.ctrlWheel);
    if (this.img) this.img.src = '';
    this.host.innerHTML = '';
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
    this.fitMode = 'zoom';
    this.scale = clamp(this.scale * factor, 0.05, 32);
    this.applyFit();
    this.showInfo();
  }

  /** Tauri 环境 convertFileSrc（asset 协议）；Web harness 回退（无本地文件，直接失败占位） */
  private async fileSrc(): Promise<string | null> {
    if (!('__TAURI_INTERNALS__' in window)) return null;
    return convertFileSrc(this.path);
  }

  private applyFit(): void {
    const img = this.img;
    if (!img) return;
    if (this.fitMode === 'fit') {
      img.style.width = '';
      img.style.height = '';
      img.classList.add('fit');
    } else {
      img.classList.remove('fit');
      const s = this.fitMode === '100' ? 1 : this.scale;
      // .img-canvas 自带 padding:24px（视觉留白）且全局 border-box——尺寸须 +48px 补偿，
      // 否则「100%」实际内容只有 natural 的 85%（F-031 走查根修）
      img.style.width = `${(img.naturalWidth || 100) * s + 48}px`;
      img.style.height = `${(img.naturalHeight || 100) * s + 48}px`;
    }
  }

  private showInfo(): void {
    let bar = this.wrap.querySelector<HTMLDivElement>('.img-info');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'img-info';
      const meta = document.createElement('span');
      meta.className = 'img-meta';
      const btn = document.createElement('button');
      btn.className = 'img-fitbtn';
      btn.textContent = t('img.fitToggle');
      btn.addEventListener('click', () => this.toggleFitMode());
      bar.append(meta, btn);
      this.wrap.appendChild(bar);
    }
    const img = this.img;
    const mode =
      this.fitMode === 'fit' ? t('img.modeFit') : this.fitMode === '100' ? t('img.mode100') : `${Math.round(this.scale * 100)}%`;
    bar.querySelector<HTMLSpanElement>('.img-meta')!.textContent = img
      ? `${img.naturalWidth}×${img.naturalHeight} · ${mode}`
      : mode;
  }

  private showError(msg: string): void {
    const box = document.createElement('div');
    box.className = 'img-err';
    box.textContent = msg;
    this.wrap.appendChild(box);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
