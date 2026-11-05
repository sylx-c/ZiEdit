import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
export function sourceSnapshot(root) {
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).toString();
  const names = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
  const files = names.map(name => {
    const file = path.join(root, name);
    try { return { path: name, sha256: sha256(fs.readFileSync(file)) }; }
    catch (e) { if (e.code === 'ENOENT') return { path: name, sha256: null }; throw e; }
  });
  return { sha256: sha256(JSON.stringify(files)), files, commit: git(['rev-parse', 'HEAD']).trim(), dirty: git(['status', '--porcelain']).trim() !== '' };
}
export function verificationMatches(report, source) {
  return report?.status === 'passed' && report.sourceBefore?.sha256 === source.sha256
    && report.sourceAfter?.sha256 === source.sha256 && report.checks?.length > 0
    && report.checks.every(check => check.exitCode === 0);
}
export function filesBelow(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(file) : entry.isFile() ? [file] : [];
  });
}
export function assertInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Unsafe output path: ' + target);
}
