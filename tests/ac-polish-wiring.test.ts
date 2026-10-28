import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async (command: string) => {
  if (command === 'docx_open') return { paraCount: 2, totalChars: 8, truncated: false };
  if (command === 'docx_lines') return { lines: [{ no: 1, text: '正文' }], total: 2 };
  if (command === 'xlsx_open') return { sheets: [{ name: '第一表', rows: 1 }], truncated: false };
  if (command === 'xlsx_records') return { records: [{ no: 1, cells: ['值'] }], total: 1 };
}) }));
import { invoke } from '@tauri-apps/api/core';
import { docxOpen, docxLines, xlsxOpen, ooxmlClose, DEFAULT_SETTINGS } from '../src/common/ipc';
import { xlsxRecordProvider } from '../src/csv-view/table';
import { closeActionFor } from '../src/shell/autosave';

const app = readFileSync('src/shell/app.ts', 'utf8');
const text = readFileSync('src/text-view/view.ts', 'utf8');
describe('打磨接线', () => {
  it('OOXML 分派与窗口提供器', async () => {
    expect(app).toContain("if (tab.language === 'Docx' || tab.language === 'Pdf') return 'view'");
    expect(app).toContain("if (tab.language === 'Xlsx') return 'csv'");
    expect((await docxOpen('a.docx')).paraCount).toBe(2);
    expect((await docxLines('a.docx', 1, 2)).lines[0].text).toBe('正文');
    expect((await xlsxOpen('a.xlsx')).sheets[0].name).toBe('第一表');
    const provider = xlsxRecordProvider(1);
    expect(provider.supportsSource).toBe(false);
    expect(provider.supportsDelimiter).toBe(false);
    expect((await provider.records('a.xlsx', 1, 40, '', '')).records[0].cells).toEqual(['值']);
    expect(invoke).toHaveBeenCalledWith('xlsx_records', { path: 'a.xlsx', sheet: 1, from: 1, to: 40 });
    expect(text).toContain("pdfOpen : docxOpen)(this.path)");
    expect(text).toContain('docxLines(path, from, to)');
  });
  it('只读动作与关闭释放共用装配点', async () => {
    expect(app).toContain("!['Docx', 'Xlsx', 'Pdf'].includes(activeTab()?.language ?? '')");
    expect(app).toContain("def.id === 'file.saveAs' || def.id === 'tbcsv.delim'");
    expect(app).toContain('void ooxmlClose(t.path)');
    await ooxmlClose('a.docx');
    expect(invoke).toHaveBeenCalledWith('ooxml_close', { path: 'a.docx' });
  });
  it('关闭自动保存两路径及失败阻断', () => {
    expect(DEFAULT_SETTINGS.closeAutoSave).toBe(false);
    expect(closeActionFor(true, false)).toBe('confirm');
    expect(closeActionFor(true, true)).toBe('save');
    expect(closeActionFor(true, true, false)).toBe('abort');
    expect(closeActionFor(true, true, true)).toBe('close');
    expect(app).toContain('closeActionFor(dirty, settings.closeAutoSave)');
    expect(app).toContain('closeActionFor(true, true, await saveDirtyTab(tab.path))');
  });
  it('备份卡片含设置开关并保存', () => {
    expect(app).toContain("$t('settings.closeAutoSave')");
    expect(app).toContain("rowCloseAutoSave.className = 'set-row'");
    expect(app).toContain('closeAutoSave: closeAutoSaveCb.checked');
    expect(app).toContain("card('set.grpBackup', row2, rowTarget, rowSnapDir, rowCloseAutoSave");
  });
});
