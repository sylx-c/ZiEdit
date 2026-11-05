// close-behavior —— 关闭按钮行为判决纯函数（ADR 015 / 002 规则 29）。
// 纯函数无 DOM / IPC 依赖，便于单测（tests/ac-002-close-behavior.test.ts）。
// 生效口径单一出口：ask 且有记忆 → 记忆值；ask 无记忆 → 仍 ask（弹选择框）；固定值原样。

export type CloseBehaviorSetting = 'ask' | 'exit' | 'tray';
/** ask 判决后的实际动作（rememberedCloseAction 只在 closeBehavior='ask' 时生效，ADR 015 §3.1） */
export type EffectiveCloseAction = 'ask' | 'exit' | 'tray';

export function effectiveCloseAction(
  closeBehavior: CloseBehaviorSetting | undefined,
  rememberedCloseAction: 'exit' | 'tray' | undefined,
): EffectiveCloseAction {
  if (closeBehavior === 'exit' || closeBehavior === 'tray') return closeBehavior;
  // 缺省 ask（DEFAULT_SETTINGS.closeBehavior='ask'）；非法值同样回落 ask
  return rememberedCloseAction ?? 'ask';
}
