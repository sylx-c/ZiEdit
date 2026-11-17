// gate-office-smoke.mjs —— Office 功能冒烟（批 2/5/6 验收）：xlsx 显示值 + 公式开关、
// docx 富预览真实渲染。夹具复用 release-fixtures（完整 OPC xlsx 含日期/百分比/公式格）。
// 差异清单/双表/修订报告在对比视图内，需双文件对话框选择，无法经文件参数直达——
// 由 cargo 199 + vitest 1402 契约覆盖（见 docs/changes/office-compare-batch6-closeout.md）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { releaseFixtures } from './release-fixtures.mjs';
import { EXE, RUN_DIR, waitTargets, connectCDP, waitFor, dismissOverlay, killTree, clickXY } from './gate-lib.mjs';

const output = path.resolve(process.argv[2]);
const dir = path.join(RUN_DIR, 'files', 'office-smoke');
const files = releaseFixtures(dir);
const report = { verdict: false, checks: [], errors: [] };
const save = () => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); };
const check = (name, pass, detail) => { report.checks.push({ name, pass, detail }); save(); console.log((pass ? 'PASS' : 'FAIL') + ' ' + name); if (!pass) throw new Error(name + ': ' + JSON.stringify(detail)); };
const child = spawn(EXE, [files.xlsx], { stdio: 'ignore', windowsHide: true,
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(RUN_DIR, 'profiles', 'office-smoke') } });
let cdp;
const VT = "document.querySelector('#viewarea')?.textContent ?? ''";
const viewText = () => cdp.evaluate(VT);
async function clickButtonByText(text) {
  const rect = await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(text)} && b.offsetParent !== null); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!rect) throw new Error('button not found: ' + text);
  await clickXY(cdp, rect.x, rect.y);
}
try {
  cdp = await connectCDP((await waitTargets(60000)).webSocketDebuggerUrl);
  await waitFor(cdp, `!!document.querySelector('.csv-cell')`, 60000);
  await dismissOverlay(cdp);
  // 1) 显示值口径：日期 45292 → 2024-01-01；百分比 0.4512 → 45.12%；不再有序列数原文
  await waitFor(cdp, `(${VT}).includes('2024-01-01')`, 30000);
  check('xlsx 日期按显示值渲染（45292 → 2024-01-01）', true);
  const text1 = String(await viewText());
  check('xlsx 百分比按显示值渲染（0.4512 → 45.12%）', text1.includes('45.12%'), { text: text1.slice(0, 200) });
  check('xlsx 无序列数假差异原文（45292 不出现）', !text1.includes('45292'), {});
  // 2) 公式开关：值 → =B1*2 → 切回值
  await clickButtonByText('公式');
  await waitFor(cdp, `(${VT}).includes('=B1*2')`, 30000);
  check('公式开关切换到 =公式（B1*2 编辑栏口径）', true);
  await clickButtonByText('公式');
  await waitFor(cdp, `!(${VT}).includes('=B1*2')`, 30000);
  check('公式开关切回显示值', true);
  // 3) sheet 页签按钮存在（remount 后按钮在 mount().then(installSheets) 里迟到补挂——必须 waitFor）
  await waitFor(cdp, `[...document.querySelectorAll('button')].some(b => b.textContent === '首表')`, 30000);
  check('sheet 页签呈现', true);
  // 4) docx 富预览：默认 rich 路由，分页容器真实渲染文档文本
  const opener = spawn(EXE, [files.docx], { stdio: 'ignore', windowsHide: true }); opener.unref();
  await waitFor(cdp, `!!document.querySelector('.docx-rich-pages .docx-wrapper')`, 60000);
  await waitFor(cdp, `(${VT}).includes('ZiEdit 中文 Office')`, 30000);
  check('docx 默认富预览渲染（分页容器 + 文档文本）', true);
  report.verdict = true; save();
} catch (error) {
  report.errors.push(String(error)); save(); console.error('FAIL', error);
} finally {
  try { await killTree(child.pid); } catch { /* 已退出 */ }
  if (!report.verdict) process.exitCode = 1;
}
