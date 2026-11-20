// docx-rich —— Word 富预览（批 5）：docx-preview 渲染，失败回退文本投影。
// 模块经动态 import 挂载（app.ts 照 csv 模块模式），docx-preview 本身再动态 import
// ——仅预览模式加载，不进主 bundle。字节走 zasset 协议（照 pdf-view/engine.ts）。
// 守护：>100MiB 直接回退（与 Rust 包上限对齐）；渲染超时（20s）回退并如实提示。
import { t, tf } from '../common/i18n';
import { fileStat, zassetUrl } from '../common/ipc';

export const DOCX_RICH_MAX_BYTES = 100 * 1024 * 1024;
export const DOCX_RICH_RENDER_TIMEOUT_MS = 20_000;

/** docx-preview 渲染选项（0.4.x）：分页外观 + 正文宽度包装 */
interface RenderOptions {
  inWrapper: boolean;
  ignoreWidth: boolean;
  ignoreHeight: boolean;
  [key: string]: unknown;
}

type RenderModule = {
  renderAsync: (
    data: ArrayBuffer | Blob,
    bodyContainer: HTMLElement,
    styleContainer?: HTMLElement,
    options?: RenderOptions,
  ) => Promise<unknown>;
};

export class RichDocxView {
  private controller?: AbortController;
  private generation = 0;
  private destroyed = false;
  constructor(
    private host: HTMLElement,
    private path: string,
    private onFallbackToText: (path: string, reason: string) => void,
    private onNotice?: (msg: string) => void,
  ) {}

  /** 同类型改名后只换路径，已渲染的文档不重载。 */
  adoptPath(path: string): void {
    this.path = path;
  }

  async mount(): Promise<void> {
    if (this.destroyed) return;
    this.release();
    const generation = ++this.generation;
    const controller = (this.controller = new AbortController());
    const wrap = document.createElement('div');
    wrap.className = 'docx-rich';
    const status = document.createElement('div');
    status.className = 'docx-rich-loading';
    status.setAttribute('role', 'status');
    status.textContent = t('docxRich.loading');
    wrap.append(status);
    this.host.replaceChildren(wrap);
    try {
      const stat = await fileStat(this.path);
      if (!this.current(generation)) return;
      if (stat.len > DOCX_RICH_MAX_BYTES) {
        this.fallback(tf('docxRich.tooLarge', (stat.len / 1048576).toFixed(0)));
        return;
      }
      const response = await fetch(zassetUrl(this.path), { signal: controller.signal });
      if (!response.ok) throw new Error('DOCX HTTP ' + response.status);
      const bytes = await response.arrayBuffer();
      if (!this.current(generation)) return;
      // 动态加载（仅预览模式进内存；分包由 vite 处理）
      const mod = (await import('docx-preview')) as unknown as RenderModule;
      if (!this.current(generation)) return;
      const scroll = document.createElement('div');
      scroll.className = 'docx-rich-scroll';
      const pageHost = document.createElement('div');
      pageHost.className = 'docx-rich-pages';
      scroll.append(pageHost);
      wrap.replaceChildren(scroll);
      // 超时守护：renderAsync 无中止信号——超时即放弃宿主（回退路径重建视图），
      // 迟到的写入随宿主 detach 一起废弃。
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('DOCX_RICH_TIMEOUT')), DOCX_RICH_RENDER_TIMEOUT_MS);
      });
      await Promise.race([
        mod.renderAsync(bytes, pageHost, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: true,
        }),
        timeout,
      ]);
      if (!this.current(generation)) return;
      this.onNotice?.(t('docxRich.scope'));
    } catch (error) {
      if (!this.current(generation)) return;
      const msg = String(error instanceof Error ? error.message : error);
      if (msg === 'DOCX_RICH_TIMEOUT') this.fallback(t('docxRich.timeout'));
      else this.fallback(msg);
    }
  }

  private fallback(reason: string): void {
    if (this.destroyed) return;
    this.onFallbackToText(this.path, reason);
  }

  private current(generation: number): boolean {
    return !this.destroyed && generation === this.generation;
  }

  private release(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  destroy(): void {
    this.release();
    this.destroyed = true;
    ++this.generation;
    this.host.innerHTML = '';
  }
}
