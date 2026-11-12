// fontSize —— 字号钳制共享工具（批 4 代码卫生：收编 6+ 处手写 10–18 钳制）
// 10–18px 为设置/各视图统一字号域（001 规则 31 持久化）；取整后钳制，与设置面板同口径。

/** 任意数值 → 取整并钳到 [10,18]px。滚轮步进/parseInt 结果已是整数，Math.round 对其为恒等。 */
export function clampFontSize(n: number): number {
  return Math.min(18, Math.max(10, Math.round(n)));
}