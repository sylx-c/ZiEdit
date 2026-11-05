/** 连续输入也拥有优先权；默认 isInputPending() 不包含滚轮和触摸移动。 */
export function hasPendingInput(): boolean {
  if (typeof navigator === 'undefined') return false;
  const scheduling = (navigator as { scheduling?: { isInputPending?: (options: { includeContinuous: boolean }) => boolean } }).scheduling;
  return scheduling?.isInputPending?.({ includeContinuous: true }) ?? false;
}
