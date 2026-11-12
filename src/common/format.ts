// format —— 展示用格式化共享工具（批 4 代码卫生：收编 app.ts 与 compare-view 各一份的 fmtSize）

/** 字节数 → 人类可读尺寸（B/KB/MB/GB，1024 进制，一位小数）。状态栏/对比元信息/恢复列表共用。 */
export function fmtSize(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}