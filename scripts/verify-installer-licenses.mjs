#!/usr/bin/env node
/** Inspect a Windows installer without running/installing it. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [installerArg,extractArg,sevenZipArg]=process.argv.slice(2);
if(!installerArg||!extractArg||!sevenZipArg)throw Error('Usage: verify-installer-licenses.mjs <installer> <new-extract-directory> <7z-executable>');
const installer=path.resolve(installerArg),extract=path.resolve(extractArg),sevenZip=/[\\/]/.test(sevenZipArg)?path.resolve(sevenZipArg):sevenZipArg;
if(!extract.startsWith(path.join(root,'docs/tmp')+path.sep)||fs.existsSync(extract))throw Error('Use a new isolated docs/tmp extraction directory');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const run=args=>{const r=spawnSync(sevenZip,args,{encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});if(r.status!==0)throw Error(r.stderr||r.stdout);return r.stdout;};
const listing=run(['l','-slt',installer]);
if(!/Type = Nsis/.test(listing)||!/Method = Deflate/.test(listing)||/Method = (?:LZMA|BZip)/i.test(listing))throw Error('Installer uses unreviewed format/compressor');
const entries=listing.split(/\r?\n\r?\n/).filter(block=>/^Path = /m.test(block)).map(block=>({path:/^Path = (.*)$/m.exec(block)?.[1].trim(),size:Number(/^Size = (\d+)$/m.exec(block)?.[1]??-1)})).filter(x=>x.size>=0);
if(entries.some(e=>path.isAbsolute(e.path)||e.path.split(/[\\/]/).includes('..')))throw Error('Unsafe installer member');
fs.mkdirSync(extract,{recursive:true});run(['x',installer,'-o'+extract,'-y']);
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
const expected=new Set(['ziedit.exe','LICENSE','THIRD-PARTY-NOTICES.md','unicode-emojis.NOTICE.md','uninstall.exe']);let compared=0;
function same(source,target){if(!fs.existsSync(target)||!fs.readFileSync(source).equals(fs.readFileSync(target)))throw Error('Installer payload missing/changed '+target);compared++;}
const targetDir=path.resolve(path.dirname(installer),'../..');
const builtExe=fs.readFileSync(path.join(targetDir,'ziedit.exe'));
const packagedExe=fs.readFileSync(path.join(extract,'ziedit.exe'));
const marker=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'),replacement=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
const patched=Buffer.from(builtExe),markerOffset=patched.indexOf(marker);
let bundleTypePatch=false;
if(!builtExe.equals(packagedExe)&&markerOffset>=0&&patched.indexOf(marker,markerOffset+1)<0){replacement.copy(patched,markerOffset);bundleTypePatch=patched.equals(packagedExe);}
if(!builtExe.equals(packagedExe)&&!bundleTypePatch)throw Error('Packaged executable differs beyond the exact Tauri UNK-to-NSS bundle type marker');
compared++;
for(const [source,destination]of [['LICENSE','LICENSE'],['THIRD-PARTY-NOTICES.md','THIRD-PARTY-NOTICES.md'],['src/markdown-view/unicode-emojis.NOTICE.md','unicode-emojis.NOTICE.md']])same(path.join(root,source),path.join(extract,destination));
for(const group of ['font-licenses','third-party-licenses'])for(const file of walk(path.join(root,'public',group))){const relative=path.relative(path.join(root,'public'),file).split(path.sep).join('/');expected.add(relative);same(file,path.join(extract,relative));}
// uninstall.exe（若 7z 物化出该条目）由 makensis 随每次构建生成，哈希随构建变化：
// 按名放行 + PE 魔数/尺寸校验 + 哈希入报告留档；是否物化取决于 7z 对卸载段的解析，不作为要求。
const uninstallerPath=path.join(extract,'uninstall.exe');let uninstaller=null;
if(fs.existsSync(uninstallerPath)){const uninstallerBytes=fs.readFileSync(uninstallerPath);
if(uninstallerBytes.subarray(0,2).toString('ascii')!=='MZ'||uninstallerBytes.length<64*1024||uninstallerBytes.length>8*1024*1024)throw Error('Uninstaller payload is not a plausible makensis-generated PE');
uninstaller={bytes:uninstallerBytes.length,sha256:sha(uninstallerBytes)};}
const nsis=JSON.parse(fs.readFileSync(path.join(root,'compliance/third-party-sources/windows-installer/manifest.json'),'utf8'));
const def=JSON.parse(fs.readFileSync(path.join(root,'compliance/third-party-sources/windows-installer/default-nsis-3.11/manifest.json'),'utf8'));
const toolsets=[nsis.tools,def.tools];const plugins=[];
for(const file of walk(path.join(extract,'$PLUGINSDIR'))){const name=path.basename(file),bytes=fs.readFileSync(file),digest=sha(bytes);const reviewed=toolsets.flat().some(item=>item.sha256===digest&&item.bytes===bytes.length);if(!reviewed)throw Error('Unreviewed installer plugin/artwork '+name);plugins.push({path:name,bytes:bytes.length,sha256:digest});}
for(const file of walk(extract)){const relative=path.relative(extract,file).split(path.sep).join('/');if(!relative.startsWith('$PLUGINSDIR/')&&!expected.has(relative))throw Error('Unexpected installer payload '+relative);}
const report={schemaVersion:1,platform:process.platform,installerPath:path.relative(root,installer).split(path.sep).join('/'),installerSHA256:sha(fs.readFileSync(installer)),installerBytes:fs.statSync(installer).size,method:'NSIS archive listing and isolated extraction with 7-Zip; no installer execution. Every readable legal/source payload compared to audited source, runtime EXE compared to build output, installer plugins/artwork matched audited NSIS hashes; unknown members rejected.',compressor:'Deflate (zlib)',exeComparison:{builtSHA256:sha(builtExe),packagedSHA256:sha(packagedExe),exactTauriBundleTypePatch:bundleTypePatch,markerOffset:bundleTypePatch?markerOffset:null},comparedFiles:compared,uninstaller,plugins,legalDirectories:['font-licenses','third-party-licenses'],sourceOffer:'third-party-licenses/SOURCE-OFFERS.txt points to the public repository (compliance/) for corresponding sources',webviewBootstrapperBundled:false,vcRuntimeBundled:false,status:'passed',limitations:'Validates this Windows x64 package only; does not run installer or certify macOS/Linux/AppImage contents.'};
fs.writeFileSync(path.join(extract,'verification-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
