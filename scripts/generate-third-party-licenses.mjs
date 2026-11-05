#!/usr/bin/env node
/** Collect local upstream notices, without downloading, installing, or inventing licenses.
 * Run: node scripts/generate-third-party-licenses.mjs [--check] [--strict]
 * --check compares bytes without writing. --strict also fails on every review item.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { verifyCorrespondingSources } from './verify-corresponding-sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public', 'third-party-licenses');
const args = new Set(process.argv.slice(2));
if ([...args].some(x => !['--check', '--strict'].includes(x))) throw new Error('Usage: node scripts/generate-third-party-licenses.mjs [--check] [--strict]');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const slash = p => p.split(path.sep).join('/');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const generated = new Map();
const evidenceRoot = path.join(root, 'compliance/third-party-sources/license-evidence');
const evidencePath = path.join(evidenceRoot, 'manifest.json');
const supplements = fs.existsSync(evidencePath) ? readJSON(evidencePath).packages : [];
const cargoChecksums = new Map([...fs.readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8').matchAll(/\[\[package\]\]\s+name = "([^"]+)"\s+version = "([^"]+)"[\s\S]*?checksum = "([a-f0-9]{64})"/g)].map(match => [`${match[1]}@${match[2]}`, match[3]]));
const supplementFor = record => supplements.find(item => item.ecosystem === record.ecosystem && item.name === record.name && item.version === record.version);
function supplement(record, id) {
  const evidence = supplementFor(record);
  if (!evidence || evidence.evidenceStatus !== 'UPSTREAM_TEXT_COLLECTED' || evidence.review.length) return false;
  if (record.ecosystem === 'npm' && evidence.archive?.sourceIntegrity !== record.source.integrity) throw new Error(`Supplement archive integrity differs from lock: ${record.name}`);
  if (record.ecosystem === 'cargo' && evidence.archive?.sourceArchiveSHA256 !== cargoChecksums.get(`${record.name}@${record.version}`)) throw new Error(`Supplement archive checksum differs from Cargo.lock: ${record.name}`);
  for (const item of [...evidence.documents, ...evidence.provenanceDocuments]) {
    const file = path.resolve(evidenceRoot, item.path);
    if (!file.startsWith(evidenceRoot + path.sep)) throw new Error(`Unsafe evidence path: ${item.path}`);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== item.bytes || sha(bytes) !== item.sha256) throw new Error(`Changed upstream evidence: ${item.path}`);
  }
  for (const item of evidence.documents) {
    const bytes = fs.readFileSync(path.join(evidenceRoot, item.path));
    const destination = `texts/${record.ecosystem}/${id}/audited-upstream/${item.originalPath}`;
    emit(destination, bytes);
    record.documents.push({ ...item, path: destination, evidencePath: `compliance/third-party-sources/license-evidence/${item.path}` });
  }
  record.supplementalEvidence = `compliance/third-party-sources/license-evidence/manifest.json (${evidence.evidenceStatus})`;
  if (evidence.selectedLicense) record.selectedLicense = evidence.selectedLicense;
  record.upstreamProvenance = { archive: evidence.archive, sourceRevision: evidence.sourceRevision, sourceRepositoryURL: evidence.sourceRepositoryURL, manualEvidence: evidence.manualEvidence };
  return evidence.documents.some(d => d.bytes > 0 && (d.evidenceRole === 'full-license-text' || /^(?:licen[cs]e|copying|unlicense)(?:$|[._-])/i.test(path.posix.basename(d.originalPath))));
}
const issues = [];
function emit(name, content) {
  if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`Unsafe output: ${name}`);
  generated.set(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
}
function issue(record, code, detail) {
  record.review.push({ code, detail });
  issues.push({ ecosystem: record.ecosystem, name: record.name, version: record.version, dependencyClass: record.dependencyClass, location: record.location, code, detail });
}
function repositoryURL(value) {
  let s = typeof value === 'string' ? value : value?.url;
  if (!s) return null;
  s = s.replace(/^git\+/, '').replace(/\.git$/, '');
  if (s.startsWith('github:')) s = `https://github.com/${s.slice(7)}`;
  return s;
}
const legalName = /^(?:licen[cs]e|licen[cs]es|copying|notice|notices|copyright|copyrights|unlicense)(?:$|[._-])/i;
const legalDirectory = /^(?:licen[cs]es?|notices?|copyrights?)$/i;
const skip = new Set(['node_modules', '.git', 'target', '.hg', '.svn']);
function legalFiles(directory, explicit = []) {
  const found = new Set();
  function walk(dir, inLegalDirectory = false) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !skip.has(entry.name)) walk(full, inLegalDirectory || legalDirectory.test(entry.name));
      else if (entry.isFile() && (inLegalDirectory || legalName.test(entry.name))) found.add(slash(path.relative(directory, full)));
    }
  }
  walk(directory);
  for (const rel of explicit.filter(Boolean)) {
    const full = path.resolve(directory, rel);
    if (!full.startsWith(directory + path.sep)) throw new Error(`License path outside package: ${rel}`);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) found.add(slash(path.relative(directory, full)));
  }
  return [...found].sort(compare);
}
function collect(record, directory, explicit = []) {
  record.documents = [];
  const id = `${record.name.replace(/[^a-zA-Z0-9._-]/g, '_')}-${record.version}-${sha(record.location).slice(0, 10)}`;
  if (!directory) return supplement(record, id);
  for (const relative of legalFiles(directory, explicit)) {
    const bytes = fs.readFileSync(path.join(directory, relative));
    const destination = `texts/${record.ecosystem}/${id}/${relative}`;
    emit(destination, bytes);
    record.documents.push({ originalPath: relative, path: destination, bytes: bytes.length, sha256: sha(bytes) });
  }
  // The upstream STIX2 npm artifact omits legal text. Audited originals are
  // retained separately; never substitute the package's Apache label for glyph OFL.
  if (record.ecosystem === 'npm' && record.name === '@mathjax/mathjax-stix2-font' && record.version === '4.1.3') {
    for (const name of ['LICENSE', 'OFL-STIX.txt', 'NOTICE.txt']) {
      const originalPath = `public/renderers/font/${name}`;
      const bytes = fs.readFileSync(path.join(root, originalPath));
      const destination = `texts/npm/${id}/audited-upstream/${name}`;
      emit(destination, bytes);
      record.documents.push({ originalPath, path: destination, bytes: bytes.length, sha256: sha(bytes) });
    }
    record.glyphLicense = 'OFL-1.1';
    record.supplementalEvidence = 'public/font-licenses/README.md; scripts/verify-font-licenses.mjs';
  }
  const reviewedSupplement = supplement(record, id);
  const primary = record.documents.filter(x => /^(?:licen[cs]e|copying|unlicense)(?:$|[._-])/i.test(path.posix.basename(x.originalPath)) && x.bytes > 0);
  if (primary.length === 0 && !reviewedSupplement) issue(record, 'NO_STANDALONE_LICENSE', 'No nonempty standalone LICENSE/COPYING/UNLICENSE file was found. NOTICE, COPYRIGHT, metadata and source headers alone are not accepted as complete license evidence; obtain and review upstream evidence.');
  if (explicit.some(p => p && !fs.existsSync(path.resolve(directory, p)))) issue(record, 'DECLARED_LICENSE_FILE_MISSING', 'A package-declared license file is missing from the local source tree.');
}

const npmLockPath = path.join(root, 'package-lock.json');
const npmLock = readJSON(npmLockPath);
if (!npmLock.packages || npmLock.lockfileVersion < 2) throw new Error('package-lock.json v2/v3 packages map is required.');
const records = [];
for (const [location, item] of Object.entries(npmLock.packages).filter(([p]) => p.startsWith('node_modules/')).sort(([a], [b]) => compare(a, b))) {
  const ownedLink = item.link && location === 'node_modules/stackback' && item.resolved === 'tools/stackback-compat';
  const locked = ownedLink ? npmLock.packages[item.resolved] : item;
  const name = locked.name || location.split('node_modules/').at(-1);
  if (ownedLink && (locked.version !== '0.0.2-ziedit.1' || locked.license !== 'MIT')) throw new Error('Unreviewed local stack adapter');
  const record = {
    ecosystem: 'npm', name, version: locked.version || null, location,
    dependencyClass: item.dev && !item.devOptional ? 'development-only' : item.devOptional ? 'development-and-optional' : 'production-or-optional',
    optional: Boolean(item.optional), dev: Boolean(locked.dev), devOptional: Boolean(item.devOptional),
    os: item.os || [], cpu: item.cpu || [],
    license: locked.license || null, licenseEvidence: locked.license ? 'package-lock.json' : null,
    source: { archiveURL: item.resolved || null, registryMetadataURL: item.version ? `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(item.version)}` : null, integrity: item.integrity || null, repositoryURL: null },
    review: [],
  };
  const directory = path.join(root, ownedLink ? item.resolved : location);
  const manifestPath = path.join(directory, 'package.json');
  if (item.link && !ownedLink) throw new Error(`Linked npm package needs explicit collection support: ${location}`);
  if (ownedLink) {
    record.dependencyClass = 'development-only';
    record.projectOwned = true;
    record.source = { localSource: item.resolved, archiveURL: null, repositoryURL: 'https://github.com/sylx-c/ZiEdit' };
  }
  // 平台限定包（os/cpu 受限）的文档证据一律取自官方固定归档的补充证据，不读本机安装内容：
  // 不同 OS 的 npm ci 装入集合不同，本机采集会让清单字节随宿主漂移（2026-11-06 跨平台确定性修复）。
  const platformConstrained = ((record.os?.length ?? 0) + (record.cpu?.length ?? 0)) > 0;
  if (!platformConstrained && fs.existsSync(manifestPath)) {
    const pkg = readJSON(manifestPath);
    if (pkg.version !== locked.version || pkg.name !== name) throw new Error(`Installed npm identity differs from lock: ${location} (${pkg.name}@${pkg.version} vs ${name}@${locked.version})`);
    record.installed = true;
    record.source.repositoryURL = repositoryURL(pkg.repository);
    if (!record.license && typeof pkg.license === 'string') { record.license = pkg.license; record.licenseEvidence = `${location}/package.json`; }
    if (item.license && typeof pkg.license === 'string' && item.license !== pkg.license) issue(record, 'LICENSE_METADATA_MISMATCH', `lock=${item.license}; installed=${pkg.license}`);
    collect(record, directory);
    // Audited exception: this exact upstream file explicitly identifies its MIT license.
    if (!record.license && name === 'khroma' && item.version === '2.1.0') {
      const evidence = record.documents.find(d => d.originalPath === 'license');
      if (evidence && fs.readFileSync(path.join(directory, 'license'), 'utf8').startsWith('The MIT License (MIT)\n') && fs.readFileSync(path.join(directory, 'license'), 'utf8').includes('Copyright (c) 2019-present Fabio Spampinato, Andrew Maney')) {
        record.license = 'MIT'; record.licenseEvidence = `${location}/license (explicit license title; not inferred from absent lock metadata)`;
      }
    }
  } else {
    // 不记录 installed（宿主状态）；证据只来自 audited 上游归档，跨 OS 逐字节一致。
    if (!collect(record, null)) issue(record, 'PACKAGE_NOT_INSTALLED', platformConstrained
      ? 'Platform-constrained package has no exact-archive audited upstream license evidence; run scripts/collect-upstream-license-evidence.mjs to add it.'
      : 'Locked package is not installed on this host and no exact-archive audited upstream license evidence is available.');
  }
  if (!record.license) issue(record, 'UNKNOWN_LICENSE', 'Neither lock/package metadata nor an explicitly audited local license supplies a license identifier.');
  if (!record.projectOwned && !record.source.archiveURL) issue(record, 'NO_EXACT_SOURCE_URL', 'No exact-version source archive URL is recorded in the npm lockfile.');
  records.push(record);
}

// Do not filter platform: Cargo metadata resolves the conservative all-target dependency set.
// No --all-features: these are the lockfile dependencies for this project's selected/default features.
const cargoArgs = ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--format-version', '1', '--locked', '--offline'];
const metadata = JSON.parse(execFileSync('cargo', cargoArgs, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }));
const workspace = new Set(metadata.workspace_members);
for (const pkg of metadata.packages.filter(p => !workspace.has(p.id)).sort((a, b) => compare(a.id, b.id))) {
  const record = {
    ecosystem: 'cargo', name: pkg.name, version: pkg.version, location: pkg.id,
    dependencyClass: 'all-targets-conservative-superset', license: pkg.license || null,
    licenseEvidence: pkg.license ? 'upstream Cargo.toml via cargo metadata' : null,
    source: { cargoSource: pkg.source, archiveURL: null, registryMetadataURL: null, repositoryURL: repositoryURL(pkg.repository) },
    review: [],
  };
  if (pkg.source === 'registry+https://github.com/rust-lang/crates.io-index' || pkg.source === 'sparse+https://index.crates.io/') {
    record.source.archiveURL = `https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`;
    record.source.registryMetadataURL = `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}`;
  } else if (pkg.source?.startsWith('git+')) {
    record.source.exactGitSource = pkg.source;
    issue(record, 'NON_REGISTRY_SOURCE_REVIEW', 'Git source and revision are recorded; source availability and archive retention require review.');
  } else issue(record, 'NO_EXACT_SOURCE_URL', 'Non-crates.io dependency needs an explicit corresponding-source retrieval location.');
  const directory = path.dirname(pkg.manifest_path);
  collect(record, directory, [pkg.license_file]);
  if (!record.license) issue(record, 'UNKNOWN_LICENSE', 'Cargo metadata has no license expression; a license_file is evidence for manual review, not an inferred SPDX expression.');
  records.push(record);
}

const sourceVerification = verifyCorrespondingSources({ root, allowUnresolved: true });
if (sourceVerification.errors.length) throw new Error(`Corresponding-source evidence invalid: ${JSON.stringify(sourceVerification.errors)}`);
const sourceNotices = [];
for (const record of records) {
  if (record.name === 'dompurify' && /MPL-2\.0.*OR.*Apache-2\.0/.test(record.license ?? '')) record.selectedLicense = 'Apache-2.0';
  if (['option-ext', 'cssparser', 'cssparser-macros', 'dtoa-short', 'selectors'].includes(record.name) && record.ecosystem === 'cargo' && record.license?.includes('MPL-2.0')) {
    const local = record.name === 'option-ext' ? 'option-ext' : 'mpl-crates';
    record.correspondingSource = {
      license: 'MPL-2.0', exactVersion: record.version,
      archiveURL: record.source.archiveURL,
      repositoryPath: `compliance/third-party-sources/${local}/`,
      repositoryURL: `https://github.com/sylx-c/ZiEdit/tree/master/compliance/third-party-sources/${local}/`,
      statement: `The exact Source Code Form of ${record.name} ${record.version}, its original notices, source checksum and unmodified-source inventory are published in the ZiEdit source repository at compliance/third-party-sources/${local}/ (see repository URL below). The source archive is also available from the exact upstream URL below. Local registry source bytes were compared to the archive; project modifications would require updated source and notice evidence.`,
    };
  }
  if (record.name === 'elkjs' && record.ecosystem === 'npm' && record.license?.includes('EPL-2.0')) {
    const fixedSource = readJSON(path.join(root, 'compliance/third-party-sources/elkjs/manifest.json'));
    record.correspondingSource = fixedSource.status === 'SOURCE_BUILD_VERIFIED' && sourceVerification.releaseAllowed ? {
      license: 'EPL-2.0', exactVersion: fixedSource.version,
      repositoryPath: 'compliance/third-party-sources/elkjs/',
      repositoryURL: 'https://github.com/sylx-c/ZiEdit/tree/master/compliance/third-party-sources/elkjs/',
      archiveURL: 'https://github.com/sylx-c/ZiEdit/blob/master/compliance/third-party-sources/elkjs/' + fixedSource.sourceArchive,
      statement: 'The original unpinned generated ELK input is not distributed. ZiEdit uses the fixed-source 0.9.3-ziedit-source.1 rebuild with complete source, original component licenses, generated Java, exact locks, modifications and reproducibility proof published in the ZiEdit source repository at compliance/third-party-sources/elkjs/ (see repository and source archive URLs below). The npm elkjs entry is an upstream dependency identity, not the redistributed engine binary.',
    } : {
      license: 'EPL-2.0', exactVersion: record.version,
      // Upstream tag 0.9.3 resolves to this commit (verified via GitHub refs API).
      archiveURL: record.version === '0.9.3' ? 'https://github.com/kieler/elkjs/archive/a8304cf79fde75bc2ab1a89d28320f53f8637436.tar.gz' : `https://github.com/kieler/elkjs/archive/refs/tags/${record.version}.tar.gz`,
      sourceTreeURL: record.version === '0.9.3' ? 'https://github.com/kieler/elkjs/tree/a8304cf79fde75bc2ab1a89d28320f53f8637436' : `https://github.com/kieler/elkjs/tree/${record.version}`,
      additionalSourceRepositoryURL: 'https://github.com/eclipse/elk',
      sourceCorrespondenceEvidenceURL: record.version === '0.9.3' ? 'https://raw.githubusercontent.com/kieler/elkjs/a8304cf79fde75bc2ab1a89d28320f53f8637436/build.gradle' : `https://github.com/kieler/elkjs/blob/${record.version}/build.gradle`,
      packagedProgramURL: record.source.archiveURL,
      statement: `The source code of elkjs ${record.version} is available under the Eclipse Public License 2.0 from the upstream source tree and source archive below. The npm archive contains the packaged program; the upstream repository additionally supplies JavaScript source and build instructions and identifies separately hosted ELK/Java build inputs. Recipients may obtain corresponding source using those URLs. Downstream modifications, if any, and completeness of the ELK build inputs must be reviewed before release.`,
    };
    if (!sourceVerification.releaseAllowed) issue(record, 'CORRESPONDING_SOURCE_REVIEW', 'elkjs build.gradle copies ELK Java source from a separate eclipse/elk checkout. Its exact matching ELK revision and complete corresponding source have not been established by this local collector. Review the additional source repository and retain the matching source before release; the elkjs source archive alone is not certified complete.');
  }
  if (record.correspondingSource) sourceNotices.push({ ecosystem: record.ecosystem, name: record.name, version: record.version, ...record.correspondingSource });
  record.evidenceStatus = record.review.length ? 'REQUIRES_REVIEW' : 'LOCAL_TEXT_COLLECTED_NOT_LEGAL_CLEARANCE';
}
const counts = {
  npm: records.filter(r => r.ecosystem === 'npm').length,
  npmInstalled: records.filter(r => r.ecosystem === 'npm' && r.installed).length,
  npmDevelopmentOnly: records.filter(r => r.ecosystem === 'npm' && r.dependencyClass === 'development-only').length,
  cargo: records.filter(r => r.ecosystem === 'cargo').length,
  packagesWithReviewItems: records.filter(r => r.review.length).length,
  reviewItems: issues.length,
  collectedDocuments: records.reduce((n, r) => n + r.documents.length, 0),
  collectedTextBytes: [...generated.values()].reduce((n, b) => n + b.length, 0),
};
const scope = {
  npm: 'Every non-root package-lock.json entry, including development-only and optional packages. Development flags come from the lockfile; production-or-optional does not prove inclusion in the emitted application.',
  cargo: 'cargo metadata --locked --offline without --filter-platform: all target triples in the resolved dependency graph, including build/dev/transitive dependencies; conservative superset, not a per-binary linkage claim. Workspace members excluded. --all-features is not enabled.',
  evidence: 'Original bytes of LICENSE/LICENCE/COPYING/NOTICE/COPYRIGHT/UNLICENSE files and license/notice directory contents recursively found in local package trees, excluding nested node_modules, VCS directories and target. Symlinks are skipped. Collection is not a legal-compliance decision; empty/no standalone license is reported.',
  sourceURLs: 'Package archive URLs and lock integrity are recorded. Audited supplements were fetched separately from exact npm/crates archives or pinned commits and are verified against the current lock; original bytes and linkage evidence are in compliance/third-party-sources/license-evidence. Source archives are retained for the recorded MPL/EPL/native components.',
  exclusions: 'Local vendored renderers/fonts, OS/WebView runtimes, unlisted embedded third-party components, upstream bundled code without separately named notices, modified downstream source, patents, trademarks and commercial-service terms need separate review.',
};
emit('manifest.json', JSON.stringify({ schemaVersion: 1, generator: 'scripts/generate-third-party-licenses.mjs', inputSHA256: { 'package-lock.json': sha(fs.readFileSync(npmLockPath)), 'src-tauri/Cargo.lock': sha(fs.readFileSync(path.join(root, 'src-tauri/Cargo.lock'))), 'src-tauri/Cargo.toml': sha(fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'))) }, cargoCommand: ['cargo', ...cargoArgs], scope, counts, packages: records }, null, 2) + '\n');
emit('review-required.json', JSON.stringify({ schemaVersion: 1, meaning: 'Open evidence gaps, never automatically approved. Missing optional packages require target-specific evidence before distribution.', items: issues }, null, 2) + '\n');
emit('SOURCE-OFFERS.txt', 'CORRESPONDING SOURCE AVAILABILITY NOTICES\n\n' + sourceNotices.map(s => `${s.name} ${s.version} (${s.ecosystem}; ${s.license})\n${s.statement}\n${s.repositoryURL ? `Source in ZiEdit repository: ${s.repositoryURL}\n` : ''}Source archive: ${s.archiveURL}\n${s.sourceTreeURL ? `Source tree: ${s.sourceTreeURL}\n` : ''}${s.additionalSourceRepositoryURL ? `Additional ELK Java sources (matching revision requires review): ${s.additionalSourceRepositoryURL}\nBuild evidence: ${s.sourceCorrespondenceEvidenceURL}\n` : ''}${s.packagedProgramURL ? `Packaged program: ${s.packagedProgramURL}\n` : ''}`).join('\n') + '\nThese notices provide retrieval information for corresponding source; the complete evidence trees are published in the ZiEdit repository under compliance/. They are not a substitute for supplying any modified covered source or verifying correspondence with the distributed binary. See manifest.json for scope and limitations.\n');
emit('README.md', `# Third-party license texts for ZiEdit\n\nGenerated by \`node scripts/generate-third-party-licenses.mjs\`. No network access or dependency installation is performed. This directory is under Vite's default public directory and is copied into the application web assets by Vite.\n\n- [Package inventory and provenance](manifest.json): ${counts.npm} locked npm packages (${counts.npmInstalled} locally installed; ${counts.npmDevelopmentOnly} development-only), ${counts.cargo} Cargo dependencies across all resolved targets.\n- [Open evidence gaps](review-required.json): ${counts.reviewItems} items affecting ${counts.packagesWithReviewItems} packages. Missing files do **not** pass.\n- [MPL/EPL corresponding-source notices](SOURCE-OFFERS.txt).\n- [Human-readable package list](PACKAGES.md).\n- Original documents are under \`texts/npm/\` and \`texts/cargo/\`; the inventory records original package-relative paths, byte lengths and SHA-256 digests. ${counts.collectedDocuments} documents, ${counts.collectedTextBytes} original bytes. Copyright notices are retained without replacing them with generic SPDX templates.\n\n## Regeneration and verification\n\nUse the locked local npm installation (including dev dependencies) and populated Cargo cache. Run the generator after dependency changes and before a release. \`--check\` compares all generated bytes and detects stale files without writing; \`--strict\` returns nonzero for any unresolved evidence item. Ordinary generation writes evidence and reports gaps with exit code 0; that exit code means collection succeeded, **not** that release compliance passed. Run with \`--check --strict\` when a release gate must reject unresolved gaps.\n\nGeneration is deterministic for the same lockfiles, manifests, selected Cargo features and installed local package contents. It intentionally contains no generation timestamp or host-specific cache paths. A different OS may install additional npm optional packages and therefore improve its evidence set; retain and review the results for every distribution target. No automatic build hook is added by this script.\n\n## Coverage and limits\n\n${Object.entries(scope).map(([key, value]) => `- **${key}**: ${value}`).join('\n')}\n\nLicense expressions record upstream declarations, including AND/OR choices. DOMPurify explicitly uses the Apache-2.0 branch; r-efi audited supplements select MIT. Selected branches and full original grants are retained in records. Other expressions are checked against the free/open policy, and AND obligations retain all applicable notices. Text collection alone is not legal clearance; exact source correspondence and installed-package delivery must also pass the project gate.\n`);
emit('PACKAGES.md', '# Package inventory\n\nDevelopment flags identify lockfile classification, not proof of bundling. Review status is evidence collection only. See [scope](README.md) and [open items](review-required.json).\n\n| Ecosystem | Package | Version | Dependency class | Declared license | Text files | Evidence |\n|---|---|---|---|---|---:|---|\n' + records.map(r => `| ${r.ecosystem} | ${r.name} | ${r.version} | ${r.dependencyClass} | ${(r.license || 'UNKNOWN').replaceAll('|', '\\|')} | ${r.documents.length} | ${r.review.length ? 'REQUIRES_REVIEW: ' + r.review.map(i => i.code).join(', ') : 'LOCAL_TEXT_COLLECTED'} |`).join('\n') + '\n');

// Track only this generator's own files; never recursively delete an arbitrary directory.
const trackingName = '.generated-files.json';
const trackingPath = path.join(output, trackingName);
const previous = fs.existsSync(trackingPath) ? readJSON(trackingPath) : [];
if (!Array.isArray(previous) || previous.some(p => typeof p !== 'string' || p.startsWith('/') || p.split(/[\\/]/).includes('..') || path.isAbsolute(p))) throw new Error('Unsafe generated-file tracker');
emit(trackingName, JSON.stringify([...generated.keys(), trackingName].sort(compare), null, 2) + '\n');
const stale = previous.filter(p => !generated.has(p));
if (args.has('--check')) {
  const changed = [...generated].filter(([p, content]) => !fs.existsSync(path.join(output, p)) || !fs.readFileSync(path.join(output, p)).equals(content)).map(([p]) => p);
  if (changed.length || stale.length) {
    console.error(JSON.stringify({ generatedFilesDiffer: changed, staleFiles: stale }, null, 2));
    process.exitCode = 1;
  }
} else {
  for (const [relative, content] of generated) {
    const destination = path.join(output, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  for (const relative of stale) {
    const destination = path.resolve(output, relative);
    if (!destination.startsWith(output + path.sep)) throw new Error('Refusing deletion outside generated output');
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
  }
}
console.log(JSON.stringify({ ...counts, check: args.has('--check'), strict: args.has('--strict'), output: 'public/third-party-licenses', issueCounts: Object.fromEntries([...new Set(issues.map(i => i.code))].sort(compare).map(code => [code, issues.filter(i => i.code === code).length])) }, null, 2));
if (args.has('--strict') && issues.length) process.exitCode = 2;
