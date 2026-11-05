// 同一源码快照的工程检查记录。日志与结果必须写到 Git 忽略的产物目录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sourceSnapshot, writeJson, sha256 } from './build-provenance.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, process.argv[2] ?? 'docs/tmp/phase1/verification.json');
const node = (...args) => [process.execPath, args];
const checks = [
  ['licenses', ...node('scripts/verify-license-compliance.mjs')],
  ['frontend-tests', ...node('node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=4')],
  ['typescript', ...node('node_modules/typescript/bin/tsc', '--noEmit')],
  ['frontend-build', ...node('node_modules/vite/bin/vite.js', 'build')],
  ['rust-tests', 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml']],
  ['rust-clippy', 'cargo', ['clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets', '--', '-D', 'warnings']],
  ['rust-format', 'cargo', ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--check']],
  ['rust-notices', ...node('scripts/gen-rust-notices.mjs', '--check')],
  ['provenance-tests', ...node('--test', 'scripts/build-provenance.test.mjs', 'scripts/release-acceptance.test.mjs', 'scripts/gate-state.test.mjs')],
];
const report = { started: new Date().toISOString(), platform: process.platform, sourceBefore: sourceSnapshot(root), checks: [] };
for (const [name, command, args] of checks) {
  const started = Date.now();
  console.log('Checking ' + name);
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const log = path.join(path.dirname(output), name + '.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? String(result.error) : ''));
  const exitCode = result.status ?? 1;
  report.checks.push({ name, command: [command, ...args], exitCode, durationMs: Date.now() - started, log: path.relative(root, log), sha256: sha256(fs.readFileSync(log)) });
  console.log(`${name}: ${exitCode === 0 ? 'PASS' : 'FAIL'} (${Date.now() - started}ms)`);
  if (exitCode !== 0) console.log(fs.readFileSync(log, 'utf8').slice(-12000));
}
report.sourceAfter = sourceSnapshot(root);
report.status = report.checks.every(check => check.exitCode === 0) && report.sourceBefore.sha256 === report.sourceAfter.sha256 ? 'passed' : 'failed';
report.verdict = report.status === 'passed';
report.files = report.checks.map(check => ({ path: check.log, sha256: check.sha256 }));
report.finished = new Date().toISOString();
writeJson(output, report);
console.log(`Verification ${report.status}: ${output}`);
process.exitCode = report.status === 'passed' ? 0 : 1;
