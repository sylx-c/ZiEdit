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

  it('批 4：pptx 可看可对比（Docx 同管线路由 + 数字序幻灯片投影）', () => {
    const kindRs = read('src-tauri/src/kind_detect/mod.rs');
    const officeRs = read('src-tauri/src/compare/office.rs');
    const docxRs = read('src-tauri/src/ooxml/docx.rs');
    expect(kindRs).toContain('"pptx" | "dps" => "Pptx"');
    expect(officeRs).toMatch(/"odt" \| "pptx" \| "wps" \| "dps"/);
    expect(docxRs).toContain('fn open_pptx');
    expect(docxRs).toContain('PPTX_SLIDE_LIMIT:512');
    // pptx 移出二进制黑名单（可打开可对比）
    const binaryFn = kindRs.slice(kindRs.indexOf('fn is_binary_ext'), kindRs.indexOf('/// 快速识别'));
    expect(binaryFn).not.toContain('"pptx"');
    // 视图走 Docx 同管线（app.ts/text-view 含 Pptx 分支）
    expect(appSrc).toContain("tab.language === 'Pptx'");
    expect(read('src/text-view/view.ts')).toContain("'Pptx'");
    expect(dict('zh-CN')['ooxml.pptxScope']).toBeTruthy();
    expect(dict('en-US')['ooxml.pptxScope']).toBeTruthy();
  });

  it('批 4：.wps/.et/.dps——OOXML 内容路由尝试，OLE 私有包给另存为指引哨兵', () => {
    const ooxmlMod = read('src-tauri/src/ooxml/mod.rs');
    expect(ooxmlMod).toContain('pub fn reject_legacy_wps');
    expect(ooxmlMod).toContain('WPS_LEGACY_PACKAGE');
    const viewSrc = read('src/compare-view/view.ts');
    expect(viewSrc).toMatch(/legacyOfficeHint' : 'cmp\.binaryRouted/);
    expect(dict('zh-CN')['cmp.legacyOfficeHint']).toContain('另存为');
    expect(dict('en-US')['cmp.legacyOfficeHint']).toContain('save as');
  });

  it('批 5：Word 默认富预览（docx-preview）+ 失败回退文本投影 + 守护', () => {
    const kindRs = read('src-tauri/src/kind_detect/mod.rs');
    const richSrc = read('src/docx-rich/view.ts');
    const stateSrc = read('src/common/state.ts');
    const capsSrc = read('src/shell/view-capabilities.ts');
    expect(kindRs).toContain('ViewRoute::Rich');
    expect(kindRs).toContain('matches!(ext.as_str(), "docx" | "docm" | "dotx" | "dotm")');
    expect(kindRs).toMatch(/ViewRoute::Image \| ViewRoute::Pdf \| ViewRoute::Rich => Ok\(fast\)/);
    expect(richSrc).toContain('DOCX_RICH_MAX_BYTES = 100 * 1024 * 1024');
    expect(richSrc).toContain('DOCX_RICH_RENDER_TIMEOUT_MS = 20_000');
    expect(richSrc).toContain("await import('docx-preview')");
    expect(richSrc).toContain('zassetUrl(this.path)');
    expect(richSrc).toContain('onFallbackToText');
    expect(appSrc).toContain("tab.route === 'rich'");
    expect(appSrc).toMatch(/setRoute\(path, 'text'\)/);
    expect(appSrc).toContain("isWordOoxmlPath(t.path)) store.setRoute(t.path, 'rich')");
    expect(stateSrc).toContain("t.route === 'rich'");
    expect(capsSrc).toContain('rich: { ...COMMON }');
    for (const k of ['docxRich.loading', 'docxRich.fallback', 'docxRich.tooLarge', 'docxRich.timeout', 'docxRich.scope', 'act.richDocx']) {
      expect(dict('zh-CN')[k], 'zh ' + k).toBeTruthy();
      expect(dict('en-US')[k], 'en ' + k).toBeTruthy();
    }
  });
});
