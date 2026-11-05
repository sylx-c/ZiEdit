#!/usr/bin/env node
/** Fail closed on unknown license scope, evidence drift or incomplete source delivery. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=new Set(process.argv.slice(2));
if([...args].some(a=>!['--dist','--evidence-only'].includes(a)))throw Error('Usage: verify-license-compliance.mjs [--dist] [--evidence-only]');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const report={scope:'Free/open licenses and concrete distribution obligations for recorded components; not a trademark/patent or zero-risk legal opinion',checks:[],unresolved:[]};
let failed=false;
function run(script,...flags){const result=spawnSync(process.execPath,[script,...flags],{cwd:root,stdio:'inherit'});report.checks.push({script,flags,exitCode:result.status??1});if(result.status!==0)failed=true;}
run('scripts/verify-font-licenses.mjs');
run('scripts/collect-upstream-license-evidence.mjs','--check');
run('scripts/collect-vendored-license-evidence.mjs','--check');
run('scripts/verify-corresponding-sources.mjs',...(args.has('--evidence-only')?['--allow-unresolved']:[]),'--json');
run('scripts/verify-asset-provenance.mjs','--distribution',...(args.has('--dist')?['--dist']:[]));
run('scripts/verify-project-art.mjs');
run('scripts/verify-default-installer.mjs');
run('scripts/verify-other-renderers.mjs','--check');
run('scripts/verify-native-license-inputs.mjs',...(process.argv.includes('--dist')?['--installer-tools']:[]));
run('scripts/capture-website-assets.mjs','--verify');
run('scripts/generate-third-party-licenses.mjs','--check',...(args.has('--evidence-only')?[]:['--strict']));
for(const group of ['ring-notices','webview2-loader','windows-installer']){
 const base=path.join(root,'compliance/third-party-sources',group), manifest=JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));
 for(const item of manifest.files){const file=path.resolve(base,item.path);if(!file.startsWith(base+path.sep))throw Error('Unsafe native evidence path');const data=fs.readFileSync(file);if(data.length!==item.bytes||sha(data)!==item.sha256)throw Error('Changed native notice '+file);}
 if(manifest.review?.length)throw Error('Unreviewed native evidence');
 report.checks.push({nativeEvidence:group,files:manifest.files.length});
}
// Exact license expressions intentionally reviewed as free/open grants. New expressions fail for review.
const approved=new Set(['MIT','MIT OR Apache-2.0','Apache-2.0 OR MIT','ISC','Apache-2.0','Unicode-3.0','MPL-2.0','Zlib OR Apache-2.0 OR MIT','MIT/Apache-2.0','BSD-3-Clause','Unlicense OR MIT','Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT','MIT OR Apache-2.0 OR Zlib','Zlib','Apache-2.0/MIT','BSD-2-Clause','BSD-2-Clause OR Apache-2.0 OR MIT','Apache-2.0 OR ISC OR MIT','BSD-3-Clause OR Apache-2.0','BSD-3-Clause OR MIT OR Apache-2.0','MIT-0','BSL-1.0','MIT OR Apache-2.0 OR LGPL-2.1-or-later','Unlicense/MIT','MIT OR Zlib OR Apache-2.0','PSF-2.0','Unlicense','BSD-3-Clause/MIT','CDLA-Permissive-2.0','CC0-1.0 OR MIT-0 OR Apache-2.0','CC0-1.0','BSD-3-Clause AND MIT','BlueOak-1.0.0','Apache-2.0 WITH LLVM-exception','Apache-2.0 OR BSL-1.0','Apache-2.0 AND MIT','Apache-2.0 AND ISC','Apache-2.0 / MIT','0BSD OR MIT OR Apache-2.0','(MPL-2.0 OR Apache-2.0)','(MIT OR Apache-2.0) AND Unicode-3.0','EPL-2.0','(Apache-2.0 OR MIT) AND BSD-3-Clause']);
const inventory=read('public/third-party-licenses/manifest.json');
const mplVersions=new Map([['option-ext','0.2.0'],['cssparser','0.37.0'],['cssparser-macros','0.7.1'],['dtoa-short','0.3.5'],['selectors','0.38.0']]);
for(const pkg of inventory.packages){
 if(!approved.has(pkg.license))throw Error('Unreviewed license expression '+pkg.name+': '+pkg.license);
 const selected=pkg.selectedLicense??pkg.license;
 if(/MPL|EPL|LGPL|GPL/.test(selected)){
  const exactMpl=pkg.ecosystem==='cargo'&&mplVersions.get(pkg.name)===pkg.version&&pkg.correspondingSource?.repositoryPath;
  const exactElk=pkg.ecosystem==='npm'&&pkg.name==='elkjs'&&pkg.version==='0.9.3'&&pkg.correspondingSource;
  const knownBuildTool=pkg.ecosystem==='npm'&&/^lightningcss(?:-|$)/.test(pkg.name)&&pkg.version==='1.33.0'&&pkg.dependencyClass==='development-only';
  if(!exactMpl&&!exactElk&&!knownBuildTool)throw Error('Unreviewed corresponding-source or distribution scope obligation: '+pkg.name+'@'+pkg.version);
 }
}
const config=read('src-tauri/tauri.conf.json');
if(config.bundle.windows?.nsis?.compression!=='zlib')throw Error('Unreviewed installer compressor; audit its original license/source obligations first');
const resources=config.bundle.resources;
// 分发口径（2026-11-06 瘦身定稿）：安装包只随附许可原文与 NOTICE（third-party-licenses/font-licenses）；
// 对应源码与审计证据留在公开仓库 compliance/，以包内 SOURCE-OFFERS.txt 的获取指引履约，不再实体入包。
for(const name of ['font-licenses','third-party-licenses'])if(resources['../public/'+name+'/']!==name+'/')throw Error('Legal resource mapping missing: '+name);
for(const name of ['compliance/asset-provenance','compliance/third-party-sources'])if(Object.values(resources).some(v=>v.startsWith(name+'/'))||resources['../'+name+'/'])throw Error('Evidence/source payload must stay out of the installer (repo-only offer): '+name);
for(const name of ['third-party-sources','asset-provenance'])if(fs.existsSync(path.join(root,'public',name)))throw Error('Evidence directory must not live in public/ (it would ride into dist): '+name);
if(args.has('--dist')){
 const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
 for(const top of fs.readdirSync(path.join(root,'public'))){
  const source=path.join(root,'public',top),destination=path.join(root,'dist',top);
  if(!fs.existsSync(destination))throw Error('Missing copied public input '+destination);
  const sourceFiles=fs.statSync(source).isDirectory()?walk(source):[source];
  const destFiles=fs.statSync(destination).isDirectory()?walk(destination):[destination];
  const rel=(files,base)=>files.map(p=>path.relative(base,p)).sort();
  if(JSON.stringify(rel(sourceFiles,source))!==JSON.stringify(rel(destFiles,destination)))throw Error('Unreviewed added/missing static payload in '+destination);
  for(const file of sourceFiles){const target=path.join(destination,path.relative(source,file));if(!fs.readFileSync(file).equals(fs.readFileSync(target)))throw Error('Missing/changed static payload '+target);}
 }
 const built=read('dist/license-build-inputs.json');
 if(built.packageLockSHA256!==sha(fs.readFileSync(path.join(root,'package-lock.json'))))throw Error('Build uses a different lockfile');
 for(const input of built.inputs){const file=path.resolve(root,input.path);if(!file.startsWith(root+path.sep)||sha(fs.readFileSync(file))!==input.sha256)throw Error('Build input drift '+input.path);if(/^lightningcss(?:-|$)|^@napi-rs\/canvas/.test(input.packageName??''))throw Error('Build-only native package entered runtime module graph: '+input.packageName);}
 for(const output of built.outputs){const file=path.resolve(root,'dist',output.path);if(!file.startsWith(path.join(root,'dist')+path.sep)||sha(fs.readFileSync(file))!==output.sha256)throw Error('Built output drift '+output.path);}
 const outputs=new Set(built.outputs.map(x=>x.path.split(path.sep).join('/')));
 const publicPaths=new Set(walk(path.join(root,'public')).map(file=>path.relative(path.join(root,'public'),file).split(path.sep).join('/')));
 for(const file of walk(path.join(root,'dist'))){const relative=path.relative(path.join(root,'dist'),file).split(path.sep).join('/');if(!publicPaths.has(relative)&&!outputs.has(relative)&&relative!=='license-build-inputs.json')throw Error('Unreviewed extra distribution file '+relative);}
 for(const file of walk(path.join(root,'dist/assets'))){const relative=path.relative(path.join(root,'dist'),file).split(path.sep).join('/');if(!outputs.has(relative))throw Error('Unrecorded generated asset '+relative);if(/\.(?:node|dll|so|dylib|exe|ttf|otf|woff2?)$/i.test(file))throw Error('Unreviewed generated native/font payload '+relative);}
}
const review=read('public/third-party-licenses/review-required.json');report.unresolved=review.items;
report.releaseAllowed=!failed&&review.items.length===0&&!args.has('--evidence-only');
console.log(JSON.stringify(report,null,2));
if(failed||(!args.has('--evidence-only')&&review.items.length))process.exitCode=1;
