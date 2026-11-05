import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileEvidence, RELEASE_CHECKS } from "./release-acceptance.mjs";
import { writeJson } from "./build-provenance.mjs";
import { publishDecision } from "./publish-release.mjs";

function candidateFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ziedit-publish-"));
  fs.writeFileSync(path.join(root, "setup.exe"), "installer");
  fs.writeFileSync(path.join(root, "native.json"), "actual observations");
  const source = { sha256: "source", dirty: false };
  const manifest = { version: "1.0.0", status: "candidate", channel: "release", platform: "win32",
    sourceBefore: source, sourceAfter: source, artifacts: [fileEvidence(root, path.join(root, "setup.exe"))], evidence: {} };
  for (const kind of RELEASE_CHECKS) {
    const report = { kind, verdict: true, platform: "win32", sourceBefore: source, sourceAfter: source, exeSha256: "gate-exe",
      installerSha256: manifest.artifacts[0].sha256, independentEnvironment: true,
      runUrl: "https://github.com/test/repo/actions/runs/123", durationMs: 1200000,
      files: [fileEvidence(root, path.join(root, "native.json"))],
      matrix: { verdict: true, displayChanged: false, webviewEnvironment: { scale: 1, gpu: "GPU" },
        results: Array.from({ length: 19 }, () => ({ verdict: true })) },
      days: ["2026-01-01", "2026-01-02"].map(date => ({ date, minutes: 60, tester: "Tester", notes: "editing", blockers: 0 })) };
    const file = path.join(root, kind + ".json");
    writeJson(file, report);
    manifest.evidence[kind] = fileEvidence(root, file);
  }
  return { root, manifest };
}

test("公开发布放行：标签一致且全部验收通过才允许，缺项/篡改/错版均拒绝", () => {
  const { root, manifest } = candidateFixture();
  try {
    assert.equal(publishDecision(root, "v1.0.0", manifest).publish, true);
    assert.equal(publishDecision(root, "v1.0.2", manifest).publish, false); // 错版标签
    const missing = { ...manifest, evidence: {} };
    assert.equal(publishDecision(root, "v1.0.0", missing).publish, false); // 无证据
    const partial = { ...manifest, evidence: { ...manifest.evidence } };
    delete partial.evidence["trial-two-days"];
    assert.equal(publishDecision(root, "v1.0.0", partial).publish, false); // 缺实际试用
    fs.writeFileSync(path.join(root, "native.json"), "modified observations");
    assert.equal(publishDecision(root, "v1.0.0", manifest).publish, false); // 证据被篡改
  } finally { fs.rmSync(root, { recursive: true }); }
});
