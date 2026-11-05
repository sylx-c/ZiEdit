import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sourceSnapshot, verificationMatches, assertInside } from './build-provenance.mjs';

test('源码摘要包含未跟踪内容及删除状态，排除忽略的产物', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ziedit-provenance-'));
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  try {
    git(['init']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
    fs.writeFileSync(path.join(root, '.gitignore'), 'output/\n');
    fs.writeFileSync(path.join(root, 'source'), 'one');
    git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
    const initial = sourceSnapshot(root);
    fs.mkdirSync(path.join(root, 'output')); fs.writeFileSync(path.join(root, 'output/ignored'), 'x');
    assert.equal(sourceSnapshot(root).sha256, initial.sha256);
    fs.writeFileSync(path.join(root, 'untracked'), 'new');
    const changed = sourceSnapshot(root);
    assert.notEqual(changed.sha256, initial.sha256);
    fs.writeFileSync(path.join(root, 'untracked'), 'edited');
    assert.notEqual(sourceSnapshot(root).sha256, changed.sha256);
    fs.unlinkSync(path.join(root, 'source'));
    assert.equal(sourceSnapshot(root).files.find(item => item.path === 'source').sha256, null);
    assert.equal(sourceSnapshot(root).dirty, true);
  } finally { assertInside(os.tmpdir(), root); fs.rmSync(root, { recursive: true }); }
});
test('失败报告、异源报告、空检查清单均不能验证新包', () => {
  const source = { sha256: 'current' };
  const report = { status: 'passed', sourceBefore: source, sourceAfter: source, checks: [{ exitCode: 0 }] };
  assert.equal(verificationMatches(report, source), true);
  assert.equal(verificationMatches({ ...report, status: 'failed' }, source), false);
  assert.equal(verificationMatches(report, { sha256: 'other' }), false);
  assert.equal(verificationMatches({ ...report, checks: [] }, source), false);
  assert.equal(verificationMatches({ ...report, checks: [{ exitCode: 1 }] }, source), false);
  assert.throws(() => assertInside('C:/workspace', 'C:/workspace/../outside'));
});
