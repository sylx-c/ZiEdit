import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, historyField, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { bufferHistory, snapshotEditorBufferState } from './editor-buffer';

describe('snapshotEditorBufferState', () => {
  it('keeps document, multiple selections, and undo history without view extensions', () => {
    let state = EditorState.create({
      doc: 'before',
      extensions: [history(), EditorState.allowMultipleSelections.of(true), EditorView.updateListener.of(() => {})],
    });
    state = state.update({
      changes: { from: 6, insert: ' after' },
      selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.range(7, 12)], 1),
    }).state;

    const snapshot = snapshotEditorBufferState(state);
    expect(snapshot.doc).toBe(state.doc);
    expect(snapshot.selection.eq(state.selection)).toBe(true);
    expect(snapshot.selection.ranges).toHaveLength(2);
    expect(undoDepth(snapshot)).toBe(1);
    expect(snapshot.field(historyField)).toBe(state.field(historyField));
    expect(snapshot.facet(EditorView.updateListener)).toEqual([]);
  });

  it('restores both history branches across repeated remounts', () => {
    let state = EditorState.create({ doc: 'before', extensions: history() });
    state = state.update({ changes: { from: 6, insert: ' after' }, selection: { anchor: 12 } }).state;
    const baselineStart = state;
    const dispatch = (tr: Transaction) => { state = tr.state; };
    const remount = () => {
      const buffer = { state: snapshotEditorBufferState(state), dirty: true, scrollTop: 0 };
      state = EditorState.create({
        doc: buffer.state.doc,
        selection: buffer.state.selection,
        extensions: [history(), bufferHistory(buffer)],
      });
    };
    for (let i = 0; i < 12; i++) remount();
    expect(undo({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe('before');
    remount();
    expect(redoDepth(state)).toBe(1);
    expect(redo({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe('before after');
    let baseline = baselineStart;
    const baselineDispatch = (tr: Transaction) => { baseline = tr.state; };
    expect(undo({ state: baseline, dispatch: baselineDispatch })).toBe(true);
    expect(redo({ state: baseline, dispatch: baselineDispatch })).toBe(true);
    expect(state.doc.eq(baseline.doc)).toBe(true);
    expect(state.selection.eq(baseline.selection)).toBe(true);
  });
});
