import fs from 'node:fs';
import path from 'node:path';
import { sha256, readJson, filesBelow } from './build-provenance.mjs';

export const RELEASE_CHECKS = Object.freeze([
  'engineering', 'data-safety', 'formats', 'resources', 'writing-20min',
  'markdown-cold', 'markdown-warm', 'installed-package', 'windows-ci', 'trial-two-days',
]);

export function fileEvidence(root, file) {
  return { path: path.relative(root, file), sha256: sha256(fs.readFileSync(file)) };
}

/** 仅收集本轮独立报告与不可变构建产物，不引用后续轮次会覆盖的共享结果。 */
export function nativeEvidenceFiles(root, output, artifacts) {
  return [...new Set([...filesBelow(output), ...artifacts])].map(file => fileEvidence(root, file));
}

/** 只消费有内容摘要的报告；缺项、异源、包变化或报告被改动都不能放行。 */
export function releaseAcceptance(root, manifest, records = {}) {
  const source = manifest.sourceBefore?.sha256;
  const hash = file => sha256(fs.readFileSync(path.resolve(root, file)));
  const currentArtifacts = manifest.artifacts?.length > 0 && manifest.artifacts.every(item => {
    try { return hash(item.path) === item.sha256; } catch { return false; }
  });
  const checks = {};
  for (const id of RELEASE_CHECKS) {
    const ref = records[id];
    let status = 'pending', reason = '未取得本候选的验收证据';
    try {
      if (ref) {
        const report = readJson(path.resolve(root, ref.path));
        const bound = hash(ref.path) === ref.sha256 && report.sourceBefore?.sha256 === source
          && report.sourceAfter?.sha256 === source;
        const linkedFilesValid = report.files?.length > 0 && report.files.every(item => hash(item.path) === item.sha256);
        const matchingPackage = !['installed-package', 'trial-two-days'].includes(id)
          || manifest.artifacts.some(item => item.sha256 === report.installerSha256);
        let detail = true;
        if (id === 'markdown-cold' || id === 'markdown-warm') {
          detail = report.kind === id && report.matrix?.results?.length === 19
            && report.matrix.results.every(item => item.verdict === true)
            && report.matrix.verdict === true && report.matrix.displayChanged === false
            && !!report.matrix.webviewEnvironment;
        }
        if (id === 'writing-20min') detail = report.durationMs >= 20 * 60 * 1000;
        if (id === 'windows-ci') detail = report.platform === 'win32' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(report.runUrl ?? '');
        if (id === 'installed-package') detail = report.platform === 'win32' && report.independentEnvironment === true;
        if (id === 'trial-two-days') {
          const days = report.days ?? [];
          const dates = days.map(day => day.date);
          detail = days.length === 2 && dates.every(date => /^\d{4}-\d{2}-\d{2}$/.test(date))
            && Date.parse(dates[1]) - Date.parse(dates[0]) === 86400000
            && days.every(day => day.minutes >= 60 && day.tester && day.notes && day.blockers === 0)
            && days.every(day => day.date <= new Date().toISOString().slice(0, 10));
        }
        status = bound && linkedFilesValid && matchingPackage && detail && report.verdict === true ? 'passed' : 'failed';
        reason = status === 'passed' ? '' : '报告失败、内容变化、来源不匹配或验收条件不完整';
      }
    } catch (error) { status = 'failed'; reason = String(error); }
    checks[id] = { status, reason, ...(ref ? { evidence: ref } : {}) };
  }
  if (checks['markdown-cold'].status === 'passed' && checks['markdown-warm'].status === 'passed') {
    const cold = readJson(path.resolve(root, records['markdown-cold'].path));
    const warm = readJson(path.resolve(root, records['markdown-warm'].path));
    if (!cold.exeSha256 || cold.exeSha256 !== warm.exeSha256
      || JSON.stringify(cold.matrix.display) !== JSON.stringify(warm.matrix.display)
      || JSON.stringify(cold.matrix.webviewEnvironment) !== JSON.stringify(warm.matrix.webviewEnvironment)) {
      checks['markdown-warm'] = { ...checks['markdown-warm'], status: 'failed', reason: '冷/热矩阵的 EXE 或运行环境不一致' };
    }
  }
  const releaseReady = manifest.status === 'candidate' && manifest.channel === 'release'
    && manifest.platform === 'win32' && manifest.sourceBefore?.dirty === false
    && manifest.sourceBefore?.sha256 === manifest.sourceAfter?.sha256 && currentArtifacts
    && RELEASE_CHECKS.every(id => checks[id].status === 'passed');
  return { releaseReady, checks };
}
