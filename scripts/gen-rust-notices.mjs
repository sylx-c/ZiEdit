// Regenerate only the Rust section; Cargo.lock is never updated.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], {
  cwd: fileURLToPath(new URL('../src-tauri/', import.meta.url)), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}));
const groups = new Map();
for (const pkg of metadata.packages) {
  if (metadata.workspace_members.includes(pkg.id)) continue;
  const license = pkg.license || '未声明（需核实）';
  if (!groups.has(license)) groups.set(license, []);
  groups.get(license).push(`${pkg.name} ${pkg.version}`);
}
const workspace = metadata.packages.find(p => p.id === metadata.resolve.root);
const direct = [...new Set(workspace.dependencies.map(d => d.name))].sort();
const section = [
  '## Rust 依赖（src-tauri/）', '',
  '版本以 Cargo.lock 为准、许可以本清单为准（源自 crates.io 元数据）。以下包含全部目标平台及构建依赖，按完整许可表达式分组；OR 表示可选许可，AND 表示同时适用。', '',
  '生成方式：`node scripts/gen-rust-notices.mjs`（执行 `cargo metadata --format-version 1 --locked`，不修改锁文件）。', '',
  `直接依赖（含构建依赖）：${direct.map(n => '`' + n + '`').join('、')}。`, '',
  'EPL-2.0 组件 elkjs 属于前端 Mermaid，不在 Rust 依赖树中；见 vendored 清单及随附许可。', '',
  ...[...groups].sort(([a], [b]) => a.localeCompare(b, 'en')).flatMap(([license, packages]) => [
    `### ${license}`, '', packages.sort((a, b) => a.localeCompare(b, 'en')).map(p => `- ${p}`).join('\n'), '',
  ]),
].join('\n');
const path = root + 'THIRD-PARTY-NOTICES.md';
const original = readFileSync(path, 'utf8');
const before = original.replaceAll('\r\n', '\n');
const after = before.replace(/## Rust 依赖（src-tauri\/）[\s\S]*?(?=\n---)/, section);
if (after === before && !before.includes(section)) throw new Error('Rust section marker missing');
if (process.argv.includes('--check')) {
  if (after !== before) throw new Error('Rust notices are stale');
} else writeFileSync(path, original.includes('\r\n') ? after.replaceAll('\n', '\r\n') : after);
console.log(`Rust notices: ${metadata.packages.length - metadata.workspace_members.length} packages, ${groups.size} license groups${process.argv.includes('--check') ? ' (consistent)' : ''}`);
