// 先验证源码与报告，再打包；新包通过检查后淘汰备份，失败恢复旧安装包。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sourceSnapshot, verificationMatches, filesBelow, assertInside, readJson, writeJson, sha256 } from './build-provenance.mjs';
import { releaseAcceptance, fileEvidence } from './release-acceptance.mjs';
import { syncPdfjsAssets } from './sync-pdfjs-assets.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 构建期派生资产先落位（pdfjs 数据/字体/许可来自锁定的 pdfjs-dist，字节可复现），
// 否则全新检出的环境（CI/新克隆）在门禁阶段扫描 public/pdfjs-assets 会 ENOENT。
syncPdfjsAssets();
const licenseGate = spawnSync(process.execPath, ['scripts/verify-license-compliance.mjs'], { cwd: root, stdio: 'inherit' });
if (licenseGate.status !== 0) throw new Error('Copyright/license evidence is incomplete; verified packaging is blocked.');
const args = process.argv.slice(2);
const ci = args.includes('--ci-validated');
if (ci && process.env.GITHUB_ACTIONS !== 'true') throw new Error('--ci-validated requires GitHub Actions');
const reportFile = path.resolve(root, args.find(arg => !arg.startsWith('--')) ?? 'docs/tmp/phase1/verification.json');
const sourceBefore = sourceSnapshot(root);
const verification = ci ? { kind: 'ci', jobs: ['frontend', 'rust'], run: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` }
  : { kind: 'local', path: path.relative(root, reportFile), sha256: sha256(fs.readFileSync(reportFile)), report: readJson(reportFile) };
if (!ci && !verificationMatches(verification.report, sourceBefore)) throw new Error('Verification is missing, failed, or belongs to different source. Run verify-project.mjs first.');
const version = readJson(path.join(root, 'src-tauri/tauri.conf.json')).version;
const cargoVersion = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (version !== readJson(path.join(root, 'package.json')).version || version !== cargoVersion) throw new Error('Version mismatch');
const channel = process.env.ZIEDIT_CHANNEL === 'release' ? 'release' : 'dev';
const target = process.env.CARGO_TARGET_DIR ? path.resolve(root, process.env.CARGO_TARGET_DIR) : path.join(root, 'src-tauri/target');
const bundle = path.join(target, 'release/bundle');
// 只管理工作区内的安装包，避免错误的 CARGO_TARGET_DIR 指向外部目录。
assertInside(root, bundle);
const staging = path.join(root, 'docs/tmp/packages', crypto.randomUUID());
const backup = path.join(staging, 'previous-bundle');
const rejected = path.join(staging, 'unverified-bundle');
const output = path.join(root, 'docs/tmp/phase1/build-manifest.json');
fs.mkdirSync(staging, { recursive: true });
const tool = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Cannot inspect ${command}: ${result.stderr ?? result.error}`);
  return result.stdout.trim();
};
const tools = { node: process.version, cargo: tool('cargo', ['--version']), rustc: tool('rustc', ['--version']),
  npm: tool(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/c', 'npm --version'] : ['--version']),
  tauri: readJson(path.join(root, 'node_modules/@tauri-apps/cli/package.json')).version };
let accepted = false;
let movedPrevious = false;
const manifest = { started: new Date().toISOString(), platform: process.platform, version, channel, tools, sourceBefore, verification, artifacts: [] };
try {
  if (fs.existsSync(bundle)) { fs.renameSync(bundle, backup); movedPrevious = true; }
  const build = spawnSync(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build'], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, ZIEDIT_CHANNEL: channel } });
  manifest.exitCode = build.status ?? 1;
  if (manifest.exitCode === 0) {
    const delivered = spawnSync(process.execPath, ['scripts/verify-license-compliance.mjs', '--dist'], { cwd: root, stdio: 'inherit' });
    if (delivered.status !== 0) throw new Error('Built license/material payload differs from audited inputs.');
  }
  manifest.sourceAfter = sourceSnapshot(root);
  const artifacts = filesBelow(bundle).filter(file => /\.(exe|dmg|deb|rpm|AppImage|app\.tar\.gz|msi)$/i.test(file));
  manifest.artifacts = artifacts.map(file => ({ path: path.relative(root, file), bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) }));
  if (manifest.exitCode === 0 && process.platform === 'win32') {
    const nsis = artifacts.filter(file => file.endsWith('.exe'));
    if (!nsis.length) throw new Error('No Windows installer available for license delivery verification');
    manifest.licenseDelivery = [];
    for (const [index, installer] of nsis.entries()) {
      const extraction = path.join(staging, `license-extraction-${index}`);
      const check = spawnSync(process.execPath, ['scripts/verify-installer-licenses.mjs', installer, extraction, process.env.ZIEDIT_SEVEN_ZIP ?? '7z'], { cwd: root, stdio: 'inherit' });
      if (check.status !== 0) throw new Error('Windows installer license/source payload was not verified');
      manifest.licenseDelivery.push(fileEvidence(root, path.join(extraction, 'verification-report.json')));
    }
  }
  accepted = manifest.exitCode === 0 && manifest.artifacts.length > 0 && sourceBefore.sha256 === manifest.sourceAfter.sha256;
  manifest.status = accepted ? 'candidate' : 'failed';
  if (!accepted) throw new Error('Build failed, source changed, or installers are missing');
} catch (error) {
  manifest.status = 'failed'; manifest.error = String(error);
  if (fs.existsSync(bundle)) fs.renameSync(bundle, rejected);
  manifest.artifacts = manifest.artifacts.map(item => ({ ...item, path: path.relative(root, path.join(rejected, path.relative(bundle, path.resolve(root, item.path)))) }));
  if (movedPrevious) fs.renameSync(backup, bundle);
  process.exitCode = 1;
} finally {
  manifest.evidence = ci ? {} : { engineering: fileEvidence(root, reportFile) };
  manifest.acceptance = releaseAcceptance(root, manifest, manifest.evidence);
  manifest.releaseReady = manifest.acceptance.releaseReady;
  manifest.finished = new Date().toISOString();
  writeJson(output, manifest);
  if (accepted && movedPrevious) { assertInside(staging, backup); fs.rmSync(backup, { recursive: true }); }
}
console.log(`${manifest.status}: ${output}`);
