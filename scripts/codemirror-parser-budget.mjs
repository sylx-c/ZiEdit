/** @codemirror/language 6.13.1 没有公开的后台解析预算配置。
 * 保留其调度、增量解析与状态发布，只收紧不可配置的单片时限。
 * 升级后必须重新核对源码；匹配缺失或重复时拒绝构建，不能静默漏补。
 */
export function boundCodeMirrorParser(code) {
  for (const [before, after] of [
    ['100 /* Work.Slice */', '8 /* Work.Slice */'],
    ['25 /* Work.MinSlice */', '8 /* Work.MinSlice */'],
  ]) {
    if (code.split(before).length !== 2) throw new Error('CodeMirror parser budget source changed: ' + before);
    code = code.replace(before, after);
  }
  return code;
}

export function codeMirrorParserBudget() {
  return {
    name: 'codemirror-parser-budget',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?', 1)[0].replaceAll('\\', '/').endsWith('/@codemirror/language/dist/index.js')) return;
      return { code: boundCodeMirrorParser(code), map: null };
    },
  };
}
