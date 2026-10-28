// run-all.mjs — CDP 门禁统一入口：串行跑指定门禁集，汇总各 verdict 出总表 JSON
// 用法: node tests/gates/run-all.mjs [门禁...] [--corpus <md>] [--out <dir>] [其他 -- 旗标透传给各门禁]
// 门禁集：ac36 | arrow | scroll | ir-scroll | phys-ab | walk-f | writing（默认 ac36+arrow+scroll+ir-scroll+walk-f）
// --corpus：语料路径（默认 RUN_DIR/corpus/dense-2m.md，需先 node tests/gates/gen-corpus.mjs 生成）
// --out   ：结果目录（默认 RUN_DIR/results），总表写 <out>/run-all-summary.json
// 其余 -- 开头参数原样透传（如 --enrich 给 scroll、--human 给 phys-ab）
// 约定：单门禁失败不中断后续；任一失败/异常最终退出码非 0。构建与运行前置见 README（隔离构建 + 语料再成）。
// 不自动生成语料/构建：语料体积大不入库（体检预算），构建归操作者（见 prepare-gate-build.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RUN_DIR, EXE, GATE_ENV, GATE_BUDGET } from './gate-lib.mjs';

const GATES_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SET = ['ac36', 'arrow', 'scroll', 'ir-scroll', 'walk-f'];
const GATE_DEFS = {
  'ac36':     { script: 'native-gate-ac36.mjs',          out: 'native-gate-ac36.json',   corpus: true },
  'arrow':    { script: 'gate-batch1-arrow.mjs',         out: 'gate-batch1-arrow.json',  corpus: true },
  'scroll':   { script: 'gate-batch1-scroll.mjs',        out: 'gate-batch1-scroll.json', corpus: true },
  'ir-scroll': { script: 'gate-ir-scroll.mjs',           out: 'gate-ir-scroll.json',     corpus: true },
  'phys-ab':  { script: 'gate-batch1-physical-ab.mjs',   out: 'gate-batch1-physical-ab.json', corpus: true },
  'walk-f':   { script: 'gate-walk-f.mjs',               out: 'gate-walk-f.json',        corpus: true },
  'writing':  { script: 'native-writing-20min-r2.mjs',   out: 'native-writing-20min.json', corpus: false }, // 自建被测文件
};

const argv = process.argv.slice(2);
const passThrough = [];
let corpusArg = null, outDirArg = null;
const selected = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--corpus') corpusArg = argv[++i];
  else if (a === '--out') outDirArg = argv[++i];
  else if (a.startsWith('--')) passThrough.push(a);
  else selected.push(a);
}
const gateIds = selected.length ? selected : DEFAULT_SET;
const unknown = gateIds.filter(g => !GATE_DEFS[g]);
if (unknown.length) { console.error(`未知门禁: ${unknown.join(', ')}（可选: ${Object.keys(GATE_DEFS).join(' | ')}）`); process.exit(1); }
if (passThrough.length) console.log(`旗标透传: ${passThrough.join(' ')}（注意：对所有门禁生效）`);

const corpusName = corpusArg && /^[\w-]+$/.test(corpusArg) ? path.join(RUN_DIR, 'corpus', `${corpusArg}.md`) : corpusArg;
const corpus = path.resolve(corpusName || path.join(RUN_DIR, 'corpus', GATE_ENV === 'soft' ? 'mixed-100k.md' : 'dense-2m.md'));
const outDir = path.resolve(outDirArg || path.join(RUN_DIR, 'results'));
fs.mkdirSync(outDir, { recursive: true });

// —— 前置检查（fail-fast，不自动补救）——
if (!fs.existsSync(EXE)) {
  console.error(`exe 不存在: ${EXE}\n先做隔离构建（README「隔离构建」节 / prepare-gate-build.mjs），或用环境变量 ZIEDIT_GATE_EXE 指定既有 exe。`);
  process.exit(1);
}
if (gateIds.some(g => GATE_DEFS[g].corpus) && !fs.existsSync(corpus)) {
  console.error(`语料不存在: ${corpus}\n先再成语料: node tests/gates/gen-corpus.mjs（或 --corpus 指定既有语料）。`);
  process.exit(1);
}

// 从结果 JSON 提取 verdict 与人读失败原因（各门禁结构略异，按字段优先级取）
function readVerdict(file) {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { verdict: false, failReasons: ['result JSON missing/unreadable'], data: null }; }
  const reasons = [];
  if (data.fatal) reasons.push('fatal: ' + String(data.fatal).slice(0, 200));
  if (Array.isArray(data.criteria)) for (const c of data.criteria) if (!c.verdict) reasons.push(`${c.id}: ${(c.reasons || [])[0] ?? 'failed'}`);
  if (Array.isArray(data.rounds)) for (const r of data.rounds) if (r.failReasons?.length) reasons.push(`round${r.round}(${r.kind}): ${r.failReasons.join('; ')}`);
  if (!reasons.length && data.verdict !== true) reasons.push('verdict false (no reasons recorded)');
  return { verdict: data.verdict === true && reasons.length === 0, failReasons: reasons, data };
}

const summary = { started: new Date().toISOString(), exe: EXE, corpus, environment: GATE_ENV, budgets: GATE_BUDGET, gates: [] };
for (const id of gateIds) {
  const def = GATE_DEFS[id];
  const outFile = path.join(outDir, def.out);
  const cmdArgs = [path.join(GATES_DIR, def.script), ...(def.corpus ? [corpus] : []), outFile, ...passThrough];
  const rec = { id, script: def.script, cmd: `node ${path.relative(process.cwd(), cmdArgs[0])} ${cmdArgs.slice(1).map(a => path.isAbsolute(a) ? path.relative(process.cwd(), a) : a).join(' ')}`, out: outFile, started: new Date().toISOString() };
  summary.gates.push(rec);
  console.log(`\n===== [${id}] ${rec.cmd}\n`);
  const t0 = Date.now();
  try {
    const code = await new Promise(resolve => {
      const child = spawn(process.execPath, cmdArgs, { stdio: 'inherit' });
      child.on('error', () => resolve(1));
      child.on('close', c => resolve(c ?? 1));
    });
    rec.exitCode = code;
    const v = readVerdict(outFile);
    rec.verdict = v.verdict && code === 0;
    rec.failReasons = v.failReasons;
    if (v.verdict && code !== 0) rec.failReasons = [`verdict true 但退出码 ${code}`];
  } catch (e) {
    rec.exitCode = null;
    rec.verdict = false;
    rec.failReasons = ['spawn failed: ' + String(e.message || e)];
  }
  rec.durationMs = Date.now() - t0;
  rec.finished = new Date().toISOString();
  console.log(`[${id}] verdict=${rec.verdict ? 'PASS' : 'FAIL'} (${Math.round(rec.durationMs / 1000)}s)${rec.failReasons?.length ? '\n  ' + rec.failReasons.slice(0, 8).map(r => '- ' + r).join('\n  ') : ''}`);
}
summary.finished = new Date().toISOString();
summary.verdict = summary.gates.every(g => g.verdict);
const summaryFile = path.join(outDir, 'run-all-summary.json');
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

console.log(`\n===== 总表 =====`);
for (const g of summary.gates) console.log(`${g.verdict ? 'PASS' : 'FAIL'}  ${g.id.padEnd(8)} exit=${g.exitCode} ${Math.round(g.durationMs / 1000)}s`);
console.log(`总判: ${summary.verdict ? 'PASS' : 'FAIL'}；总表: ${summaryFile}`);
process.exitCode = summary.verdict ? 0 : 1;
