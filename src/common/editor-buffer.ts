import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { historyField } from '@codemirror/commands';
import { cmRestoreAnchor, type ScrollAnchor, type ScrollSurface, type CmRestoreOptions } from './scroll-anchor';

/** 同文件切换 Markdown 形态时搬运不可变源文档、选区与撤销栈，不经过序列化。 */
export interface EditorBuffer {
  state: EditorState;
  dirty: boolean;
  /** 旧口径像素位置：无 anchor 时的兜底（仅同形态有意义） */
  scrollTop: number;
  /** 跨形态位置锚（源码行 + 同形态快照）；有则优先 */
  anchor?: ScrollAnchor;
}

/** 挂载后还原缓冲位置：锚点交 CM6 在测量完成后执行（修前挂载即写像素 scrollTop，
 *  块高度还是估计值，随后实测纠正导致漂移；跨形态时像素更是毫无对应关系）。 */
export function restoreBufferScroll(view: EditorView, buffer: EditorBuffer | undefined, surface: ScrollSurface, options?: CmRestoreOptions): void {
  if (!buffer) return;
  if (buffer.anchor) cmRestoreAnchor(view, buffer.anchor, surface, options);
  else view.scrollDOM.scrollTop = buffer.scrollTop;
}

export function bufferHistory(buffer?: EditorBuffer): Extension {
  return buffer ? historyField.init(() => buffer.state.field(historyField)) : [];
}

/** 只读同时约束用户输入和程序化事务；重配置本身不触碰文档及历史。 */
export class ReadOnlyControl {
  private compartment = new Compartment();
  enabled: boolean;
  constructor(enabled = false) { this.enabled = enabled; }
  private config(): Extension {
    return [EditorState.readOnly.of(this.enabled), EditorView.editable.of(!this.enabled),
      EditorState.transactionFilter.of(tr => this.enabled && tr.docChanged ? [] : tr)];
  }
  extension(): Extension { return this.compartment.of(this.config()); }
  set(view: EditorView | undefined, enabled: boolean): void {
    this.enabled = enabled;
    view?.dispatch({ effects: this.compartment.reconfigure(this.config()) });
  }
}
