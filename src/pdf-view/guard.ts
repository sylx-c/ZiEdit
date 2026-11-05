// (2026-10-29 ac-011) 与 src-tauri/src/ooxml/mod.rs 的 100MiB 产品阈值对齐。
export const PDF_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const PDF_MAX_PAGE_PIXELS = 16_700_000;
export const PDF_MAX_SIDE = 8192;
export const CANVAS_BUDGET_BYTES = 256 * 1024 * 1024;
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
export const shouldGuardFile = (sizeBytes: number): boolean => sizeBytes > PDF_MAX_FILE_BYTES;
export const shouldWarnPages = (n: number): boolean => n > 2000;
/** 预算含已显示、预渲染和在途 canvas；调用方在排队时即登记。 */
export function remainingCanvasBytes(allocations: readonly { width: number; height: number }[]): number {
  return Math.max(0, CANVAS_BUDGET_BYTES - allocations.reduce((sum, page) => sum + page.width * page.height * 4, 0));
}
export function clampScale(baseW: number, baseH: number, scale: number, dpr: number): number {
  if (![baseW, baseH, scale, dpr].every(n => Number.isFinite(n) && n > 0)) return 0;
  return Math.min(scale, ZOOM_MAX, PDF_MAX_SIDE / (Math.max(baseW, baseH) * dpr),
    Math.sqrt(PDF_MAX_PAGE_PIXELS / (baseW * baseH)) / dpr);
}
