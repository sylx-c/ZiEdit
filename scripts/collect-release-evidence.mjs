// node scripts/collect-release-evidence.mjs manifest.json [kind=report.json ...]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, sourceSnapshot } from './build-provenance.mjs';
import { fileEvidence, releaseAcceptance, RELEASE_CHECKS } from './release-acceptance.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.resolve(process.argv[2] ?? 'docs/tmp/phase1/build-manifest.json');
const manifest = readJson(manifestPath);
if (sourceSnapshot(root).sha256 !== manifest.sourceBefore.sha256) throw new Error('Candidate belongs to different source');
const records = { ...manifest.evidence };
for (const input of process.argv.slice(3)) {
  const [kind, ...parts] = input.split('=');
  if (!RELEASE_CHECKS.includes(kind) || parts.length === 0) throw new Error('Invalid evidence argument: ' + input);
  records[kind] = fileEvidence(root, path.resolve(parts.join('=')));
}
const acceptance = releaseAcceptance(root, manifest, records);
writeJson(manifestPath, { ...manifest, evidence: records, acceptance, releaseReady: acceptance.releaseReady });
console.log(JSON.stringify(acceptance, null, 2));
