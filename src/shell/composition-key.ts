// shell 侧组合输入按键判定：
// 与 common/composition.ts 的 isCompositionKey 同源同义。该模块还定义 CM 组合态字段
// （compositionActive/compositionGuard，静态依赖 @codemirror），shell 若从那里导入会把
// CodeMirror 拖回首屏 chunk——故 shell 内联此纯函数副本；composition 拆分后应回收合并。
export function isCompositionKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229
    || (typeof Element !== 'undefined' && event.target instanceof Element && !!event.target.closest('[data-ziedit-composing]'));
}
