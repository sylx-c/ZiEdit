import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { boundCodeMirrorParser, codeMirrorParserBudget } from '../scripts/codemirror-parser-budget.mjs';

it('bounds the locked CodeMirror background parser while leaving initial and editing budgets intact', () => {
  const source = readFileSync(new URL('../node_modules/@codemirror/language/dist/index.js', import.meta.url), 'utf8');
  const result = boundCodeMirrorParser(source);
  expect(result).toBe(source.replace('100 /* Work.Slice */', '8 /* Work.Slice */').replace('25 /* Work.MinSlice */', '8 /* Work.MinSlice */'));
  expect(result).toContain('20 /* Work.Apply */');
  expect(result).toContain('100000 /* Work.MaxParseAhead */');
  expect(codeMirrorParserBudget().transform(source, 'E:\\app\\node_modules\\@codemirror\\language\\dist\\index.js')?.code).toBe(result);
  expect(codeMirrorParserBudget().transform(source, '/app/node_modules/@codemirror/language/dist/index.js?v=cache')?.code).toBe(result);
  expect(codeMirrorParserBudget().transform(source, '/app/src/language.js')).toBeUndefined();
});

it('rejects changed or ambiguous dependency code instead of silently restoring a long background slice', () => {
  expect(() => boundCodeMirrorParser('different version')).toThrow('source changed');
  expect(() => boundCodeMirrorParser('100 /* Work.Slice */ 100 /* Work.Slice */ 25 /* Work.MinSlice */')).toThrow('source changed');
});
