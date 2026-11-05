import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileEvidence, nativeEvidenceFiles, RELEASE_CHECKS, releaseAcceptance } from './release-acceptance.mjs';
import { writeJson, sha256 } from './build-provenance.mjs';

test('热轮覆盖共享位置报告不使冷轮独立证据失效，修改冷轮副本仍能检出', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ziedit-native-evidence-'));
  try {
    const cold = path.join(root, 'cold'), shared = path.join(root, 'position.json'), exe = path.join(root, 'gate.exe');
    fs.mkdirSync(cold); fs.writeFileSync(shared, 'cold position'); fs.writeFileSync(exe, 'executable');
    fs.copyFileSync(shared, path.join(cold, 'position.json'));
    const files = nativeEvidenceFiles(root, cold, [exe]);
    const intact = () => files.every(item => sha256(fs.readFileSync(path.join(root, item.path))) === item.sha256);
    fs.writeFileSync(shared, 'warm position');
    assert.equal(intact(), true);
    fs.writeFileSync(path.join(cold, 'position.json'), 'changed cold position');
    assert.equal(intact(), false);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('工程通过只产生候选，必须同源、同包、全部验收才能允许发布', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ziedit-acceptance-'));
  try {
    fs.writeFileSync(path.join(root, 'setup.exe'), 'installer');
    fs.writeFileSync(path.join(root, 'native.json'), 'actual observations');
    const source = { sha256: 'source', dirty: false };
    const manifest = { status: 'candidate', channel: 'release', platform: 'win32', sourceBefore: source, sourceAfter: source,
      artifacts: [fileEvidence(root, path.join(root, 'setup.exe'))] };
    assert.equal(releaseAcceptance(root, manifest).releaseReady, false);
    const records = {};
    for (const kind of RELEASE_CHECKS) {
      const report = { kind, verdict: true, platform: 'win32', sourceBefore: source, sourceAfter: source, exeSha256: 'gate-exe',
        installerSha256: manifest.artifacts[0].sha256, independentEnvironment: true, runUrl: 'https://github.com/test/repo/actions/runs/123',
        durationMs: 1200000, files: [fileEvidence(root, path.join(root, 'native.json'))],
        matrix: { verdict: true, displayChanged: false, webviewEnvironment: { scale: 1, gpu: 'GPU' }, results: Array.from({ length: 19 }, () => ({ verdict: true })) },
        days: ['2026-01-01', '2026-01-02'].map(date => ({ date, minutes: 60, tester: 'Tester', notes: 'editing, Markdown, formats', blockers: 0 })) };
      const file = path.join(root, kind + '.json'); writeJson(file, report); records[kind] = fileEvidence(root, file);
    }
    assert.equal(releaseAcceptance(root, manifest, records).releaseReady, true);
    assert.equal(releaseAcceptance(root, { ...manifest, sourceBefore: { ...source, dirty: true } }, records).releaseReady, false);
    assert.equal(releaseAcceptance(root, { ...manifest, channel: 'dev' }, records).releaseReady, false);
    assert.equal(releaseAcceptance(root, manifest, { ...records, 'markdown-warm': records['markdown-cold'] }).releaseReady, false);
    fs.writeFileSync(path.join(root, 'native.json'), 'modified observations');
    assert.equal(releaseAcceptance(root, manifest, records).releaseReady, false);
    fs.writeFileSync(path.join(root, 'setup.exe'), 'different package');
    assert.equal(releaseAcceptance(root, manifest, records).releaseReady, false);
  } finally { fs.rmSync(root, { recursive: true }); }
});
