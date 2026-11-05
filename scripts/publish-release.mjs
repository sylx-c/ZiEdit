// 公开发布放行（2026-11-04 整改）：v* 标签 CI 只上传草稿 Release 与候选包；
// 本脚本由维护者在本地显式执行，复用 release-acceptance 的源码/包/报告摘要校验，
// 全部验收通过才允许把草稿转为公开；默认只核验不发布（dry-run）。
// 用法：
//   node scripts/publish-release.mjs v1.0.0 docs/tmp/release-1.0.0/verification.json            # 只核验
//   node scripts/publish-release.mjs v1.0.0 docs/tmp/release-1.0.0/verification.json --publish  # 转为公开
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readJson, sha256 } from "./build-provenance.mjs";
import fs from 'node:fs';
import { releaseAcceptance } from "./release-acceptance.mjs";

export function publishDecision(root, tag, manifest) {
  const errors = [];
  if (tag !== "v" + manifest.version) errors.push("标签 " + tag + " 与候选版本 v" + manifest.version + " 不一致");
  const acceptance = releaseAcceptance(root, manifest, manifest.evidence ?? {});
  if (!acceptance.releaseReady) errors.push("验收证据未全部通过：缺项/异源/包变化/试用未完成均拒绝放行");
  return { publish: errors.length === 0, errors, checks: acceptance.checks };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [tag, manifestArg, ...flags] = process.argv.slice(2);
  if (!tag || !manifestArg) {
    console.error("用法: node scripts/publish-release.mjs <vTag> <manifest.json> [--publish]");
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = readJson(path.resolve(manifestArg));
  const decision = publishDecision(root, tag, manifest);
  const checks = Object.fromEntries(Object.entries(decision.checks).map(([k, v]) => [k, v.status]));
  console.log(JSON.stringify({ publish: decision.publish, errors: decision.errors, checks }, null, 2));
  if (!decision.publish) process.exit(1);
  if (flags.includes("--publish")) {
    const licenseGate = spawnSync(process.execPath, ['scripts/verify-license-compliance.mjs'], { cwd: root, stdio: 'inherit' });
    if (licenseGate.status !== 0) throw new Error('版权来源/许可门禁未通过，拒绝公开发布。');
    const delivered = (manifest.licenseDelivery ?? []).map(ref => {
      const file = path.resolve(root, ref.path);
      if (sha256(fs.readFileSync(file)) !== ref.sha256) throw new Error('安装包许可验收报告已变化。');
      return readJson(file);
    });
    if (!manifest.artifacts?.filter(item => item.path.endsWith('.exe')).every(item => delivered.some(report => report.status === 'passed' && report.installerSHA256 === item.sha256)) || !delivered.length) throw new Error('缺少本安装包的许可/源码解包验收，拒绝发布。');
    const r = spawnSync("gh", ["release", "edit", tag, "--draft=false"], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
  console.log("dry-run：验收通过；加 --publish 才会把草稿 Release 转为公开。");
}
