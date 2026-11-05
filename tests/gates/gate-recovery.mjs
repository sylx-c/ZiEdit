// 隔离应用中的强杀恢复回归：仅使用 RUN_DIR 测试文件，恢复设置并清理本项快照。
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {EXE,RUN_DIR,waitTargets,connectCDP,waitFor,waitMounted,dismissOverlay,killTree,pressKey,sleep} from './gate-lib.mjs';
const file=path.join(RUN_DIR,'recovery-native.txt'),output=path.resolve(process.argv[2]??path.join(RUN_DIR,'recovery-native.json'));
fs.mkdirSync(path.dirname(output),{recursive:true});
fs.mkdirSync(RUN_DIR,{recursive:true});fs.writeFileSync(file,'initial\n');
const report={verdict:false,exe:EXE,checks:[],errors:[]};let child,cdp,settings;
const check=(name,pass)=>{report.checks.push({name,pass});if(!pass)throw Error(name)};
const invoke=(command,args={})=>cdp.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
async function launch(){child=spawn(EXE,[file],{stdio:'ignore',windowsHide:true,env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(RUN_DIR,'profiles/recovery')}});cdp=await connectCDP((await waitTargets(60000)).webSocketDebuggerUrl);await cdp.send('Page.enable');await waitMounted(cdp);await waitFor(cdp,`document.querySelector('.tab.active .tab-name')?.textContent==='recovery-native.txt'`,20000);}
try{
 await launch();await dismissOverlay(cdp);settings=await invoke('settings_load');
 await invoke('settings_save',{settings:{...settings,autoSaveSec:2,autoSaveTarget:'sidecar'}});cdp.close();await killTree(child.pid);await sleep(1000);
 await launch();await dismissOverlay(cdp);
 await cdp.evaluate(`(()=>{const e=[...document.querySelectorAll('.cm-content')].find(e=>e.offsetParent!==null);e.cmTile.view.focus();e.cmTile.view.dispatch({selection:{anchor:e.cmTile.view.state.doc.length}})})()`);
 await cdp.send('Input.insertText',{text:'__RELEASE_RECOVER__'});
 await waitFor(cdp,`!!document.querySelector('.tab-dot')`,20000);
 await pressKey(cdp,'w','KeyW',87,2);await sleep(300);
 check('脏文件关闭出现守卫',await cdp.evaluate(`!!document.querySelector('.ov-mask')`));
 await cdp.evaluate(`[...document.querySelectorAll('.dlg-btn')].find(e=>e.textContent.includes('取消')||e.textContent.includes('Cancel'))?.click()`);
 check('取消关闭保留标签',await cdp.evaluate(`!!document.querySelector('.tab-dot')`));
 for(let i=0;i<40;i++){const r=await invoke('recovery_read',{key:file});if(r?.content.includes('__RELEASE_RECOVER__')){check('自动快照包含未保存输入',true);break}await sleep(500)}
 check('快照已生成',report.checks.some(c=>c.name==='自动快照包含未保存输入'));
 check('旁路快照未改原文件',!fs.readFileSync(file,'utf8').includes('__RELEASE_RECOVER__'));
 cdp.close();await killTree(child.pid);await sleep(1000);await launch();
 await waitFor(cdp,`[...document.querySelectorAll('.dlg-btn')].some(e=>e.textContent.includes('恢复所选')||e.textContent.includes('Restore'))`,20000);
 check('强杀重启出现恢复对话框',true);
 await cdp.evaluate(`window.__restoreDone=false;new MutationObserver(()=>{if(document.body.textContent.includes('已恢复未保存的编辑')||document.body.textContent.includes('Unsaved edits restored'))window.__restoreDone=true}).observe(document.body,{subtree:true,childList:true,characterData:true});[...document.querySelectorAll('.dlg-btn')].find(e=>e.textContent.includes('恢复所选')||e.textContent.includes('Restore'))?.click()`);
 await waitFor(cdp,'window.__restoreDone',120000);
 await cdp.evaluate(`[...document.querySelectorAll('.tab')].find(e=>e.querySelector('.tab-name')?.textContent==='recovery-native.txt')?.click()`);
 await waitFor(cdp,`[...document.querySelectorAll('.cm-content')].some(e=>e.offsetParent!==null&&e.cmTile?.view.state.doc.toString().includes('__RELEASE_RECOVER__'))`,20000);
 check('恢复后正文包含未保存输入',true);
 // 新隔离 profile 可能在恢复弹窗结束后显示欢迎层；关闭后再发真实保存快捷键。
 await dismissOverlay(cdp);await waitFor(cdp,`!document.querySelector('.ov-mask')`,10000);
 await cdp.evaluate(`[...document.querySelectorAll('.cm-content')].find(e=>e.offsetParent!==null)?.cmTile.view.focus()`);
 await pressKey(cdp,'s','KeyS',83,2);for(let i=0;i<40&&!fs.readFileSync(file,'utf8').includes('__RELEASE_RECOVER__');i++)await sleep(250);
 check('恢复后显式保存落盘',fs.readFileSync(file,'utf8').includes('__RELEASE_RECOVER__'));
 report.verdict=true;
}catch(e){report.errors.push(String(e.stack??e)); if(cdp) report.debug=await cdp.evaluate(`({body:document.body.innerText.slice(-6000),editors:[...document.querySelectorAll(".cm-content")].map(e=>({visible:e.offsetParent!==null,doc:e.cmTile?.view.state.doc.toString().slice(-500)}))})`).catch(String);}
finally{if(cdp){if(settings)await invoke('settings_save',{settings}).catch(()=>{});await invoke('recovery_discard',{keys:[file]}).catch(()=>{});cdp.close()}if(child)await killTree(child.pid).catch(()=>{});fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));process.exitCode=report.verdict?0:1;}
