#!/usr/bin/env node
/** Collect licenses for exact embedded Mermaid/PDF.js versions, using verified sourcemaps.
 * node scripts/collect-vendored-license-evidence.mjs [--check | --accept-elk-source-override]
 * The explicit migration accepts only the pinned two-file ELK source-build override and quarantines old engine evidence.
 * Node builtins only. Never executes dependency scripts or writes renderer assets.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {verifyCorrespondingSources} from './verify-corresponding-sources.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'compliance/third-party-sources/vendored-evidence');
if(process.argv.slice(2).some(a=>!['--check','--accept-elk-source-override'].includes(a))||(process.argv.includes('--check')&&process.argv.includes('--accept-elk-source-override')))throw Error('Usage: collect-vendored-license-evidence.mjs [--check | --accept-elk-source-override]');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const readJSON=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const slash=p=>p.split(path.sep).join('/');
const sort=(a,b)=>a<b?-1:a>b?1:0;
const legal=/^(?:licen[cs]es?|copying|notices?|copyrights?|unlicense)(?:$|[._ -])/i;
function write(name,data){const p=path.resolve(output,name);if(!p.startsWith(output+path.sep))throw Error('Unsafe path');fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,data);}
function put(name,data,extra={}){const bytes=Buffer.isBuffer(data)?data:Buffer.from(data);write(name,bytes);return {path:name,bytes:bytes.length,sha256:sha(bytes),...extra};}
const manifestPath=path.join(output,'manifest.json');
const previous=fs.existsSync(manifestPath)?readJSON(manifestPath):null;
const overridePath=path.join(root,'compliance/third-party-sources/elkjs/override-manifest.json');
function verifiedOverride(){
 const o=readJSON(overridePath),source=readJSON(path.join(path.dirname(overridePath),'manifest.json'));
 if(o.kind!=='EXPLICIT_AUDITED_ENGINE_REPLACEMENT'||o.version!=='0.9.3-ziedit-source.1'||o.original.path!=='public/renderers/mermaid/chunks/mermaid.esm.min/elk-7HBNN7NY.mjs'||o.original.sha256!=='ae6173b625cc1ad5ac674fb95065c58235d07e9b184ae3265a447d1acf1c91fa'||o.replacement.path!==o.original.path||o.engine.path!=='public/renderers/mermaid/chunks/mermaid.esm.min/elk-ziedit-source.mjs')throw Error('Unreviewed ELK override identity or paths');
 if(o.replacement.sha256!=='550467c5b2b15f8701bc4a81149672df15a821db87e71151e69d4aa4fe87ae74'||o.engine.sha256!=='64902545445d8df7c0313000c6f276dd2d30972468b201cdb9984aac5508c64b'||source.status!=='SOURCE_BUILD_VERIFIED'||source.version!==o.version||source.sourceArchiveSha256!==o.sourceBundle.archiveSha256||source.sourceBundleSha256!==o.sourceBundle.sha256)throw Error('ELK fixed-source build identity differs');
 for(const a of [o.replacement,o.engine]){const bytes=fs.readFileSync(path.join(root,a.path));if(bytes.length!==a.bytes||sha(bytes)!==a.sha256)throw Error('ELK installed override changed');}
 const report=verifyCorrespondingSources({root});if(!report.ok||!report.releaseAllowed)throw Error('ELK corresponding-source verification failed: '+JSON.stringify(report));
 return {...o,manifestSHA256:sha(fs.readFileSync(overridePath)),sourceManifestSHA256:sha(fs.readFileSync(path.join(path.dirname(overridePath),'manifest.json')))};
}
const override=fs.existsSync(overridePath)?verifiedOverride():null;
const forbiddenSourceSHA='b0745abd7f23cd91690a1587e377edbe19fd7233c783300290936720546216d4';
function historicalPayloads(){
 const found=[];
 for(const filename of walk(output)){
  const bytes=fs.readFileSync(filename),digest=sha(bytes);let reason;
  if(digest===forbiddenSourceSHA||digest===override?.original.sha256)reason='Original generated ELK implementation is no longer redistributed; exact-source replacement is installed.';
  if(bytes[0]===31&&bytes[1]===139){try{const entries=untar(bytes);if([...entries].some(([name,data])=>/elk(?:\.bundled|-worker)(?:\.min)?\.js(?:\.map)?$/.test(name)||sha(data)===override?.original.sha256||sha(data)===forbiddenSourceSHA))reason='Archive contains old generated ELK implementation; archive retained outside distribution only.';}catch(e){if(!String(e).includes('incorrect header'))throw e;}}
  if(reason)found.push({absolute:filename,path:slash(path.relative(output,filename)),bytes:bytes.length,sha256:digest,reason});
 }
 return found;
}
if(process.argv.includes('--accept-elk-source-override')){
 if(!override||!previous)throw Error('Existing inventory and verified explicit override required');
 const original=previous.artifacts.find(a=>a.path===override.original.path);
 if(original?.sha256!==override.original.sha256&&!previous.explicitSourceOverride)throw Error('Recorded old ELK artifact does not match audited original');
 for(const a of previous.artifacts){if([override.original.path,override.engine.path].includes(a.path))continue;if(sha(fs.readFileSync(path.join(root,a.path)))!==a.sha256)throw Error('Unrelated renderer drift: '+a.path);}
 const allowed=new Set([...previous.artifacts.filter(a=>a.path.startsWith('public/renderers/mermaid/')).map(a=>a.path),override.engine.path]);
 const actual=walk(path.join(root,'public/renderers/mermaid')).filter(p=>p.endsWith('.mjs')).map(p=>slash(path.relative(root,p)));
 if(actual.length!==allowed.size||actual.some(p=>!allowed.has(p)))throw Error('Override allows exactly one added fixed-source engine module');
 const removed=historicalPayloads(),history=path.resolve(root,'docs/tmp/license-historical-vendored');
 for(const item of removed){const source=path.resolve(item.absolute),destination=path.resolve(history,item.path);if(!source.startsWith(output+path.sep)||!destination.startsWith(history+path.sep))throw Error('Unsafe historical move');fs.mkdirSync(path.dirname(destination),{recursive:true});if(fs.existsSync(destination)){if(sha(fs.readFileSync(destination))!==item.sha256)throw Error('Historical destination differs');fs.unlinkSync(source);}else fs.renameSync(source,destination);}
 const dropped=new Set(removed.map(r=>r.path));
 previous.files=previous.files.filter(f=>!dropped.has(f.path));previous.sources=previous.sources.filter(s=>!dropped.has(s.path));
 for(const p of previous.packages)p.sourceEvidence=p.sourceEvidence.filter(s=>!dropped.has(s.path));
 const pkg=previous.packages.find(p=>p.name==='elkjs');if(!pkg)throw Error('Existing ELK license inventory missing');
 pkg.version=override.version;pkg.ecosystem='audited-source-build';pkg.identification='Explicit fixed-source replacement, not the historical npm generated engine.';pkg.historicalNpmLicenseProvenance??=pkg.archive;delete pkg.archive;pkg.pnpmIdentifiers=[];pkg.correspondingSource={directory:'compliance/third-party-sources/elkjs',archive:override.sourceBundle.archive,archiveSHA256:override.sourceBundle.archiveSha256,compiledBundleSHA256:override.sourceBundle.sha256};
 previous.artifacts=previous.artifacts.filter(a=>![override.original.path,override.engine.path].includes(a.path));
 for(const a of [override.replacement,override.engine])previous.artifacts.push({path:a.path,sha256:a.sha256,bytes:a.bytes,classification:'EXPLICIT_AUDITED_SOURCE_BUILD_OVERRIDE',sourceOverrideManifest:'compliance/third-party-sources/elkjs/override-manifest.json'});
 previous.explicitSourceOverride=override;
 previous.deprecatedHistoricalEvidence=[...(previous.deprecatedHistoricalEvidence||[]),...removed.map(({absolute,...r})=>({...r,status:'REMOVED_FROM_PUBLIC_DISTRIBUTION',historicalLocation:'docs/tmp/license-historical-vendored/'+r.path}))];
 previous.artifacts.sort((a,b)=>sort(a.path,b.path));write('manifest.json',JSON.stringify(previous,null,2)+'\n');
 console.log(JSON.stringify({mode:'explicit-elk-source-override',changedArtifacts:2,movedHistoricalPayloads:removed.map(({absolute,...r})=>r),remainingForbidden:historicalPayloads().length},null,2));process.exit(0);
}
if(override&&historicalPayloads().length)throw Error('Old generated ELK payload remains in distributed evidence; use the explicit audited override migration.');
if(process.argv.includes('--check')){
 if(!previous)throw Error('No evidence manifest');let n=0;
 const actualMermaid=walk(path.join(root,'public/renderers/mermaid')).filter(p=>p.endsWith('.mjs')).map(p=>slash(path.relative(root,p))).sort(sort);
 const recordedMermaid=previous.artifacts.filter(a=>a.path.startsWith('public/renderers/mermaid/')&&a.path.endsWith('.mjs')).map(a=>a.path).sort(sort);
 if(JSON.stringify(actualMermaid)!==JSON.stringify(recordedMermaid))throw Error('Distributed Mermaid module inventory differs: regenerate and audit added/removed modules');
 for(const [name,version]of Object.entries(previous.rendererVersions||{}))if(readJSON(path.join(root,'node_modules',name,'package.json')).version!==version)throw Error(`Renderer package version changed: ${name}`);
 for(const doc of previous.files){const p=path.resolve(output,doc.path);if(!p.startsWith(output+path.sep))throw Error('Unsafe path');const b=fs.readFileSync(p);if(b.length!==doc.bytes||sha(b)!==doc.sha256)throw Error(`Evidence digest differs: ${doc.path}`);n++;}
 for(const artifact of previous.artifacts){const bytes=fs.readFileSync(path.join(root,artifact.path));if(sha(bytes)!==artifact.sha256)throw Error(`Vendored artifact changed: ${artifact.path}`);if(artifact.sourceMapPath){const map=fs.readFileSync(path.join(root,artifact.sourceMapPath));if(sha(map)!==artifact.sourceMapSHA256)throw Error(`Source map changed: ${artifact.sourceMapPath}`);}}
 console.log(JSON.stringify({verifiedFiles:n,verifiedArtifacts:previous.artifacts.length,packages:previous.packages.length,reviewItems:previous.review.length},null,2));process.exit(previous.review.length?2:0);
}
const requests=new Map();
async function get(url,retain=true){
 const cache=`provenance/http/${sha(url)}.bin`,p=path.join(output,cache);
 if(retain&&fs.existsSync(p))return fs.readFileSync(p);
 if(requests.has(url))return requests.get(url);
 const result=(async()=>{let last;for(let i=0;i<3;i++){try{const r=await fetch(url,{headers:{'User-Agent':'ZiEdit-vendored-evidence/1.0'},signal:AbortSignal.timeout(90000)});if(!r.ok)throw Error(`HTTP ${r.status}: ${url}`);const b=Buffer.from(await r.arrayBuffer());if(retain)write(cache,b);return b;}catch(e){last=e;}}throw last;})();requests.set(url,result);return result;
}
function untar(archive){const b=gunzipSync(archive),files=new Map();let ext={},long;
 for(let o=0;o+512<=b.length;){const h=b.subarray(o,o+512);if(h.every(x=>x===0))break;const str=(a,n)=>h.subarray(a,a+n).toString('utf8').replace(/\0.*$/s,'');let name=str(0,100);const prefix=str(345,155);if(prefix)name=prefix+'/'+name;const size=parseInt(str(124,12).trim()||'0',8);if(!Number.isFinite(size)||size<0)throw Error('Invalid tar');const type=str(156,1),data=b.subarray(o+512,o+512+size);o+=512+Math.ceil(size/512)*512;if(type==='x'||type==='g'){for(const m of data.toString('utf8').matchAll(/\d+ ([^=\n]+)=([^\n]*)\n/g))ext[m[1]]=m[2];continue;}if(type==='L'){long=data.toString('utf8').replace(/\0.*$/s,'');continue;}name=ext.path||long||name;ext={};long=null;if(type==='0'||type==='')files.set(name,data);}return files;
}
const files=[],artifacts=[],sourceRecords=[],bundleNotices=[],review=[];
const packageMap=new Map();
function pkg(name,version,extra={}){const key=`${name}@${version}`;if(!packageMap.has(key))packageMap.set(key,{ecosystem:'npm',name,version,documents:[],sourceEvidence:[],pnpmIdentifiers:[],review:[],...extra});return packageMap.get(key);}
function evidence(name,data,extra={}){const d=put(name,data,extra);files.push(d);return d;}
function walk(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(directory,e.name)):e.isFile()?[path.join(directory,e.name)]:[]);}
const mermaidRoot=path.join(root,'public/renderers/mermaid');
const upstreamRoot=path.join(root,'node_modules/mermaid/dist');
const mermaidMeta=readJSON(path.join(root,'node_modules/mermaid/package.json'));
const mermaid=pkg('mermaid',mermaidMeta.version,{identification:'Every distributed upstream Mermaid module must byte-match the installed dist module before its map can be used.'});
const sourceSeen=new Map();
for(const p of walk(mermaidRoot).filter(p=>p.endsWith('.mjs')).sort(sort)){
 const relative=path.relative(mermaidRoot,p),upstream=path.join(upstreamRoot,relative),bytes=fs.readFileSync(p),projectPath=slash(path.relative(root,p));
 if(override&&projectPath===override.engine.path){artifacts.push({path:projectPath,sha256:sha(bytes),bytes:bytes.length,classification:'EXPLICIT_AUDITED_SOURCE_BUILD_OVERRIDE',sourceOverrideManifest:'compliance/third-party-sources/elkjs/override-manifest.json'});continue;}
 const replaced=override&&projectPath===override.replacement.path;
 if(!fs.existsSync(upstream)){
  if(relative==='loader.mjs'){artifacts.push({path:slash(path.relative(root,p)),sha256:sha(bytes),bytes:bytes.length,classification:'ZiEdit-owned integration loader; not an upstream Mermaid module'});continue;}
  throw Error(`Unknown distributed module without upstream counterpart: ${relative}`);
 }
 if(replaced){if(sha(fs.readFileSync(upstream))!==override.original.sha256)throw Error('Original installed ELK identity changed');}else if(!bytes.equals(fs.readFileSync(upstream)))throw Error(`Vendored/upstream bytes differ: ${relative}`);
 const mapPath=upstream+'.map',mapBytes=fs.readFileSync(mapPath),map=JSON.parse(mapBytes);
 const artifact={path:slash(path.relative(root,p)),sha256:sha(bytes),bytes:bytes.length,upstreamPath:slash(path.relative(root,upstream)),sourceMapPath:slash(path.relative(root,mapPath)),sourceMapSHA256:sha(mapBytes),...(replaced?{classification:'EXPLICIT_AUDITED_SOURCE_BUILD_OVERRIDE',sourceMapScope:'Historical upstream source map supplies only preserved Mermaid renderer code. Original generated ELK sourcesContent is explicitly excluded; replacement engine source is the audited fixed source bundle.'}:{} )};artifacts.push(artifact);
 if(map.sources.length!==map.sourcesContent.length)throw Error('Missing source contents');
 for(let i=0;i<map.sources.length;i++){
  const sourcePath=map.sources[i],content=map.sourcesContent[i];if(typeof content!=='string')throw Error(`Missing embedded source: ${sourcePath}`);
  if(override&&/\/node_modules\/elkjs\//.test(sourcePath))continue;
  let owner=mermaid;const match=sourcePath.match(/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if(match){const identifier=match[1],name=match[2],encoded=name.replace('/','+');if(!identifier.startsWith(encoded+'@'))throw Error(`Cannot parse pnpm identity: ${sourcePath}`);const version=identifier.slice(encoded.length+1).split('_')[0];if(!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version))throw Error(`Invalid version: ${sourcePath}`);owner=pkg(name,version,{identification:'Exact .pnpm identifier embedded in source map of a byte-matched distributed module.'});if(!owner.pnpmIdentifiers.includes(identifier))owner.pnpmIdentifiers.push(identifier);}
  else if(sourcePath.includes('node_modules'))throw Error(`Unresolved external source path: ${sourcePath}`);
  const sourceBytes=Buffer.from(content,'utf8'),id=sha(sourcePath+'\0'+content);let record=sourceSeen.get(id);
  if(!record){const d=evidence(`sources/${id}.txt`,sourceBytes,{evidenceRole:'original-source-map-sourcesContent',sourcePath,package:owner.name,version:owner.version,containsLicenseOrCopyright:/copyright|\blicen[cs]e\b|adopted from|modified|modifications/i.test(content)});record={...d,appearances:[]};sourceSeen.set(id,record);sourceRecords.push(record);owner.sourceEvidence.push(d);}
  record.appearances.push({artifact:artifact.path,sourceMapSHA256:artifact.sourceMapSHA256,sourceIndex:i});
 }
 const text=bytes.toString('utf8'),marker=text.indexOf('/*! Bundled license information:');
 if(marker>=0){const notice=evidence(`bundle-notices/${sha(bytes)}.txt`,Buffer.from(text.slice(marker),'utf8'),{evidenceRole:'verbatim-distributed-bundle-license-tail',artifact:artifact.path,artifactSHA256:artifact.sha256});bundleNotices.push(notice);}
}
// The legacy PDF.js code explicitly embeds core-js 3.50.0. Retain original version/copyright context.
const pdfEnginePath=path.join(root,'src/pdf-view/engine.ts');
const pdfEngineBytes=fs.readFileSync(pdfEnginePath);if(!pdfEngineBytes.toString('utf8').includes("pdfjs-dist/legacy/build/pdf.mjs")||!pdfEngineBytes.toString('utf8').includes("pdfjs-dist/legacy/build/pdf.worker.mjs"))throw Error('PDF.js legacy import contract changed');
artifacts.push({path:'src/pdf-view/engine.ts',sha256:sha(pdfEngineBytes),bytes:pdfEngineBytes.length,classification:'Application imports these exact PDF.js legacy build inputs'});
const pdfFiles=['pdf.mjs','pdf.worker.mjs'].map(name=>path.join(root,'node_modules/pdfjs-dist/legacy/build',name));
const core=pkg('core-js','3.50.0',{identification:'Literal core-js version 3.50.0 and original copyright in the distributed PDF.js legacy modules; matched against exact npm upstream license.'});
for(const p of pdfFiles){const b=fs.readFileSync(p),text=b.toString('utf8');const m=text.match(/version:\s*["']3\.50\.0["']/);if(!m)continue;artifacts.push({path:slash(path.relative(root,p)),sha256:sha(b),bytes:b.length,classification:'PDF.js legacy build input selected by application imports; embeds core-js 3.50.0'});const at=m.index;const snippet=text.slice(Math.max(0,at-1000),Math.min(text.length,at+1800));const doc=evidence(`identification/core-js-${sha(b)}.txt`,Buffer.from(snippet,'utf8'),{evidenceRole:'verbatim-version-and-copyright-context',artifact:slash(path.relative(root,p)),artifactSHA256:sha(b)});core.sourceEvidence.push(doc);}
if(core.sourceEvidence.length===0)throw Error('Distributed PDF.js core-js version not identified');
if(override){const original=previous?.packages.find(p=>p.name==='elkjs');if(!original||original.version!==override.version)throw Error('Run explicit ELK override migration before regeneration');packageMap.set(`elkjs@${override.version}`,{...original,sourceEvidence:[],review:[]});}
const packages=[...packageMap.values()].sort((a,b)=>sort(a.name,b.name)||sort(a.version,b.version));
let next=0;
async function collect(p){
 if(p.ecosystem==='audited-source-build'){for(const d of [...p.documents,...(p.provenance||[])]){const bytes=fs.readFileSync(path.join(output,d.path));if(sha(bytes)!==d.sha256)throw Error('Source-build license evidence drift');files.push(d);}return;}
 try{
  const old=previous?.packages.find(o=>o.name===p.name&&o.version===p.version&&o.documents.length&&!o.review.length);
  if(old&&!p.pnpmIdentifiers.some(s=>s.includes('patch_hash='))){p.documents=old.documents;p.declaredLicense=old.declaredLicense;p.archive=old.archive;p.provenance=old.provenance;for(const d of [...p.documents,...(p.provenance||[])]){const b=fs.readFileSync(path.join(output,d.path));if(sha(b)!==d.sha256)throw Error('Cached evidence digest mismatch');files.push(d);}return;}
  const metaURL=`https://registry.npmjs.org/${encodeURIComponent(p.name)}/${encodeURIComponent(p.version)}`,metaBytes=await get(metaURL),meta=JSON.parse(metaBytes);
  if(meta.name!==p.name||meta.version!==p.version)throw Error('Official registry identity mismatch');
  const safe=`${p.name.replace(/[^a-zA-Z0-9._-]/g,'_')}-${p.version}`;
  p.provenance=[evidence(`provenance/packages/${safe}/registry.json`,metaBytes,{sourceURL:metaURL})];
  p.declaredLicense=meta.license||null;
  const url=meta.dist?.tarball;if(!url?.startsWith('https://registry.npmjs.org/'))throw Error('Not official registry archive');const archive=await get(url,false),integrity=meta.dist.integrity;
  if(integrity){const valid=integrity.split(/\s+/).some(s=>{const at=s.indexOf('-');try{return crypto.createHash(s.slice(0,at)).update(archive).digest('base64')===s.slice(at+1);}catch{return false;}});if(!valid)throw Error('Official archive integrity mismatch');}
  else if(crypto.createHash('sha1').update(archive).digest('hex')!==meta.dist.shasum)throw Error('Official archive SHA1 mismatch');
  p.archive={sourceArchiveURL:url,sourceArchiveSHA256:sha(archive),sourceIntegrity:integrity||`sha1-${meta.dist.shasum}`};
  const entries=untar(archive),manifest=JSON.parse(entries.get('package/package.json')||'null');if(manifest?.name!==p.name||manifest?.version!==p.version)throw Error('Archive identity mismatch');
  for(const [name,b]of entries){const rel=name.replace(/^package\//,'');if(rel.split('/').includes('node_modules'))continue;if(legal.test(path.posix.basename(rel)))p.documents.push(evidence(`texts/${safe}/${rel}`,b,{originalPath:rel,sourceURL:url,...p.archive,evidenceRole:'exact-upstream-archive-license-or-notice'}));}
  if(p.name==='fastdom'&&p.version==='1.0.12') {
   const readme=entries.get('package/README.md'),text=readme?.toString('utf8')||'';
   if(!text.includes('Copyright (c) 2016 Wilson Page <wilsonpage@me.com>')||!text.includes('Permission is hereby granted, free of charge')||!text.includes('THE SOFTWARE IS PROVIDED'))throw Error('Reviewed exact fastdom README license evidence changed');
   p.documents.push(evidence(`texts/${safe}/README.md`,readme,{originalPath:'README.md',sourceURL:url,...p.archive,evidenceRole:'full-license-text',manualEvidence:'Exact fastdom 1.0.12 README contains the full MIT grant, original Wilson Page copyright and warranty disclaimer; reviewed in original bytes.'}));
  }
  if(p.pnpmIdentifiers.some(s=>s.includes('patch_hash='))) {
   p.modificationEvidence=[];
   for(const s of p.sourceEvidence) {
    const marker=`/node_modules/${p.name}/`,at=s.sourcePath.lastIndexOf(marker),relative=s.sourcePath.slice(at+marker.length),original=entries.get('package/'+relative);
    if(!original){p.modificationEvidence.push({sourcePath:s.sourcePath,patchedSourcePath:s.path,comparison:'UPSTREAM_SOURCE_NOT_PRESENT_IN_ARCHIVE'});continue;}
    const originalDoc=evidence(`upstream-sources/${safe}/${relative}`,original,{originalPath:relative,sourceURL:url,...p.archive,evidenceRole:'original-unpatched-source-for-comparison'});
    p.modificationEvidence.push({sourcePath:s.sourcePath,patchedSourcePath:s.path,patchedSourceSHA256:s.sha256,originalDocument:originalDoc,comparison:s.sha256===originalDoc.sha256?'IDENTICAL':'MODIFIED',statement:s.sha256===originalDoc.sha256?'Embedded source equals exact upstream archive.':'Embedded source differs from exact upstream archive; original and patched complete bytes retained for review.'});
   }
  }
  if(!p.declaredLicense&&p.name==='khroma'&&p.version==='2.1.0'&&p.documents.some(d=>d.originalPath==='license'&&fs.readFileSync(path.join(output,d.path),'utf8').startsWith('The MIT License (MIT)\n')))p.declaredLicense='MIT';
  if(!p.documents.some(d=>(/^(?:licen[cs]e|copying|unlicense)(?:$|[._ -])/i.test(path.posix.basename(d.originalPath))||d.evidenceRole==='full-license-text')&&d.bytes))p.review.push({code:'NO_STANDALONE_UPSTREAM_LICENSE',detail:'Exact archive lacks a complete standalone license file; retained source-map notices require manual review.'});
  if(!p.declaredLicense)p.review.push({code:'UNKNOWN_LICENSE_IDENTIFIER',detail:'No license identifier in registry metadata; original notices retained.'});
 }catch(e){p.review.push({code:'UPSTREAM_FETCH_UNRESOLVED',detail:e.message});}
 console.log(`${p.name}@${p.version}: ${p.documents.length} license texts${p.review.length?' REVIEW '+JSON.stringify(p.review):''}`);
}
async function worker(){while(next<packages.length)await collect(packages[next++]);}
await Promise.all(Array.from({length:3},worker));
for(const p of packages){p.pnpmIdentifiers.sort(sort);if(p.pnpmIdentifiers.some(s=>s.includes('patch_hash=')))p.localModificationEvidence='Original patched sourcesContent is retained verbatim; pnpm patch identifier is not a published npm version. Compare retained source content with exact upstream before claiming no modifications.';for(const i of p.review)review.push({name:p.name,version:p.version,...i});}
const uniqueFiles=[...new Map(files.map(d=>[d.path,d])).values()].sort((a,b)=>sort(a.path,b.path));
write('manifest.json',JSON.stringify({schemaVersion:1,...(override?{explicitSourceOverride:override,deprecatedHistoricalEvidence:previous?.deprecatedHistoricalEvidence||[]}:{}),rendererVersions:{mermaid:mermaidMeta.version,'pdfjs-dist':readJSON(path.join(root,'node_modules/pdfjs-dist/package.json')).version},method:'Actual vendored Mermaid modules byte-matched to installed upstream dist; exact package versions parsed from associated source maps, not current application lock. Every embedded source string retained verbatim as UTF-8, with source map hash/index, including license notices, bundled third-party grants and patch modifications. Exact-version official npm archive license bytes checked against registry integrity. Full source-map content and bundle license tails are evidence, not a legal-clearance claim.',artifacts,packages,sources:sourceRecords,bundleNotices,files:uniqueFiles,review},null,2)+'\n');
write('README.md','# Vendored renderer license evidence\n\nSee [manifest](manifest.json) for exact embedded package versions and source evidence. Generate with `node scripts/collect-vendored-license-evidence.mjs`; verify offline with `--check`.\n\nEvery upstream Mermaid module in the distribution must byte-match its installed original before any source map is trusted, except the two explicitly pinned ELK source-build replacement modules verified by the corresponding-source gate. The ZiEdit integration loader is separately identified. The explicitSourceOverride records the exact new source bundle and output hashes; historical original generated ELK sourcesContent and archives containing the old worker are excluded from public evidence and retained only under docs/tmp/license-historical-vendored. The new corresponding source is distributed in ../elkjs/. Sourcemap `.pnpm` version identifiers preserve peer and patch suffixes while selecting the actual published package version. All deduplicated sourcesContent strings are preserved in UTF-8 without editing, with map hash and source index; bundle license tails are also preserved verbatim, including Cytoscape embedded third-party attributions. Nonstandard and source-embedded grants are not replaced by package-level MIT labels. layout-base SVD/JamaJS attribution, modification descriptions and Apache license survive in the retained whole source. Patched fastdom/roughjs source content is explicitly identified.\n\nThe PDF.js legacy modules identify core-js 3.50.0; original version and copyright context is retained alongside the exact upstream core-js license. npm archive integrity is verified against official exact-version registry metadata; the application lockfile is intentionally not used to substitute newer dependencies. Registry and archive URLs, archive SHA-256 and original license document SHA-256 are recorded.\n\nOpen review items remain in the manifest. Standard source mapping and license collection do not certify complete binary correspondence, source availability obligations, trademarks/patents or rights in every embedded noncode asset. Source evidence is retained in whole files to avoid comment extraction errors caused by JavaScript regular expressions.\n');
console.log(JSON.stringify({packages:packages.length,sources:sourceRecords.length,artifacts:artifacts.length,bundleNotices:bundleNotices.length,evidenceFiles:uniqueFiles.length,review},null,2));
