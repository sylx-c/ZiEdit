// ac-013 —— Office 查看增强（批 2：Excel 显示值 + 公式开关；源码契约锁）
// 判据（总目标 2/5）：Excel 日期列按显示值呈现（不再有序列数 45292 假差异）；
// xlsm 公式可切换显示（"=公式" 编辑栏口径）；.xls/.xlsb/.ods 家族可打开查看。
// Rust 内核侧的值口径/哨兵/路由由 ac-008 批 2 节与 src-tauri 内联单测锁定，
// 本文件锁前端装配：记录源参数透传、页签旁公式开关、i18n、打开范围提示。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dict } from '../src/common/i18n';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

describe('ac-013 批 2：Excel 显示值查看与公式开关', () => {
  const tableSrc = read('src/csv-view/table.ts');
  const appSrc = read('src/shell/app.ts');
  const ipcSrc = read('src/common/ipc.ts');
  const ooxmlRs = read('src-tauri/src/commands/ooxml.rs');

  it('xlsxRecordProvider 增参：formulas 开关透传到 xlsx_records 命令', () => {
    expect(tableSrc).toContain('export function xlsxRecordProvider(sheet = 0, formulas = false)');
    expect(tableSrc).toContain('ipc.xlsxRecords(path, sheet, from, to, formulas)');
    expect(ipcSrc).toContain(
      "invoke<XlsxRecordsResult>('xlsx_records', { path, sheet, from, to, formulas"
    );
    // 后端命令可选参数（向后兼容）：缺省 null → 显示值
    expect(ooxmlRs).toContain('formulas: Option<bool>');
    expect(ooxmlRs).toContain('window_records(target, from, to, formulas)');
  });

  it('页签旁公式开关：切换重挂当前 sheet，xlsxRecordProvider 带开关重建', () => {
    expect(appSrc).toContain("xlsxRecordProvider(sheet, formulas)");
    expect(appSrc).toContain("$t('csv.formulaToggle')");
    // 开关状态在闭包内持久，sheet 切换沿用当前口径
    expect(appSrc).toMatch(/let formulas = false;[\s\S]*?const remount/);
  });

  it('显示值口径如实提示：范围说明更新（日期/百分比按格式渲染、公式可切换）', () => {
    const zh = dict('zh-CN')['ooxml.xlsxScope'];
    const en = dict('en-US')['ooxml.xlsxScope'];
    expect(zh).toContain('显示值');
    expect(en).toContain('displayed values');
  });

  it('i18n 两语齐全：公式开关与提示', () => {
    for (const k of ['csv.formulaToggle', 'csv.formulaToggleTitle']) {
      expect(dict('zh-CN')[k], `zh ${k}`).toBeTruthy();
      expect(dict('en-US')[k], `en ${k}`).toBeTruthy();
    }
  });

  it('xlsx_open 契约扩展：is1904 如实上报（前端可后续提示，旧字段不动）', () => {
    const xlsxRs = read('src-tauri/src/ooxml/xlsx.rs');
    expect(ipcSrc).toContain('is1904?: boolean');
    expect(xlsxRs).toContain('pub is_1904: bool');
  });
});
