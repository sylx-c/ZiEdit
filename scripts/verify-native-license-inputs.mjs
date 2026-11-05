#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const lock=fs.readFileSync(path.join(root,'src-tauri/Cargo.lock'),'utf8');
const pkgs=JSON.parse(execFileSync('cargo',['metadata','--manifest-path','src-tauri/Cargo.toml','--format-version','1','--locked','--offline'],{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','inherit']})).packages;
function exact(name,version){const matches=pkgs.filter(x=>x.name===name);if(matches.length!==1||matches[0].version!==version)throw Error('Unreviewed native crate version '+name);return path.dirname(matches[0].manifest_path);}
function checked(base,item){const p=path.resolve(base,item.cachePath??item.path);if(!p.startsWith(path.resolve(base)+path.sep))throw Error('Unsafe native source path');const data=fs.readFileSync(p);if(data.length!==item.bytes||sha(data)!==item.sha256)throw Error('Native input changed '+p);}
const ring=json(path.join(root,'compliance/third-party-sources/ring-notices/manifest.json'));
const ringCache=exact('ring',ring.version);
const block=lock.split('[[package]]').find(b=>b.includes('name = "ring"')&&b.includes(`version = "${ring.version}"`));
if(!block?.includes(`checksum = "${ring.archiveSHA256}"`))throw Error('ring source archive differs from current Cargo.lock');
for(const file of ring.archiveFiles)checked(ringCache,file);
const loader=json(path.join(root,'compliance/third-party-sources/webview2-loader/manifest.json'));
const [crate,version]=loader.crate.split(' '),loaderCache=exact(crate,version);
const vcs=json(path.join(loaderCache,'.cargo_vcs_info.json'));
if(vcs.git.sha1!==loader.crateRevision)throw Error('Unreviewed WebView loader crate revision');
for(const file of loader.loaderFiles)checked(loaderCache,file);
const installer=json(path.join(root,'compliance/third-party-sources/windows-installer/manifest.json'));
const actualConfig=json(path.join(root,'src-tauri/tauri.conf.json'));
if(actualConfig.bundle?.useLocalToolsDir||process.env.ZIEDIT_NSIS_TOOLS||process.env.TAURI_BUNDLER_TOOLS_GITHUB_MIRROR_TEMPLATE)throw Error('Unreviewed installer tool path or download override');
const toolRoot=path.join(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData/Local'),'tauri/NSIS');
let tools='not applicable on this OS';
if(process.platform==='win32'){
 if(!fs.existsSync(toolRoot)){
  if(process.argv.includes('--installer-tools'))throw Error('Installer toolchain missing for post-package check');
  tools='not downloaded yet; required again after packaging';
 }else{
  const defaultSet=json(path.join(root,'compliance/third-party-sources/windows-installer/default-nsis-3.11/manifest.json'));
  for(const item of defaultSet.files)checked(path.join(root,'compliance/third-party-sources/windows-installer/default-nsis-3.11'),item);
  const sets=[{version:installer.nsisVersion,tools:installer.tools},{version:defaultSet.nsisVersion,tools:defaultSet.tools}];
  const match=sets.find(set=>set.tools.every(item=>{try{checked(toolRoot,item);return true;}catch{return false;}}));
  if(!match)throw Error('NSIS compiler/stub/plugin changed or unreviewed');
  const solidStubs={'3.11':'e6c2afdd03c7bc5f1dc24449e5c92f3859f7586f399dff01c175d52e052bc943','3.13':'5c376c4b417d81cb17fcb576471b64abb49d6d99ef75699d4968d803ea5d5f4e'};
  // Exact official3.11 ZIP / local3.13 source-matched toolset solid-zlib stub.
  checked(toolRoot,{path:'Stubs/zlib_solid-x86-unicode',bytes:40960,sha256:solidStubs[match.version]});
  const cli=json(path.join(root,'node_modules/@tauri-apps/cli/package.json')).version;
  if(cli!=='2.12.2')throw Error('Tauri bundler version changed; installer source/notice review required');
  tools='NSIS '+match.version+' toolset byte-verified';
 }
}
console.log(JSON.stringify({ringFiles:ring.archiveFiles.length,loaderFiles:loader.loaderFiles.length,installer:tools,status:'native inputs match current locks and recorded artifacts'}));
