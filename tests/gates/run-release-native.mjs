// 运行一次验收并绑定源码、隔离构建、实际 EXE、环境及所有报告文件。
// node tests/gates/run-release-native.mjs <markdown-cold|markdown-warm|writing-20min|data-safety|formats|resources> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT as root, RUN_DIR, EXE, readDisplayEnvironment } from './gate-lib.mjs';
import { sourceSnapshot, readJson, writeJson, sha256 } from '../../scripts/build-provenance.mjs';
import { nativeEvidenceFiles } from '../../scripts/release-acceptance.mjs';
import { resetGateState } from './gate-state.mjs';
const [kind, outputArg] = process.argv.slice(2);
const definitions = {
  'markdown-cold': ['run-md-matrix.mjs'], 'markdown-warm': ['run-md-matrix.mjs'],
  'writing-20min': ['run-all.mjs', 'writing'], 'data-safety': ['run-all.mjs', 'recovery', 'md-editing', 'md-navigation'],
  formats: ['run-all.mjs', 'release-formats'], resources: ['run-all.mjs', 'release-resources'],
};
if (!definitions[kind]) throw new Error('Unknown release check: ' + kind);
const output = path.resolve(outputArg ?? path.join(RUN_DIR, kind));
if (fs.existsSync(output)) throw new Error('Keep prior evidence; choose a new output directory: ' + output);
const buildPath = path.join(RUN_DIR, 'native-gate-build/gate-build.json');
const build = readJson(buildPath), sourceBefore = sourceSnapshot(root);
const config = readJson(path.join(RUN_DIR, 'native-gate-build/src-tauri/tauri.conf.json'));
const exeSha256 = sha256(fs.readFileSync(EXE));
if (build.status !== 'passed' || build.sourceAfter?.sha256 !== sourceBefore.sha256 || build.exeSha256 !== exeSha256 || build.channel !== 'release') {
  throw new Error('Rebuild isolated gate from the current release source');
}
fs.mkdirSync(output, { recursive: true });
const profileRoot = path.join(RUN_DIR, 'profiles', 'matrix-' + exeSha256.slice(0, 16));
if (kind === 'markdown-cold') {
  if (fs.existsSync(profileRoot)) throw new Error('Cold profiles already exist; use a fresh RUN_DIR');
  fs.mkdirSync(profileRoot, { recursive: true });
  writeJson(path.join(profileRoot, 'identity.json'), { source: sourceBefore.sha256, exeSha256 });
}
if (kind === 'markdown-warm') {
  const identity = readJson(path.join(profileRoot, 'identity.json'));
  if (identity.source !== sourceBefore.sha256 || identity.exeSha256 !== exeSha256) throw new Error('Warm profiles belong to another candidate');
}
const start = Date.now(), environment = { os: os.release(), arch: os.arch(), node: process.version, display: await readDisplayEnvironment(),
  state: resetGateState(config.identifier, RUN_DIR) };
const [script, ...args] = definitions[kind];
const logPath = path.join(output, 'runner.log'), log = fs.openSync(logPath, 'w');
let result;
try {
  result = spawnSync(process.execPath, [path.join(root, 'tests/gates', script), ...args,
    ...(script === 'run-all.mjs' ? ['--out', output] : [output])], { cwd: root, windowsHide: true,
    stdio: ['ignore', log, log], env: { ...process.env, ZIEDIT_GATE_EXE: EXE,
      ...(kind.startsWith('markdown-') ? { ZIEDIT_GATE_PROFILE_ROOT: profileRoot } : {}) } });
} finally { fs.closeSync(log); }
const sourceAfter = sourceSnapshot(root), displayAfter = await readDisplayEnvironment();
const resultPath = path.join(output, script === 'run-md-matrix.mjs' ? 'matrix.json' : 'run-all-summary.json');
let data;
try { data = readJson(resultPath); } catch { data = { verdict: false, error: 'No readable result report' }; }
// 记录完整门禁子报告，不信任单一汇总布尔量；报告写入后不得再编辑。
// 矩阵已把共享位置报告复制进本轮目录；只绑定独立副本，下一轮不得使本轮哈希失效。
const linkedFiles = nativeEvidenceFiles(root, output, [buildPath, EXE]);
const envelope = { kind, verdict: result.status === 0 && data.verdict === true
    && sourceBefore.sha256 === sourceAfter.sha256 && exeSha256 === sha256(fs.readFileSync(EXE))
    && JSON.stringify(environment.display) === JSON.stringify(displayAfter),
  started: new Date(start).toISOString(), finished: new Date().toISOString(), durationMs: Date.now() - start,
  sourceBefore, sourceAfter, exe: EXE, exeSha256, environment, displayAfter, exitCode: result.status,
  ...(script === 'run-md-matrix.mjs' ? { matrix: data } : { summary: data }),
  files: linkedFiles, error: result.error ? String(result.error) : undefined };
writeJson(path.join(output, 'evidence.json'), envelope);
console.log(`${kind}: ${envelope.verdict ? 'PASS' : 'FAIL'} ${output}`);
process.exitCode = envelope.verdict ? 0 : 1;
