import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';

export const compositionChanged = StateEffect.define<boolean>();
/** 主文档也能感知嵌入单元格的组合输入，块装饰在此期间只映射位置。 */
export const compositionActive = StateField.define<boolean>({
  create: () => false,
  update(active, tr) {
    for (const effect of tr.effects) if (effect.is(compositionChanged)) active = effect.value;
    return active;
  },
});
const living = new WeakSet<EditorView>();
const owners = new WeakMap<EditorView, EditorView>();

export function isComposing(view: EditorView): boolean {
  return view.compositionStarted || !!view.state.field(compositionActive, false);
}

/** 捕获阶段的全局命令同样避开候选键；229 兼容未正确设置 isComposing 的 WebView。 */
export function isCompositionKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229
    || (typeof Element !== 'undefined' && event.target instanceof Element && !!event.target.closest('[data-ziedit-composing]'));
}

/** 保护原生 IME 的 DOM；结束延至当前事件和 CM 的 MutationObserver 提交之后。 */
export function compositionGuard(main?: EditorView, settled?: () => void): Extension {
  return [compositionActive, ViewPlugin.define(view => {
    const target = main ?? view;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = false;
    living.add(view);
    const belongs = (event: Event) => event.target instanceof Element
      && event.target.closest('.cm-content') === view.contentDOM;
    const change = (editor: EditorView, on: boolean) => {
      if (!living.has(editor)) return;
      editor.contentDOM.toggleAttribute('data-ziedit-composing', on);
      editor.dispatch({ effects: compositionChanged.of(on), annotations: isolateHistory.of('full') });
    };
    const start = (event: Event) => {
      if (!belongs(event) || (active && timer === undefined)) return;
      clearTimeout(timer);
      timer = undefined;
      active = true;
      owners.set(target, view);
      change(view, true);
      if (target !== view) change(target, true);
    };
    const finish = () => {
      timer = undefined;
      if (!active) return;
      active = false;
      change(view, false);
      if (owners.get(target) === view) {
        owners.delete(target);
        if (target !== view) change(target, false);
      }
      if (living.has(view)) settled?.();
    };
    const end = (event: Event) => {
      if (!belongs(event) || !active) return;
      clearTimeout(timer);
      timer = setTimeout(finish, 0);
    };
    const key = (event: KeyboardEvent) => {
      // 不 preventDefault：候选选择仍交给输入法，只隔离 CM 和应用键位处理器。
      if (belongs(event) && (active || isCompositionKey(event))) event.stopImmediatePropagation();
    };
    view.contentDOM.addEventListener('compositionstart', start, true);
    view.contentDOM.addEventListener('compositionend', end, true);
    view.contentDOM.addEventListener('blur', end, true);
    view.contentDOM.addEventListener('keydown', key, true);
    return { destroy() {
      living.delete(view);
      clearTimeout(timer);
      view.contentDOM.removeAttribute('data-ziedit-composing');
      view.contentDOM.removeEventListener('compositionstart', start, true);
      view.contentDOM.removeEventListener('compositionend', end, true);
      view.contentDOM.removeEventListener('blur', end, true);
      view.contentDOM.removeEventListener('keydown', key, true);
      // 宿主销毁可能发生在更新中；只清理仍存活的主文档，不重入其事务。
      if (active && target !== view) queueMicrotask(finish);
    } };
  })];
}
