import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { historyField } from '@codemirror/commands';

/** 同文件切换 Markdown 形态时搬运不可变源文档、选区与撤销栈，不经过序列化。 */
export interface EditorBuffer {
  state: EditorState;
  dirty: boolean;
  scrollTop: number;
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
