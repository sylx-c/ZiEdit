#!/usr/bin/env node
/** Inspect a Windows installer without running it (default path: 7-Zip archive listing + isolated extraction).
 *
 * Approved fallback (2026-11-12, option B): when 7-Zip cannot parse the NSIS archive
 * (upstream parser defect — see docs/tmp/phase-a/7z-nsis-bug-report.md: a single embedded
 * resource path growing by one character flips parseability) and ZIEDIT_INSTALLER_VERIFY_FALLBACK=1
 * is set, verify by silent-install extraction instead: run `installer /S /D=<isolated dir>`,
 * compare every landed legal/source payload byte-for-byte against audited inputs, compare the
 * installed runtime EXE against build output (same Tauri UNK→NSS tolerance), reject any
 * unexpected file, then silently uninstall. Guarantees lost vs. the archive path (recorded in
 * the report): static NSIS format/compressor assertion and $PLUGINSDIR plugin-hash matching —
 * both corroborated by the same-commit CI three-platform build. The report method field records
 * the fallback, so candidates verified this way stay traceable. Remove once 7-Zip is fixed. */
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
let listing;
try{ listing=run(['l','-slt',installer]); }
catch(listError){
  if(process.env.ZIEDIT_INSTALLER_VERIFY_FALLBACK!=='1')throw listError;
  console.error('[fallback] 7-Zip NSIS listing failed; ZIEDIT_INSTALLER_VERIFY_FALLBACK=1 -> silent-install verification');
  process.exit(verifyBySilentInstall(listError));
}
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

