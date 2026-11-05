#!/usr/bin/env node
/**
 * Offline integrity/correspondence gate for the EPL/MPL source distribution.
 * Default: fail on unresolved source correspondence. --allow-unresolved is
 * evidence collection only, never a release pass. No downloads or mutations.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELKJS_COMMIT = 'a8304cf79fde75bc2ab1a89d28320f53f8637436';
const ELK_BASELINE = '62d5909f96fad541bc101ad52dabaece6b7eab7e';
const OPTION_SHA256 = '04744f49eae99ab78e0d5c0b603ab218f515ea8cfe5a456d7629ad883a3b6e7d';
const FIXED_SOURCE_SHA256 = '34803a92f834e40029f5b20840a2968fa5a95b51d650843100c09ff6f4714994';
const FIXED_SOURCE_INVENTORY_SHA256 = '4ae86fbf00ef5fb54e2474150799360c01fb6124091131bbdb0ff434fe606d05';
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

// Read archives without extracting paths to disk. Honor PAX/GNU long filenames.
function readTarGzip(filename) {
  const bytes = gunzipSync(fs.readFileSync(filename), { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map();
  let nextName;
  const field = (at, length) => bytes.subarray(at, at + length).toString('utf8').split('\0')[0];
  for (let at = 0; at + 512 <= bytes.length;) {
    const name = field(at, 100);
    if (!name) break;
    const size = Number.parseInt(field(at + 124, 12).trim(), 8) || 0;
    requireThat(Number.isSafeInteger(size) && size >= 0 && at + 512 + size <= bytes.length, `Invalid tar size in ${filename}`);
    const storedChecksum = Number.parseInt(field(at + 148, 8).trim(), 8);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : bytes[at + i];
    requireThat(checksum === storedChecksum, `Invalid tar header checksum in ${filename}`);
    const type = String.fromCharCode(bytes[at + 156]);
    const contents = bytes.subarray(at + 512, at + 512 + size);
    const prefix = field(at + 345, 155);
    if (type === 'L') {
      nextName = contents.toString('utf8').replace(/\0.*$/s, '');
    } else if (type === 'x' || type === 'g') {
      // PAX records are byte-counted; do not split on spaces inside the value.
      for (let pos = 0; pos < contents.length;) {
        const space = contents.indexOf(32, pos);
        requireThat(space > pos, `Invalid PAX record in ${filename}`);
        const length = Number(contents.subarray(pos, space).toString());
        requireThat(length > space - pos && pos + length <= contents.length, `Invalid PAX length in ${filename}`);
        const record = contents.subarray(space + 1, pos + length - 1).toString('utf8');
        if (record.startsWith('path=')) nextName = record.slice(5);
        pos += length;
      }
    } else {
      const fullName = nextName ?? (prefix ? `${prefix}/${name}` : name);
      nextName = undefined;
      requireThat(!fullName.startsWith('/') && !fullName.split('/').includes('..'), `Unsafe archive path ${fullName}`);
      if (type === '0' || type === '\0') {
        requireThat(!files.has(fullName), `Duplicate tar entry ${fullName}`);
        files.set(fullName, contents);
      }
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  requireThat(files.size > 0, `No regular files in ${filename}`);
  return files;
}

function checkInventory(base, manifest) {
  requireThat(manifest.schemaVersion === 1 && Array.isArray(manifest.files) && manifest.files.length > 0, `Invalid source manifest: ${base}`);
  const names = new Set();
  for (const item of manifest.files) {
    requireThat(!names.has(item.path), `Duplicate inventory path ${item.path}`);
    names.add(item.path);
    const target = path.resolve(base, item.path);
    requireThat(target.startsWith(`${path.resolve(base)}${path.sep}`), `Source manifest path escapes directory: ${item.path}`);
    const bytes = fs.readFileSync(target);
    requireThat(bytes.length === item.bytes && digest(bytes) === item.sha256, `Source artifact changed: ${target}`);
  }
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    requireThat(!entry.isSymbolicLink(), `Unverified source artifact symlink: ${path.join(directory, entry.name)}`);
    return entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)];
  });
  for (const filename of walk(base)) {
    const relative = path.relative(base, filename).replaceAll(path.sep, '/');
    requireThat(relative === 'manifest.json' || names.has(relative), `Unlisted source artifact: ${filename}`);
  }
  return names.size;
}

function findCargoSources(root, name = 'option-ext', version = '0.2.0') {
  const homes = new Set([process.env.CARGO_HOME, path.join(os.homedir(), '.cargo')].filter(Boolean));
  const result = [];
  for (const home of homes) {
    const src = path.join(home, 'registry', 'src');
    if (!fs.existsSync(src)) continue;
    for (const registry of fs.readdirSync(src, { withFileTypes: true })) {
      if (!registry.isDirectory()) continue;
      const candidate = path.join(src, registry.name, `${name}-${version}`);
      if (fs.existsSync(candidate)) result.push(candidate);
    }
  }
  // A vendored replacement is not silently ignored.
  for (const candidate of [path.join(root, 'vendor', name), path.join(root, 'vendor', `${name}-${version}`), path.join(root, 'src-tauri', 'vendor', name)]) {
    if (fs.existsSync(candidate)) result.push(candidate);
  }
  return [...new Set(result)];
}

export function verifyCorrespondingSources({ root = ROOT, allowUnresolved = false } = {}) {
  const report = { schemaVersion: 1, ok: false, releaseAllowed: false, checks: [], unresolved: [], errors: [], skipped: [] };
  const run = (name, fn) => { try { const result = fn(); report.checks.push({ name, result }); } catch (error) { report.errors.push({ name, message: error.message }); } };
  const base = path.join(root, 'compliance', 'third-party-sources');
  const elk = path.join(base, 'elkjs');
  const opt = path.join(base, 'option-ext');
  let elkManifest;
  let optionManifest;
  run('elkjs artifact inventory', () => { elkManifest = json(path.join(elk, 'manifest.json')); return `${checkInventory(elk, elkManifest)} files verified`; });
  run('option-ext artifact inventory', () => { optionManifest = json(path.join(opt, 'manifest.json')); return `${checkInventory(opt, optionManifest)} files verified`; });

  run('option-ext exact Cargo source', () => {
    const archive = fs.readFileSync(path.join(opt, 'option-ext-0.2.0.crate'));
    requireThat(digest(archive) === OPTION_SHA256, 'option-ext original crate checksum differs');
    const lock = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8');
    const entry = lock.split('[[package]]').find(block => /^name = "option-ext"\s*$/m.test(block));
    requireThat(entry && /^version = "0\.2\.0"\s*$/m.test(entry), 'Cargo lockfile option-ext version changed');
    requireThat(entry.includes(`checksum = "${OPTION_SHA256}"`) && entry.includes('source = "registry+https://github.com/rust-lang/crates.io-index"'), 'Cargo lockfile source identity differs');
    const registry = json(path.join(opt, 'registry-metadata.json')).version;
    requireThat(registry.crate === 'option-ext' && registry.num === '0.2.0' && registry.checksum === OPTION_SHA256 && registry.license === 'MPL-2.0', 'crates.io exact-version metadata differs');
    requireThat(optionManifest?.status === 'SOURCE_FORM_VERIFIED' && optionManifest?.modified === false, 'option-ext manifest status differs');
    const files = readTarGzip(path.join(opt, 'option-ext-0.2.0.crate'));
    const inventory = json(path.join(opt, 'source-inventory.json'));
    requireThat(files.size === inventory.length, 'option-ext source inventory omits files');
    for (const item of inventory) {
      const bytes = files.get(`option-ext-0.2.0/${item.path}`);
      requireThat(bytes && bytes.length === item.bytes && digest(bytes) === item.sha256, `option-ext archived source differs: ${item.path}`);
    }
    for (const required of ['src/lib.rs', 'src/impl.rs', 'Cargo.toml', 'Cargo.toml.orig', 'LICENSE.txt', '.cargo_vcs_info.json']) requireThat(files.has(`option-ext-0.2.0/${required}`), `Missing option-ext build/source file ${required}`);
    const vcs = JSON.parse(files.get('option-ext-0.2.0/.cargo_vcs_info.json').toString());
    requireThat(vcs.git.sha1 === '272f22fc9ea1ac6b08f01704af52c4ac338df4e2', 'option-ext VCS identity differs');
    const caches = findCargoSources(root);
    for (const cache of caches) {
      for (const item of inventory) requireThat(digest(fs.readFileSync(path.join(cache, item.path))) === item.sha256, `Modified installed Cargo source: ${cache}/${item.path}`);
      const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
      const allowed = new Set(inventory.map(item => item.path));
      for (const filename of walk(cache)) {
        const rel = path.relative(cache, filename).replaceAll(path.sep, '/');
        if (/\.(rs|toml)$/.test(rel)) requireThat(allowed.has(rel), `Extra local build source absent from archive: ${filename}`);
      }
    }
    if (!caches.length) report.skipped.push('Cargo registry source cache absent; original archive and Cargo lock identity verified, no claim about a past build cache.');
    return { archiveSha256: OPTION_SHA256, sourceFiles: inventory.length, unmodifiedInstalledCaches: caches.length };
  });

  run('additional MPL crates exact Cargo sources', () => {
    const dir = path.join(base, 'mpl-crates');
    const manifest = json(path.join(dir, 'manifest.json'));
    const pins = new Map([
      ['cssparser@0.37.0', '8c9cdaae01d5ed7882b04d795e7f752f46ff52d2fa3b50a20d28c464510bba98'],
      ['cssparser-macros@0.7.1', 'd045de693cb712d0b22c6a64be5b953f67b3ce00ab5ad3dd5d8b441886ab8e1a'],
      ['dtoa-short@0.3.5', 'cd1511a7b6a56299bd043a9c167a6d2bfb37bf84a6dfceaba651168adfb43c87'],
      ['selectors@0.38.0', '8adfa1c298912827b8a28b223b3b874357397ae706e6190acd9bf28cee99114d'],
    ]);
    const artifactCount = checkInventory(dir, manifest);
    requireThat(manifest.status === 'SOURCE_FORM_VERIFIED' && manifest.packages?.length === pins.size, 'MPL package coverage changed');
    const blocks = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8').split('[[package]]');
    const checked = [];
    for (const item of manifest.packages) {
      const identity = `${item.name}@${item.version}`;
      const expected = pins.get(identity);
      requireThat(expected && item.archiveSha256 === expected && item.status === 'SOURCE_FORM_VERIFIED' && item.modified === false, `MPL identity/status changed: ${identity}`);
      pins.delete(identity);
      requireThat(item.archive === `${item.name}-${item.version}/${item.name}-${item.version}.crate` && item.metadata === `${item.name}-${item.version}/registry-metadata.json` && item.inventory === `${item.name}-${item.version}/source-inventory.json`, `MPL source paths differ: ${identity}`);
      const bytes = fs.readFileSync(path.join(dir, item.archive));
      requireThat(digest(bytes) === expected, `MPL archive checksum differs: ${identity}`);
      const lock = blocks.find(block => block.includes(`name = "${item.name}"`) && block.includes(`version = "${item.version}"`));
      requireThat(lock?.includes(`checksum = "${expected}"`) && lock.includes('source = "registry+https://github.com/rust-lang/crates.io-index"'), `Cargo lock identity differs: ${identity}`);
      const metadata = json(path.join(dir, item.metadata)).version;
      requireThat(metadata.crate === item.name && metadata.num === item.version && metadata.checksum === expected && metadata.license === 'MPL-2.0', `Official MPL metadata differs: ${identity}`);
      const archive = readTarGzip(path.join(dir, item.archive));
      const inventory = json(path.join(dir, item.inventory));
      requireThat(archive.size === inventory.length && inventory.length === item.sourceFileCount, `MPL archive inventory incomplete: ${identity}`);
      for (const file of inventory) {
        const content = archive.get(`${item.name}-${item.version}/${file.path}`);
        requireThat(content && content.length === file.bytes && digest(content) === file.sha256, `MPL source differs: ${identity}/${file.path}`);
      }
      const vcs = JSON.parse(archive.get(`${item.name}-${item.version}/.cargo_vcs_info.json`).toString());
      requireThat(vcs.git.sha1 === item.upstreamCommit, `MPL VCS identity differs: ${identity}`);
      const embeddedLicense = inventory.some(file => /^LICENSE(?:\.|$)/i.test(file.path));
      if (!embeddedLicense) {
        requireThat(identity === 'selectors@0.38.0' && item.licenseSupplement?.path === 'selectors-0.38.0/MPL-2.0-supplement.txt', `Missing MPL license body: ${identity}`);
        const supplement = fs.readFileSync(path.join(dir, item.licenseSupplement.path));
        requireThat(digest(supplement) === 'fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85', 'Official MPL supplement differs');
        const sourceHeader = archive.get('selectors-0.38.0/lib.rs')?.toString();
        requireThat(/Mozilla Public\s*\n \* License, v\. 2\.0/.test(sourceHeader ?? ''), 'selectors source MPL2 notice missing');
      }
      requireThat(inventory.some(file => file.path === 'Cargo.toml') && inventory.some(file => /\.rs$/.test(file.path)), `MPL source/build missing: ${identity}`);
      const caches = findCargoSources(root, item.name, item.version);
      const allowed = new Set(inventory.map(file => file.path));
      const walk = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : [path.join(folder, entry.name)]);
      for (const cache of caches) {
        for (const file of inventory) requireThat(digest(fs.readFileSync(path.join(cache, file.path))) === file.sha256, `Modified installed Cargo source: ${identity}/${file.path}`);
        for (const filename of walk(cache)) {
          const rel = path.relative(cache, filename).replaceAll(path.sep, '/');
          if (/\.(rs|toml)$/.test(rel)) requireThat(allowed.has(rel), `Extra MPL build source: ${filename}`);
        }
      }
      if (!caches.length) report.skipped.push(`${identity}: local Cargo source cache absent; archive and lock verified only.`);
      checked.push({ identity, sourceFiles: inventory.length, unmodifiedInstalledCaches: caches.length });
    }
    requireThat(pins.size === 0, 'MPL packages omitted');
    return { artifacts: artifactCount, packages: checked };
  });

  if (elkManifest?.status !== 'SOURCE_BUILD_VERIFIED') {
  run('elkjs exact npm and repository artifacts', () => {
    const metadata = json(path.join(elk, 'npm-metadata.json'));
    requireThat(metadata.name === 'elkjs' && metadata.version === '0.9.3' && metadata.gitHead === ELKJS_COMMIT && metadata.license === 'EPL-2.0', 'elkjs npm identity differs');
    const npmBytes = fs.readFileSync(path.join(elk, 'elkjs-0.9.3.npm.tgz'));
    const [algorithm, expected] = metadata.dist.integrity.split('-');
    requireThat(algorithm === 'sha512' && digest(npmBytes, algorithm, 'base64') === expected, 'elkjs npm registry integrity differs');
    const npm = readTarGzip(path.join(elk, 'elkjs-0.9.3.npm.tgz'));
    const repo = readTarGzip(path.join(elk, `elkjs-${ELKJS_COMMIT}.tar.gz`));
    const prefix = `elkjs-${ELKJS_COMMIT}/`;
    let compared = 0;
    for (const [name, bytes] of npm) {
      if (!name.startsWith('package/lib/')) continue;
      const relative = name.slice('package/'.length);
      requireThat(repo.get(`${prefix}${relative}`)?.equals(bytes), `npm/repository difference: ${relative}`);
      const installed = path.join(root, 'node_modules', 'elkjs', relative);
      if (fs.existsSync(installed)) requireThat(fs.readFileSync(installed).equals(bytes), `Modified installed elkjs: ${relative}`);
      compared++;
    }
    requireThat(compared >= 8, 'Incomplete elkjs published lib comparison');
    for (const required of ['src/js/elk-api.js', 'src/java/org/eclipse/elk/js/ElkJs.java', 'gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar', 'LICENSE.md']) requireThat(repo.has(prefix + required), `Missing elkjs source/build material: ${required}`);
    for (const file of elkManifest?.files ?? []) {
      if (!file.path.startsWith('build-materials/')) continue;
      const relative = file.path.slice('build-materials/'.length);
      requireThat(repo.get(prefix + relative)?.equals(fs.readFileSync(path.join(elk, file.path))), `Build-material copy differs: ${relative}`);
    }
    const proof = json(path.join(elk, 'js-correspondence.json'));
    requireThat(proof.mermaidVersion === '12.2.0', 'Mermaid source correspondence version changed');
    const bundled = npm.get('package/lib/elk.bundled.js');
    requireThat(bundled && digest(bundled) === proof.input.sha256 && bundled.length === proof.input.bytes, 'ELK source-map input identity differs');
    const chunk = fs.readFileSync(path.join(root, proof.chunk.path));
    requireThat(digest(chunk) === proof.chunk.sha256 && chunk.length === proof.chunk.bytes, 'Vendored ELK chunk changed: renew source correspondence');
    const rendererManifest = json(path.join(root, 'public', 'renderers', 'manifest.json'));
    requireThat(rendererManifest.roots?.mermaid === proof.mermaidVersion && rendererManifest.packages.some(p => p.name === 'elkjs' && p.version === '0.9.3'), 'Vendored renderer manifest versions differ');
    const mapPath = path.join(root, proof.sourceMap.path);
    if (fs.existsSync(mapPath)) {
      const mapBytes = fs.readFileSync(mapPath);
      requireThat(digest(mapBytes) === proof.sourceMap.sha256, 'Installed Mermaid source map changed');
      const map = JSON.parse(mapBytes);
      requireThat(map.sources[proof.sourceMap.sourceIndex] === proof.sourceMap.source, 'ELK source-map path changed');
      requireThat(Buffer.from(map.sourcesContent[proof.sourceMap.sourceIndex]).equals(bundled), 'ELK source map is not the exact published npm input');
      const installedChunk = path.join(root, 'node_modules', 'mermaid', 'dist', 'chunks', 'mermaid.esm.min', path.basename(proof.chunk.path));
      requireThat(fs.readFileSync(installedChunk).equals(chunk), 'Vendored ELK chunk differs from installed Mermaid');
    } else report.skipped.push('Installed Mermaid source map absent; saved exact JS correspondence and vendored chunk identity checked.');
    return { version: metadata.version, gitHead: metadata.gitHead, matchingLibFiles: compared, vendoredChunkSha256: proof.chunk.sha256 };
  });

  run('ELK baseline and known additional patch', () => {
    const ref = json(path.join(elk, 'elk-v0.9.1-ref.json'));
    requireThat(ref.ref === 'refs/tags/v0.9.1' && ref.object.sha === ELK_BASELINE, 'ELK baseline ref differs');
    const release = json(path.join(elk, 'release-0.9.3.json'));
    requireThat(release.tag_name === '0.9.3' && /Based on ELK 0\.9\.1/.test(release.body) && /elk\/pull\/955/.test(release.body), 'ELK release baseline/patch statement differs');
    const pr = json(path.join(elk, 'elk-pr-955.json'));
    requireThat(pr.number === 955 && pr.merge_commit_sha === '7ca51784e42a24201f29bc13e458728b6fc61cdc', 'ELK PR955 identity differs');
    const source = readTarGzip(path.join(elk, `elk-0.9.1-${ELK_BASELINE}.tar.gz`));
    const gradle = fs.readFileSync(path.join(elk, 'build-materials', 'build.gradle'), 'utf8');
    const modules = [...gradle.matchAll(/\$\{elkRepo\}\/plugins\/(org\.eclipse\.elk\.[^/]+)\/src/g)].map(match => match[1]);
    requireThat(modules.length === 11, 'ELK Java module input list changed');
    for (const module of modules) requireThat([...source.keys()].some(name => name.startsWith(`elk-${ELK_BASELINE}/plugins/${module}/src/`)), `ELK baseline misses source module ${module}`);
    requireThat(/melk:\s+'0\.10\.0-SNAPSHOT'/.test(gradle), 'ELK compiler snapshot identity changed');
    requireThat(elkManifest?.status === 'BLOCKED_JAVA_INPUT_UNVERIFIED' && Array.isArray(elkManifest.unresolved) && elkManifest.unresolved.length >= 2, 'ELK unresolved input must not silently become release-cleared');
    report.unresolved.push(...elkManifest.unresolved.map(item => ({ package: 'elkjs@0.9.3', ...item })));
    return { declaredBaseline: ELK_BASELINE, sourceModules: modules.length, correspondence: 'BASELINE_AND_KNOWN_PATCH_ONLY_NOT_EXACT_JAVA_INPUT' };
  });
  } else {
    run('fixed-source ELK build correspondence', () => {
      requireThat(elkManifest.name === 'elkjs' && elkManifest.version === '0.9.3-ziedit-source.1' && elkManifest.modified === true, 'Fixed-source replacement identity differs');
      requireThat(elkManifest.wrapperCommit === ELKJS_COMMIT && elkManifest.javaInputCommit === ELK_BASELINE, 'Fixed Java/wrapper input commits differ');
      requireThat(elkManifest.unresolved?.length === 0, 'New source build has unresolved source items');
      requireThat(elkManifest.sourceArchive === 'elkjs-0.9.3-ziedit-source.1.source.tar.gz' && elkManifest.sourceArchiveSha256 === FIXED_SOURCE_SHA256 && elkManifest.sourceInventorySha256 === FIXED_SOURCE_INVENTORY_SHA256 && elkManifest.sourceArchiveBytes === 23154050 && elkManifest.sourceFileCount === 16028, 'Audited fixed-source archive identity changed: review/rebuild required');
      const archivePath = path.join(elk, elkManifest.sourceArchive);
      const archiveBytes = fs.readFileSync(archivePath);
      requireThat(digest(archiveBytes) === elkManifest.sourceArchiveSha256 && archiveBytes.length === elkManifest.sourceArchiveBytes, 'Fixed source archive differs');
      const sources = readTarGzip(archivePath);
      const prefix = 'elkjs-0.9.3-ziedit-source.1/';
      const sourceInventoryBytes = sources.get(prefix + 'source-inventory.json');
      requireThat(sourceInventoryBytes && digest(sourceInventoryBytes) === elkManifest.sourceInventorySha256, 'Fixed source inventory identity differs');
      const inventory = JSON.parse(sourceInventoryBytes);
      requireThat(sources.size === inventory.length + 1 && sources.size === elkManifest.sourceFileCount, 'Fixed source archive file count differs');
      const seen = new Set();
      for (const item of inventory) {
        requireThat(!seen.has(item.path), `Duplicate fixed-source inventory entry: ${item.path}`);
        seen.add(item.path);
        const bytes = sources.get(prefix + item.path);
        requireThat(bytes && bytes.length === item.bytes && digest(bytes) === item.sha256, `Fixed corresponding source changed: ${item.path}`);
        requireThat(!item.path.startsWith('elkjs/lib/'), `Unknown old generated library redistributed: ${item.path}`);
        requireThat(!/(?:^|\/)elk-worker(?:\.min)?\.js$/.test(item.path), `Generated worker must not be in source-only archive: ${item.path}`);
      }
      for (const required of ['elkjs/src/js/elk-api.js', 'elkjs/src/java/org/eclipse/elk/js/ElkJs.java', 'elkjs/build.gradle', 'elkjs/gradle.lockfile', 'elkjs/package-lock.json', 'elkjs/gradle/verification-metadata.xml', 'patches/elk-pr-955.patch', 'runtime-source-inputs/manifest.json', 'build-scripts/build-js.mjs', 'verification/layout-comparison.json', 'verification/rebuilt-js-inventory.json', 'verification/upstream-tests-isolated-worker.log']) requireThat(sources.has(prefix + required), `Missing fixed-source material: ${required}`);
      const gradle = sources.get(prefix + 'elkjs/build.gradle').toString();
      requireThat(/melk:\s+'0\.9\.1'/.test(gradle) && !gradle.includes('0.10.0-SNAPSHOT') && gradle.includes('mavenCentral()'), 'Replacement build reintroduced unknown compiler snapshot/repository');
      requireThat(digest(sources.get(prefix + 'patches/elk-pr-955.patch')) === '7f204a6e304031b7898dca1f09865d4bb6c9b9b58bd185e56f82931ff1551ec3', 'Fixed Java patch differs');
      const sourceModules = [...gradle.matchAll(/\$\{elkRepo\}\/plugins\/(org\.eclipse\.elk\.[^/]+)\/src/g)].map(match => match[1]);
      requireThat(sourceModules.length === 11, 'Fixed replacement dropped Java input modules');
      for (const module of sourceModules) requireThat(inventory.some(item => item.path.startsWith(`elk/plugins/${module}/src/`)), `Source package lacks ELK module ${module}`);
      requireThat(inventory.some(item => item.path.startsWith('generated-java-inputs/elk/')) && inventory.some(item => item.path.startsWith('generated-java-inputs/xtend-gen/')), 'Actual generated Java inputs missing');
      const layout = JSON.parse(sources.get(prefix + 'verification/layout-comparison.json'));
      requireThat(layout.algorithms.equal && layout.algorithms.candidate.length === 12 && layout.options.equal && layout.options.candidateCount === 224 && layout.cases.length === 13 && layout.cases.every(item => item.referenceAccepted && item.candidateAccepted && item.exactOutputMatch), 'Recorded new layout/API comparison failed');
      const tests = sources.get(prefix + 'verification/upstream-tests-isolated-worker.log').toString();
      requireThat(/43 passing/.test(tests) && !/\d+ failing/.test(tests), 'Recorded upstream tests incomplete');
      const override = json(path.join(elk, 'override-manifest.json'));
      requireThat(override.kind === 'EXPLICIT_AUDITED_ENGINE_REPLACEMENT' && override.version === elkManifest.version, 'Runtime override identity differs');
      requireThat(override.original.sha256 === 'ae6173b625cc1ad5ac674fb95065c58235d07e9b184ae3265a447d1acf1c91fa', 'Original renderer comparison identity differs');
      requireThat(override.replacement.path === 'public/renderers/mermaid/chunks/mermaid.esm.min/elk-7HBNN7NY.mjs' && override.engine.path === 'public/renderers/mermaid/chunks/mermaid.esm.min/elk-ziedit-source.mjs', 'Override expanded beyond audited runtime paths');
      requireThat(override.replacement.sha256 === '550467c5b2b15f8701bc4a81149672df15a821db87e71151e69d4aa4fe87ae74' && override.engine.sha256 === '64902545445d8df7c0313000c6f276dd2d30972468b201cdb9984aac5508c64b', 'Audited replacement output hashes differ');
      const chunk = fs.readFileSync(path.join(root, override.replacement.path));
      const engine = fs.readFileSync(path.join(root, override.engine.path));
      requireThat(chunk.length === override.replacement.bytes && digest(chunk) === override.replacement.sha256, 'Replacement renderer is not installed or changed');
      requireThat(engine.length === override.engine.bytes && digest(engine) === override.engine.sha256, 'Replacement engine is not installed or changed');
      const newImport = 'import ZiEditRebuiltELK from "./elk-ziedit-source.mjs";\n';
      requireThat(chunk.toString().startsWith(newImport), 'Renderer does not use audited source engine');
      const preserved = chunk.toString().slice(newImport.length);
      const stub = 'var vfe=()=>ZiEditRebuiltELK;';
      const stubAt = preserved.indexOf(stub);
      requireThat(stubAt >= 0 && stubAt === preserved.lastIndexOf(stub), 'Engine replacement declaration not unique');
      requireThat(digest(Buffer.from(preserved.slice(0, stubAt))) === override.preservedRenderer.prefixSha256 && digest(Buffer.from(preserved.slice(stubAt + stub.length))) === override.preservedRenderer.suffixSha256, 'Mermaid renderer code outside engine replacement changed');
      const enginePrefix = '/* ZiEdit fixed-source ELK replacement; original upstream notices retained below. */\nconst module={exports:{}};const exports=module.exports;\n';
      const engineSuffix = '\nexport default module.exports;\n';
      const engineText = engine.toString();
      requireThat(engineText.startsWith(enginePrefix) && engineText.endsWith(engineSuffix), 'New engine wrapper shape differs');
      const compiled = Buffer.from(engineText.slice(enginePrefix.length, -engineSuffix.length));
      requireThat(digest(compiled) === '5b7df2330222dccb754c01b5324de88bc9244cf925492851b4ded3581a02ebf0' && digest(compiled) === override.sourceBundle.sha256, 'Engine is not the recorded fixed-source build output');
      const builtInventory = JSON.parse(sources.get(prefix + 'verification/rebuilt-js-inventory.json'));
      requireThat(builtInventory.find(item => item.path === 'elk.bundled.js')?.sha256 === digest(compiled), 'Source package output identity does not match runtime');
      requireThat(elkManifest.independentRebuildVerification === 'rebuild-verification.json', 'Independent public archive rebuild evidence missing');
      const rebuild = json(path.join(elk, 'rebuild-verification.json'));
      requireThat(rebuild.status === 'INDEPENDENT_PUBLIC_ARCHIVE_REBUILD_VERIFIED' && rebuild.sourceArchiveSha256 === FIXED_SOURCE_SHA256 && rebuild.dependencyVerification === 'strict' && rebuild.allNineOutputsByteIdentical && JSON.stringify(rebuild.outputs) === JSON.stringify(builtInventory), 'Independent public source rebuild outputs differ');
      const removed = override.removedOriginalDeclaration;
      requireThat(removed.characters === 1580569 && removed.sha256 === 'd001a7bacedef5ea0a4995d0ef07f5c67f187f7f32d05cd2341dfb510ef48b0e' && removed.absentFromReplacementChunk && removed.absentFromReplacementEngine, 'Old engine removal evidence differs');
      for (const forbidden of ['elkjs-0.9.3.npm.tgz', `elkjs-${ELKJS_COMMIT}.tar.gz`]) requireThat(!fs.existsSync(path.join(elk, forbidden)), `Unknown generated publisher bytes still publicly distributed: ${forbidden}`);
      return { version: elkManifest.version, sourceFiles: sources.size, algorithms: 12, options: 224, exactLayoutComparisons: 13, upstreamTests: 43, originalEngineDeclarationRemoved: true, sourceArchiveSha256: digest(archiveBytes) };
    });
  }
  report.releaseAllowed = report.errors.length === 0 && report.unresolved.length === 0;
  report.ok = report.errors.length === 0 && (allowUnresolved || report.unresolved.length === 0);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = new Set(process.argv.slice(2));
  const supported = new Set(['--allow-unresolved', '--json', '--check']);
  for (const arg of args) if (!supported.has(arg)) throw new Error(`Unknown argument: ${arg}`);
  const report = verifyCorrespondingSources({ allowUnresolved: args.has('--allow-unresolved') });
  if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    for (const check of report.checks) console.log(`PASS ${check.name}: ${typeof check.result === 'string' ? check.result : JSON.stringify(check.result)}`);
    for (const skipped of report.skipped) console.log(`LIMIT ${skipped}`);
    for (const error of report.errors) console.error(`FAIL ${error.name}: ${error.message}`);
    for (const item of report.unresolved) console.error(`UNRESOLVED ${item.package} ${item.id}: ${item.detail}`);
    console.log(report.releaseAllowed ? 'Corresponding-source release gate: PASS' : 'Corresponding-source release gate: BLOCKED');
    if (args.has('--allow-unresolved')) console.log('Evidence-only mode: unresolved correspondence is retained; this is not release approval.');
  }
  process.exitCode = report.ok ? 0 : 1;
}
