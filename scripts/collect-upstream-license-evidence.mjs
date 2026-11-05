#!/usr/bin/env node
/** Exact-version upstream license evidence collector. Node builtins only; no package installation/scripts.
 * node scripts/collect-upstream-license-evidence.mjs       collect/resume using retained HTTP evidence
 * node scripts/collect-upstream-license-evidence.mjs --check   offline digest/provenance verification
 * node scripts/collect-upstream-license-evidence.mjs --refresh-status   offline current/historical lock membership refresh
 * The generator consumes manifest.json packages[].documents[].path relative to evidence directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'compliance/third-party-sources/license-evidence');
const manifestPath = path.join(base, 'manifest.json');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const stableSort = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const relLegal = /^(?:licen[cs]es?|copying|notices?|copyrights?|unlicense)(?:$|[._ -])/i;
const licenseName = /^(?:licen[cs]e|copying|unlicense)(?:$|[._ -])/i;
const hasFullLicense = p => p.documents.some(d=>(licenseName.test(path.posix.basename(d.originalPath))||d.evidenceRole==='full-license-text')&&d.bytes>0);
async function supplementaryEvidence(p,entries,prefix,url,details) {
  if(p.name==='r-efi'&&['5.3.0','6.0.0'].includes(p.version)) {
    const authors=entries.get(prefix+'AUTHORS'), readme=entries.get(prefix+'README.md');
    if(!authors||!authors.toString('utf8').includes('AUTHORS-MIT:')||!authors.toString('utf8').includes('Permission is hereby granted, free of charge')||!authors.toString('utf8').includes('COPYRIGHT:'))throw Error('Reviewed r-efi AUTHORS evidence changed');
    attach(p,'archive/AUTHORS',authors,url,{...details,archivePath:prefix+'AUTHORS',evidenceRole:'full-license-text',manualEvidence:'AUTHORS contains the full MIT permission, warranty disclaimer and original copyright owners. README and Cargo metadata explicitly allow MIT OR Apache OR LGPL; MIT selected.'});
    if(readme)attach(p,'archive/README.md',readme,url,{...details,archivePath:prefix+'README.md',evidenceRole:'license-choice-notice'});
    p.selectedLicense='MIT';return;
  }
  const apache=(p.name==='cesu8'&&p.version==='1.1.0')||(['winapi-i686-pc-windows-gnu','winapi-x86_64-pc-windows-gnu'].includes(p.name)&&p.version==='0.4.0');
  const mpl=p.name==='selectors'&&p.version==='0.38.0';
  if(!apache&&!mpl)return;
  const sourceFiles=[...entries].filter(([name])=>name.startsWith(prefix)&&name.endsWith('.rs'));
  const linked=sourceFiles.some(([,bytes])=>apache?bytes.toString('utf8').includes('http://www.apache.org/licenses/LICENSE-2.0'):bytes.toString('utf8').includes('https://mozilla.org/MPL/2.0/'));
  if(!linked)throw Error('Reviewed source copyright/license URL not found');
  for(const [name,bytes]of sourceFiles)attach(p,`archive/${name.slice(prefix.length)}`,bytes,url,{...details,archivePath:name,evidenceRole:'original-copyright-and-license-notice'});
  const readme=entries.get(prefix+'README.md');if(readme)attach(p,'archive/README.md',readme,url,{...details,archivePath:prefix+'README.md',evidenceRole:'upstream-license-notice'});
  const official=apache?'https://www.apache.org/licenses/LICENSE-2.0.txt':'https://www.mozilla.org/media/MPL/2.0/index.txt';
  const bytes=await remote(official,true);
  if(apache&&!bytes.toString('utf8').includes('Apache License'))throw Error('Apache license response is not expected text');
  if(mpl&&!bytes.toString('utf8').includes('Mozilla Public License Version 2.0'))throw Error('MPL license response is not expected text');
  attach(p,`official/${apache?'Apache-2.0':'MPL-2.0'}.txt`,bytes,official,{evidenceRole:'full-license-text',manualEvidence:'Official versioned license text expressly invoked by the original copyright/license notices in this exact package archive. This is a separately identified standard-license supplement, not a fabricated upstream package file; original source copyright notices retained.'});
  p.selectedLicense=apache?'Apache-2.0':'MPL-2.0';
}
function save(relative, data) { const p = path.resolve(base, relative); if (!p.startsWith(base + path.sep)) throw Error('Unsafe evidence path'); fs.mkdirSync(path.dirname(p), { recursive:true }); fs.writeFileSync(p,data); }
function jsonSave(relative, data) { save(relative, JSON.stringify(data,null,2)+'\n'); }
const previous = fs.existsSync(manifestPath) ? readJSON(manifestPath) : null;
function dependencyMembership() {
  const npmPath=path.join(root,'package-lock.json'),cargoPath=path.join(root,'src-tauri/Cargo.lock');
  const npmBytes=fs.readFileSync(npmPath),cargoBytes=fs.readFileSync(cargoPath);
  const npm=JSON.parse(npmBytes),keys=new Set();
  for(const [location,item]of Object.entries(npm.packages||{}))if(location&&!item.link&&item.version)keys.add(`npm:${item.name||location.split('node_modules/').at(-1)}@${item.version}`);
  for(const block of cargoBytes.toString('utf8').split('[[package]]').slice(1)) {
    const name=block.match(/^name = "([^"]+)"/m)?.[1],version=block.match(/^version = "([^"]+)"/m)?.[1];if(name&&version)keys.add(`cargo:${name}@${version}`);
  }
  return {keys,inputSHA256:{'package-lock.json':hash(npmBytes),'src-tauri/Cargo.lock':hash(cargoBytes)}};
}
function markMembership(manifest) {
  const membership=dependencyMembership();
  for(const p of manifest.packages)p.dependencyStatus=membership.keys.has(`${p.ecosystem}:${p.name}@${p.version}`)?'CURRENT_LOCKED_DEPENDENCY':'HISTORICAL_NOT_IN_CURRENT_LOCKFILES';
  manifest.currentDependencyStatus={inputSHA256:membership.inputSHA256,meaning:'Membership is exact ecosystem/name/version against current lockfiles, independent of historical evidence collection status. Historical entries and review findings remain preserved, but are not current dependency evidence or unresolved runtime items.',activePackages:manifest.packages.filter(p=>p.dependencyStatus==='CURRENT_LOCKED_DEPENDENCY').length,historicalPackages:manifest.packages.filter(p=>p.dependencyStatus==='HISTORICAL_NOT_IN_CURRENT_LOCKFILES').length};
  return manifest;
}
if(process.argv.includes('--refresh-status')) {
  if(!previous)throw Error('No evidence manifest');markMembership(previous);jsonSave('manifest.json',previous);
  console.log(JSON.stringify({mode:'offline-status-refresh',...previous.currentDependencyStatus,historical:previous.packages.filter(p=>p.dependencyStatus==='HISTORICAL_NOT_IN_CURRENT_LOCKFILES').map(p=>({ecosystem:p.ecosystem,name:p.name,version:p.version,retainedReview:p.review}))},null,2));process.exit(0);
}
if (process.argv.includes('--check')) {
  if (!previous) throw Error('No evidence manifest');
  let checked=0;
  for (const p of previous.packages) for (const d of [...p.documents,...(p.provenanceDocuments||[])]) {
    const resolved = path.resolve(base,d.path); if (!resolved.startsWith(base+path.sep)) throw Error('Unsafe path');
    const bytes=fs.readFileSync(resolved); if (hash(bytes)!==d.sha256 || bytes.length!==d.bytes) throw Error(`Digest mismatch: ${d.path}`); checked++;
    if (!/^https:\/\//.test(d.sourceURL)) throw Error('Source URL absent');
  }
  markMembership(previous);
  const active=previous.packages.filter(p=>p.dependencyStatus==='CURRENT_LOCKED_DEPENDENCY'),historical=previous.packages.filter(p=>p.dependencyStatus==='HISTORICAL_NOT_IN_CURRENT_LOCKFILES');
  console.log(JSON.stringify({checkedDocuments:checked,retainedPackages:previous.packages.length,currentPackages:active.length,currentResolved:active.filter(p=>p.evidenceStatus==='UPSTREAM_TEXT_COLLECTED').length,currentUnresolved:active.filter(p=>p.review.length).length,historicalPackages:historical.map(p=>({ecosystem:p.ecosystem,name:p.name,version:p.version,retainedUnresolved:p.review.length>0}))},null,2));
  process.exit(0);
}
const sourceManifest = readJSON(path.join(root,'public/third-party-licenses/manifest.json'));
const lock = readJSON(path.join(root,'package-lock.json'));
const targetKeys = new Set((previous?.packages || []).map(p=>`${p.ecosystem}:${p.name}@${p.version}`));
for (const p of sourceManifest.packages) if (p.review.some(i=>['NO_STANDALONE_LICENSE','PACKAGE_NOT_INSTALLED'].includes(i.code))) targetKeys.add(`${p.ecosystem}:${p.name}@${p.version}`);
// 平台限定包必须全部持有固定归档证据：生成器对它们不读本机安装（跨 OS 确定性），
// 因此宿主机恰好装上的那些平台变体（如 Windows 上的 win32-x64）也必须有补充证据。
for (const [location,item] of Object.entries(lock.packages||{})) if (location.startsWith('node_modules/') && (((item.os?.length ?? 0) + (item.cpu?.length ?? 0)) > 0)) targetKeys.add(`npm:${item.name||location.split('node_modules/').at(-1)}@${item.version}`);
const targets = sourceManifest.packages.filter(p=>targetKeys.has(`${p.ecosystem}:${p.name}@${p.version}`));
const cargoLockEntries = fs.readFileSync(path.join(root,'src-tauri/Cargo.lock'),'utf8').split('[[package]]').slice(1);
function cargoChecksum(name,version) {
  const entry=cargoLockEntries.find(s=>s.match(/^name = "([^"]+)"/m)?.[1]===name&&s.match(/^version = "([^"]+)"/m)?.[1]===version);
  const checksum=entry?.match(/^checksum = "([^"]+)"/m)?.[1]; if(!checksum)throw Error('No exact Cargo.lock checksum'); return checksum;
}
const cargo = JSON.parse(execFileSync('cargo',['metadata','--manifest-path','src-tauri/Cargo.toml','--format-version','1','--locked','--offline'],{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024}));
const responses = new Map();
async function remote(url, retain=false) {
  const key=hash(url); const cached=path.join(base,`provenance/http/${key}.bin`);
  if(retain && fs.existsSync(cached)) return fs.readFileSync(cached);
  if(responses.has(url)) return responses.get(url);
  const pending=(async()=>{
    for(let attempt=0;attempt<3;attempt++) {
      try {
        const response=await fetch(url,{headers:{'User-Agent':'ZiEdit-license-evidence/1.0'},signal:AbortSignal.timeout(90000)});
        if(!response.ok) { const err=Error(`HTTP ${response.status}: ${url}`); err.status=response.status; throw err; }
        const bytes=Buffer.from(await response.arrayBuffer());
        if(retain) save(`provenance/http/${key}.bin`,bytes);
        return bytes;
      } catch(e) { if(attempt===2||e.status===404||e.status===403)throw e; }
    }
  })();
  responses.set(url,pending);
  try{return await pending;}catch(e){responses.delete(url);throw e;}
}
function tar(archive) {
  const bytes=gunzipSync(archive); const entries=new Map(); let extended={},longName=null;
  for(let offset=0;offset+512<=bytes.length;) {
    const h=bytes.subarray(offset,offset+512); if(h.every(x=>x===0))break;
    const string=(s,n)=>h.subarray(s,s+n).toString('utf8').replace(/\0.*$/s,'');
    const size=parseInt(string(124,12).trim()||'0',8); if(!Number.isFinite(size)||size<0)throw Error('Invalid tar size');
    let name=string(0,100),prefix=string(345,155); if(prefix)name=prefix+'/'+name;
    const type=string(156,1);const data=bytes.subarray(offset+512,offset+512+size);offset+=512+Math.ceil(size/512)*512;
    if(type==='x'||type==='g') {const text=data.toString('utf8');for(const m of text.matchAll(/\d+ ([^=\n]+)=([^\n]*)\n/g))extended[m[1]]=m[2];continue;}
    if(type==='L'){longName=data.toString('utf8').replace(/\0.*$/s,'');continue;}
    name=extended.path||longName||name;extended={};longName=null;
    if(type==='0'||type==='')entries.set(name,data);
  }
  return entries;
}
function attach(p,originalPath,bytes,sourceURL,details={},provenance=false) {
  const safe=`${p.name.replace(/[^a-zA-Z0-9._-]/g,'_')}-${p.version}`;
  const relative=`${provenance?'provenance/packages':'texts'}/${p.ecosystem}/${safe}/${originalPath.replaceAll('..','__')}`;
  save(relative,bytes); const doc={path:relative,originalPath,sha256:hash(bytes),bytes:bytes.length,sourceURL,...details};
  (provenance?p.provenanceDocuments:p.documents).push(doc);return doc;
}
function github(repo) {const m=repo?.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:$|[#/])/i);return m?`${m[1]}/${m[2]}`:null;}
async function repositoryTexts(p,repo,revision,subdir,details) {
  if(!/^[0-9a-f]{40}$/i.test(revision||''))throw Error('No immutable 40-character source revision');
  const slug=github(repo);if(!slug)throw Error(`Non-GitHub repository needs manual evidence: ${repo}`);
  const treeURL=`https://api.github.com/repos/${slug}/git/trees/${revision}?recursive=1`;
  const treeBytes=await remote(treeURL,true);const tree=JSON.parse(treeBytes);if(tree.truncated)throw Error('GitHub source tree truncated');
  attach(p,'source-tree.json',treeBytes,treeURL,{sourceRevision:revision},true);
  const parts=(subdir||'').replace(/^\/+|\/+$/g,'').split('/').filter(Boolean);const ancestors=[''];for(let i=1;i<=parts.length;i++)ancestors.push(parts.slice(0,i).join('/'));
  const selected=tree.tree.filter(e=>e.type==='blob'&&ancestors.some(a=>{const relative=a?e.path.startsWith(a+'/')?e.path.slice(a.length+1):null:e.path;return relative!==null&&(relLegal.test(relative)&&!relative.includes('/')||/^(licenses?|licences?|notices?)\//i.test(relative));}));
  for(const entry of selected.sort((a,b)=>stableSort(a.path,b.path))) {
    const url=`https://raw.githubusercontent.com/${slug}/${revision}/${entry.path}`;
    const bytes=await remote(url,true);
    attach(p,`upstream/${entry.path}`,bytes,url,{...details,sourceRevision:revision,sourceRepositoryURL:`https://github.com/${slug}`,sourcePath:entry.path,inheritance:ancestors.includes(path.posix.dirname(entry.path)==='.'?'':path.posix.dirname(entry.path))?'package-or-ancestor-license':'ancestor-license-directory'});
  }
  p.sourceRevision=revision;p.sourceRepositoryURL=`https://github.com/${slug}`;p.packagePathInRepository=subdir||'';
}
async function npmRevision(p,meta,archiveDigest) {
  if(meta.gitHead)return {revision:meta.gitHead,repository:typeof meta.repository==='string'?meta.repository:meta.repository?.url};
  const url=meta.dist?.attestations?.url;
  if(url) {
    const bytes=await remote(url,true);const data=JSON.parse(bytes);
    attach(p,'registry-attestations.json',bytes,url,{note:'Official registry response retained; signatures/transparency proofs not independently cryptographically verified by this collector.'},true);
    for(const a of data.attestations||[]) {
      const payload=a.bundle?.dsseEnvelope?.payload;if(!payload)continue;
      const statement=JSON.parse(Buffer.from(payload,'base64').toString('utf8'));
      if(statement.predicateType!=='https://slsa.dev/provenance/v1')continue;
      const digest=statement.subject?.find(s=>s.digest?.sha512===archiveDigest)?.digest;
      if(!digest)throw Error('Attestation subject does not match verified archive SHA512');
      const def=statement.predicate?.buildDefinition;const dep=def?.resolvedDependencies?.find(d=>d.digest?.gitCommit);
      if(dep)return {revision:dep.digest.gitCommit,repository:def.externalParameters?.workflow?.repository,revisionEvidenceURL:url};
    }
  }
  throw Error('No immutable release revision in gitHead or matching registry provenance');
}
async function collect(target) {
  const p={ecosystem:target.ecosystem,name:target.name,version:target.version,declaredLicense:target.license,documents:[],provenanceDocuments:[],review:[],evidenceStatus:'REQUIRES_REVIEW'};
  try {
    if(p.ecosystem==='npm') {
      const locked=lock.packages[target.location];
      const metaURL=`https://registry.npmjs.org/${encodeURIComponent(p.name)}/${encodeURIComponent(p.version)}`;
      const metaBytes=await remote(metaURL,true);const meta=JSON.parse(metaBytes);
      if(meta.name!==p.name||meta.version!==p.version)throw Error('npm registry identity mismatch');
      attach(p,'registry-metadata.json',metaBytes,metaURL,{},true);
      const url=meta.dist?.tarball;if(!url?.startsWith('https://registry.npmjs.org/'))throw Error('Unexpected official npm tarball URL');
      const archive=await remote(url);
      const integrity=locked.integrity||meta.dist.integrity;if(!integrity)throw Error('No npm archive integrity');
      const valid=integrity.split(/\s+/).some(s=>{const at=s.indexOf('-');try{return crypto.createHash(s.slice(0,at)).update(archive).digest('base64')===s.slice(at+1);}catch{return false;}});
      if(!valid)throw Error('npm lock archive integrity mismatch');
      const entries=tar(archive);const rawPkg=entries.get('package/package.json');if(!rawPkg)throw Error('No archive package manifest');
      const pkg=JSON.parse(rawPkg);if(pkg.name!==p.name||pkg.version!==p.version)throw Error('npm archive identity mismatch');
      const details={sourceArchiveURL:url,sourceArchiveSHA256:hash(archive),sourceArchiveSHA512:crypto.createHash('sha512').update(archive).digest('hex'),sourceIntegrity:integrity};p.archive=details;
      attach(p,'archive-package.json',rawPkg,url,details,true);
      for(const [name,bytes] of entries) {const rel=name.replace(/^package\//,'');if(rel.split('/').some(part=>part==='node_modules'))continue;if(relLegal.test(path.posix.basename(rel)))attach(p,`archive/${rel}`,bytes,url,{...details,archivePath:name});}
      const repo=typeof meta.repository==='string'?meta.repository:meta.repository?.url|| (typeof pkg.repository==='string'?pkg.repository:pkg.repository?.url);
      const subdir=meta.repository?.directory||pkg.repository?.directory||'';
      if(!hasFullLicense(p)) {
        const link=await npmRevision(p,meta,details.sourceArchiveSHA512);
        await repositoryTexts(p,link.repository||repo,link.revision,subdir,{...details,revisionEvidenceURL:link.revisionEvidenceURL||metaURL});
      }
    } else {
      const pkg=cargo.packages.find(c=>c.name===p.name&&c.version===p.version);if(!pkg)throw Error('Cargo package missing from metadata');
      const url=`https://static.crates.io/crates/${p.name}/${p.name}-${p.version}.crate`;const archive=await remote(url);
      const checksum=cargoChecksum(p.name,p.version);
      if(checksum&&hash(archive)!==checksum)throw Error('Official crate checksum differs from locked local Cargo cache');
      const entries=tar(archive);const prefix=`${p.name}-${p.version}/`;const vcsBytes=entries.get(prefix+'.cargo_vcs_info.json');
      const details={sourceArchiveURL:url,sourceArchiveSHA256:hash(archive),sourceIntegrity:checksum?`sha256-${checksum}`:null};p.archive=details;
      const manifest=entries.get(prefix+'Cargo.toml');if(manifest)attach(p,'archive-Cargo.toml',manifest,url,details,true);
      for(const [name,bytes]of entries)if(name.startsWith(prefix)&&relLegal.test(path.posix.basename(name)))attach(p,`archive/${name.slice(prefix.length)}`,bytes,url,{...details,archivePath:name});
      await supplementaryEvidence(p,entries,prefix,url,details);
      if(vcsBytes) {
        attach(p,'archive-cargo-vcs-info.json',vcsBytes,url,details,true);const vcs=JSON.parse(vcsBytes);
        let repo=pkg.repository;
        if(!repo) { const toml=manifest?.toString('utf8')||'';repo=toml.match(/^repository\s*=\s*"([^"]+)"/m)?.[1]; }
        if(!repo&&p.name==='libappindicator-sys'&&p.version==='0.9.0') {
          const changelog=entries.get(prefix+'CHANGELOG.md');
          if(changelog?.toString('utf8').includes('https://github.com/tauri-apps/libappindicator-rs/commit/')) {
            repo='https://github.com/tauri-apps/libappindicator-rs';
            attach(p,'archive/CHANGELOG.md',changelog,url,{...details,archivePath:prefix+'CHANGELOG.md',repositoryEvidence:'The exact crate changelog links its upstream commits in tauri-apps/libappindicator-rs.'},true);
          }
        }
        if(!hasFullLicense(p))await repositoryTexts(p,repo,vcs.git?.sha1,vcs.path_in_vcs,details);
      } else if(!hasFullLicense(p))throw Error('Exact crate has no .cargo_vcs_info.json; cannot infer matching repository revision');
    }
    if(hasFullLicense(p))p.evidenceStatus='UPSTREAM_TEXT_COLLECTED';
    else p.review.push({code:'NO_UPSTREAM_LICENSE_TEXT',detail:'Exact archive/repository evidence contains no standalone license file.'});
  } catch(error){p.review.push({code:'UPSTREAM_EVIDENCE_UNRESOLVED',detail:error.message});}
  console.log(`${p.evidenceStatus}: ${p.ecosystem} ${p.name}@${p.version} (${p.documents.length} texts)${p.review.length?' '+p.review.map(r=>r.detail).join('; '):''}`);
  return p;
}
const results=[];let next=0;
async function worker(){while(next<targets.length){const index=next++;const target=targets[index];const existing=previous?.packages.find(p=>p.ecosystem===target.ecosystem&&p.name===target.name&&p.version===target.version&&p.evidenceStatus==='UPSTREAM_TEXT_COLLECTED');results[index]=existing||await collect(target);}}
await Promise.all(Array.from({length:3},worker));
for(const retained of previous?.packages||[])if(!results.some(p=>p.ecosystem===retained.ecosystem&&p.name===retained.name&&p.version===retained.version))results.push(retained);
const refreshedMembership=markMembership({packages:results}).currentDependencyStatus;
jsonSave('manifest.json',{schemaVersion:1,currentDependencyStatus:refreshedMembership,method:'Exact npm archive integrity checked against package-lock; exact crates.io archive SHA256 checked against Cargo.lock. Repository files pinned by npm registry gitHead, archive .cargo_vcs_info.json, or official npm SLSA provenance with subject digest matched to the verified archive. Official attestation signatures/transparency proofs are retained but not independently cryptographically verified. No guessed SPDX templates; ancestor LICENSE copies identified explicitly. Nonstandard AUTHORS grants and explicitly source-linked official standard license supplements are manually identified by evidenceRole and manualEvidence. Source responses and linkage metadata retained; full archives hashed but not retained.',packages:results});
save('README.md',`# Exact-version upstream license evidence\n\nRun \`node scripts/collect-upstream-license-evidence.mjs\` to collect/resume and \`node scripts/collect-upstream-license-evidence.mjs --check\` to verify every referenced document offline. No package installation or scripts are executed.\n\nThe [manifest](manifest.json) joins by ecosystem/name/version. Document paths are relative to this directory. Every document records its original upstream path, source URL, bytes and SHA-256. Archive-origin documents additionally record the verified archive URL, SHA-256 and npm lock integrity or Cargo.lock checksum. Original upstream bytes are unmodified. Registry metadata, source-tree responses and archive VCS metadata preserve exact-version linkage. Cached HTTP responses are retained under provenance/http for repeatable collection.\n\nUPSTREAM_TEXT_COLLECTED means license evidence exists, not legal clearance of embedded components or a proof of target binary correspondence. Some npm binary packages lack gitHead: their official registry SLSA statement subject SHA-512 is checked against the verified archive, then its immutable gitCommit selects upstream text. Statement signatures and transparency logs are retained but not independently cryptographically verified here.\n\nOriginal license files from monorepo ancestors explicitly record inheritance. r-efi AUTHORS is manually reviewed as a full MIT grant including copyright; its README confirms the MIT alternative. For cesu8/winapi, original source copyright notices expressly link Apache-2.0; for selectors they expressly link MPL-2.0. Their complete original source notice files plus separately identified official fixed-license-version text are retained. These documents carry evidenceRole=full-license-text and manualEvidence explaining the linkage; they are never presented as fabricated upstream package LICENSE files. selectedLicense records the reviewed branch.\n\nUnresolved entries retain review items. Run node scripts/collect-upstream-license-evidence.mjs --refresh-status for an offline current-lock membership refresh without fetching upstream data. dependencyStatus distinguishes CURRENT_LOCKED_DEPENDENCY from HISTORICAL_NOT_IN_CURRENT_LOCKFILES; historical entries and their findings stay preserved but are not unresolved current runtime dependencies. --check recomputes this distinction from current lockfiles without writing. This evidence store excludes downstream modification analysis and an exhaustive embedded-native-library audit. Full source archives are hashed but not retained here. Corresponding-source delivery and notice obligations remain the responsibility of the distribution inventory.\n`);
const currentResults=results.filter(p=>p.dependencyStatus==='CURRENT_LOCKED_DEPENDENCY');
console.log(JSON.stringify({retainedPackages:results.length,currentPackages:currentResults.length,currentResolved:currentResults.filter(p=>p.evidenceStatus==='UPSTREAM_TEXT_COLLECTED').length,currentUnresolved:currentResults.filter(p=>p.review.length).map(p=>({name:p.name,version:p.version,review:p.review})),historicalPackages:results.filter(p=>p.dependencyStatus==='HISTORICAL_NOT_IN_CURRENT_LOCKFILES').map(p=>({ecosystem:p.ecosystem,name:p.name,version:p.version,retainedReview:p.review}))},null,2));
