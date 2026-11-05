// 完整 Markdown 原生验收矩阵；串行运行，保留失败样本，禁止同时编译或运行其他性能门禁。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT, RUN_DIR, EXE, readDisplayEnvironment } from './gate-lib.mjs';
import { resetGateState } from './gate-state.mjs';

const output = path.resolve(process.argv[2] ?? path.join(RUN_DIR, 'results/md-matrix'));
const corpus = path.join(RUN_DIR, 'corpus');
const names = ['mixed-100k', 'dense-2m', 'plain-1m', 'plain-100k', 'plain-400k', 'plain-2m', 'plain-4m',
  'repeated-6001', 'single-heading-tail', 'metadata', 'single-code-1m', 'single-js-1m', 'single-table-400k'];
for (const name of names) if (!fs.existsSync(path.join(corpus, name + '.md'))) throw new Error('Missing corpus: ' + name);
if (!fs.existsSync(EXE)) throw new Error('Native application not built: ' + EXE);
fs.mkdirSync(output, { recursive: true });
const matrix = { verdict: false, display: await readDisplayEnvironment(), webviewEnvironment: null, results: [] };
const save = () => fs.writeFileSync(path.join(output, 'matrix.json'), JSON.stringify(matrix, null, 2));
async function run(name, script, args, before = false) {
  console.log('START ' + name + ' ' + new Date().toISOString());
  const report = path.join(output, name + '.json'), log = fs.openSync(path.join(output, name + '.log'), 'w');
  const displayBefore = await readDisplayEnvironment();
  let exitCode;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'native-gate-build/src-tauri/tauri.conf.json'), 'utf8'));
    const state = resetGateState(config.identifier, RUN_DIR);
    matrix.currentState = state;
    exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(REPO_ROOT, 'tests/gates', script), ...args(report)], {
        cwd: REPO_ROOT, env: { ...process.env, ZIEDIT_GATE_EXE: before ? process.env.ZIEDIT_GATE_BEFORE_EXE : EXE },
        windowsHide: true, stdio: ['ignore', log, log],
      });
      child.once('exit', resolve); child.once('error', reject);
    });
    if (script === 'gate-scroll-position.mjs') fs.copyFileSync(path.join(RUN_DIR, 'results/gate-scroll-position.json'), report);
    const data = JSON.parse(fs.readFileSync(report, 'utf8'));
    const displayAfter = await readDisplayEnvironment();
    const displayChanged = JSON.stringify(displayBefore) !== JSON.stringify(matrix.display)
      || JSON.stringify(displayAfter) !== JSON.stringify(matrix.display);
    // 显示设备列表不一定暴露远程缩放变化；逐份原生报告再核对实际 WebView 的 DPR 与 GPU。
    const environments = data.environment ? [data.environment] : (data.rounds ?? []).map(round => round.environment).filter(Boolean);
    let webviewChanged = false;
    for (const environment of environments) {
      const actual = { scale: environment.scale, gpu: environment.gpu, width: environment.width, height: environment.height, userAgent: environment.userAgent };
      if (!actual.gpu || !Number.isFinite(actual.scale) || actual.scale <= 0) { webviewChanged = true; continue; }
      if (!matrix.webviewEnvironment) matrix.webviewEnvironment = actual;
      else if (JSON.stringify(actual) !== JSON.stringify(matrix.webviewEnvironment)) webviewChanged = true;
    }
    matrix.results.push({ name, before, exitCode, displayBefore, displayAfter, displayChanged, webviewChanged,
      webviewEnvironments: environments,
      verdict: exitCode === 0 && data.verdict === true && !displayChanged && !webviewChanged,
      report, sha256: data.sha256, firstReadableMs: data.firstReadableMs,
      ir: data.summary, failReasons: data.rounds?.[0]?.failReasons,
      modes: data.modes?.map(mode => ({ mode: mode.mode, frames: mode.interactionFrames,
        settleFrames: mode.frames, responseP95: mode.responseP95, drift: mode.settle?.maxDrift, failures: mode.failures })),
      errors: data.errors ?? data.fatal });
  } catch (error) { matrix.results.push({ name, before, exitCode, verdict: false, error: String(error) }); }
  finally { fs.closeSync(log); save(); }
  console.log(JSON.stringify(matrix.results.at(-1)));
}
for (const name of names) await run(name, 'gate-md-surfaces.mjs', report => [path.join(corpus, name + '.md'), report]);
await run('position', 'gate-scroll-position.mjs', () => []);
await run('editing', 'gate-md-editing.mjs', report => [report]);
await run('navigation', 'gate-md-navigation.mjs', report => [path.join(corpus, 'repeated-6001.md'), report]);
await run('early-input', 'gate-md-early-input.mjs', report => [path.join(corpus, 'dense-2m.md'), report]);
for (const name of ['mixed-100k', 'dense-2m']) await run('ir-' + name, 'gate-ir-scroll.mjs', report => [path.join(corpus, name + '.md'), report]);
if (process.env.ZIEDIT_GATE_BEFORE_EXE) for (const name of ['plain-1m', 'mixed-100k'])
  await run('before-' + name, 'gate-md-surfaces.mjs', report => [path.join(corpus, name + '.md'), report], true);
matrix.verdict = matrix.results.filter(result => !result.before).every(result => result.verdict);
matrix.displayEnd = await readDisplayEnvironment();
matrix.displayChanged = JSON.stringify(matrix.display) !== JSON.stringify(matrix.displayEnd)
  || matrix.results.some(result => result.displayChanged || result.webviewChanged) || !matrix.webviewEnvironment;
if (matrix.displayChanged) matrix.verdict = false;
save(); process.exitCode = matrix.verdict ? 0 : 1;