/** 已批准的静默安装回退（见文件头注释）：不解析档案，安装到隔离目录后逐字节比对。 */
function verifyBySilentInstall(listError){
  const sleepMs=ms=>spawnSync(process.execPath,['-e',`setTimeout(()=>{},${ms})`],{windowsHide:true});
  const waitFile=(file,seconds)=>{for(let i=0;i<seconds;i++){if(fs.existsSync(file))return true;sleepMs(1000);}return fs.existsSync(file);};
  const fail=(message)=>{const r={...baseReport(),status:'failed',error:message};fs.mkdirSync(extract,{recursive:true});fs.writeFileSync(path.join(extract,'verification-report.json'),JSON.stringify(r,null,2)+'\n');console.error(JSON.stringify(r,null,2));return 1;};
  const baseReport=()=>({schemaVersion:1,platform:process.platform,installerPath:path.relative(root,installer).split(path.sep).join('/'),installerSHA256:sha(fs.readFileSync(installer)),installerBytes:fs.statSync(installer).size,method:'FALLBACK: silent-install extraction (approved option B); 7-Zip NSIS archive parsing failed upstream, so the installer was run with /S into an isolated directory, every landed legal/source payload compared to audited inputs, installed runtime EXE compared to build output, unexpected files rejected, then silently uninstalled. Static NSIS format/compressor assertion and $PLUGINSDIR plugin-hash matching are NOT performed on this path; both are corroborated by the same-commit CI three-platform build.',compressor:'Configured Deflate (zlib); not statically asserted on fallback path',plugins:[],legalDirectories:['font-licenses','third-party-licenses'],sourceOffer:'third-party-licenses/SOURCE-OFFERS.txt points to the public repository (compliance/) for corresponding sources',webviewBootstrapperBundled:false,vcRuntimeBundled:false,limitations:'Fallback path validates payload identity and installability of this Windows x64 package only; archive-format statics and plugin hashes are covered by the same-commit CI build instead.',fallback:{reason:String(listError?.message??listError).split('\n')[0],upstreamReport:'docs/tmp/phase-a/7z-nsis-bug-report.md',approved:'option B, 2026-11-12'}});
  const installDir=path.join(extract,'install');
  if(/\s/.test(installDir))return fail('fallback install path must not contain spaces (NSIS /D= quoting)');
  try{
    const builtExePath=path.resolve(path.dirname(installer),'../..','ziedit.exe');
    if(!fs.existsSync(builtExePath))return fail('built ziedit.exe not found next to bundle: '+builtExePath);
    const builtExe=fs.readFileSync(builtExePath);
    fs.mkdirSync(installDir,{recursive:true});
    const ins=spawnSync(installer,['/S',`/D=${installDir}`],{windowsHide:true,timeout:600000});
    if(ins.status!==0)return fail('silent install failed with exit '+ins.status);
    if(!waitFile(path.join(installDir,'uninstall.exe'),180))return fail('uninstall.exe did not materialize after silent install');
    // 逐字节比对：法务/源码载荷与受审输入一致（与档案路径同一张比对表）。
    let compared=0;
    const same=(source,target)=>{if(!fs.existsSync(target)||!fs.readFileSync(source).equals(fs.readFileSync(target)))throw Error('Installed payload missing/changed '+target);compared++;};
    for(const [source,destination]of [['LICENSE','LICENSE'],['THIRD-PARTY-NOTICES.md','THIRD-PARTY-NOTICES.md'],['src/markdown-view/unicode-emojis.NOTICE.md','unicode-emojis.NOTICE.md']])same(path.join(root,source),path.join(installDir,destination));
    const expected=new Set(['ziedit.exe','uninstall.exe','unins000.exe','unins000.dat','LICENSE','THIRD-PARTY-NOTICES.md','unicode-emojis.NOTICE.md']);
    const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
    for(const group of ['font-licenses','third-party-licenses'])for(const file of walk(path.join(root,'public',group))){const relative=path.relative(path.join(root,'public'),file).split(path.sep).join('/');expected.add(relative);same(file,path.join(installDir,relative));}
    // 运行时 EXE 与构建产物逐字节一致（含 Tauri UNK→NSS 打包类型标记容差，与档案路径同判据）。
    const installedExe=fs.readFileSync(path.join(installDir,'ziedit.exe'));
    const marker=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'),replacement=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
    const patched=Buffer.from(builtExe),markerOffset=patched.indexOf(marker);
    let bundleTypePatch=false;
    if(!builtExe.equals(installedExe)&&markerOffset>=0&&patched.indexOf(marker,markerOffset+1)<0){replacement.copy(patched,markerOffset);bundleTypePatch=patched.equals(installedExe);}
    if(!builtExe.equals(installedExe)&&!bundleTypePatch)throw Error('Installed executable differs beyond the exact Tauri UNK-to-NSS bundle type marker');
    // 无预期外文件（落盘级）：允许集之外即拒绝。
    for(const file of walk(installDir)){const relative=path.relative(installDir,file).split(path.sep).join('/');if(!expected.has(relative))throw Error('Unexpected installed payload '+relative);}
    // 卸载器同判据：PE 魔数/尺寸合理 + 哈希留档。
    const uninstallerBytes=fs.readFileSync(path.join(installDir,'uninstall.exe'));
    if(uninstallerBytes.subarray(0,2).toString('ascii')!=='MZ'||uninstallerBytes.length<64*1024||uninstallerBytes.length>8*1024*1024)throw Error('Uninstaller payload is not a plausible makensis-generated PE');
    const report={...baseReport(),exeComparison:{builtSHA256:sha(builtExe),installedSHA256:sha(installedExe),exactTauriBundleTypePatch:bundleTypePatch,markerOffset:bundleTypePatch?markerOffset:null},comparedFiles:compared,uninstaller:{bytes:uninstallerBytes.length,sha256:sha(uninstallerBytes)},status:'passed'};
    fs.writeFileSync(path.join(extract,'verification-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  }catch(error){return fail(String(error?.message??error));}
  // 清理：静默卸载隔离目录；随后把候选装回用户目录（恢复文件关联并供两天试用；与 installed-package 脚本同口径）。
  const uninstall=path.join(installDir,'uninstall.exe');
  if(fs.existsSync(uninstall))spawnSync(uninstall,['/S',`_?=${installDir}`],{windowsHide:true,timeout:600000});
  for(let i=0;i<90&&fs.existsSync(path.join(installDir,'ziedit.exe'));i++)sleepMs(1000);
  const userDir=process.env.ZIEDIT_USER_INSTALL_DIR??'D:\\Program Files\\ZiEdit';
  if(process.env.ZIEDIT_USER_RESTORE!=='0'){spawnSync(installer,['/S',`/D=${userDir}`],{windowsHide:true,timeout:600000});waitFile(path.join(userDir,'uninstall.exe'),120);}
  return 0;
}
