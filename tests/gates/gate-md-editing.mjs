// 原生交互补充：表格输入/撤销、只读、大纲刷新，以及超长表格的实际列布局。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EXE, RUN_DIR, waitTargets, connectCDP, waitFor, switchMdMode, dismissOverlay,
  clickXY, pressKey, killTree, sleep, setNativeWindowSize } from './gate-lib.mjs';

const output=path.resolve(process.argv[2]??path.join(RUN_DIR,'results/md-editing.json'));
const file=path.join(RUN_DIR,'corpus/native-md-editing.md');
fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(path.dirname(output),{recursive:true});
fs.writeFileSync(file,'# Editable\n\n| Name | Value |\n| --- | --- |\n| Cell | Original |\n\n'+
  Array.from({length:40},(_,i)=>`Paragraph ${i}: native editing and outline navigation.`).join('\n\n')+'\n\n# Tail\n');
const out={verdict:false,exe:EXE,sha256:crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex'),checks:[],errors:[]};
const save=()=>fs.writeFileSync(output,JSON.stringify(out,null,2));
const check=(name,pass,detail={})=>{out.checks.push({name,pass,...detail});save();console.log(`${pass?'PASS':'FAIL'} ${name} ${JSON.stringify(detail)}`)};
const profile=process.env.ZIEDIT_GATE_PROFILE_ROOT ? path.join(process.env.ZIEDIT_GATE_PROFILE_ROOT,'editing') : path.join(RUN_DIR,'profiles/md-editing-'+crypto.randomUUID());
const child=spawn(EXE,[file],{stdio:'ignore',windowsHide:true,env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:profile}});
let cdp,locked=false;
const main=`[...document.querySelectorAll('.md-ir:not(.md-ir-loading) .cm-content')].find(e=>!e.closest('.mdir-tablebox'))?.cmTile?.view`;
async function at(selector){return cdp.evaluate(`(()=>{const e=${selector};if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)}
async function click(selector){const r=await at(selector);if(!r)throw new Error('Missing control: '+selector);await clickXY(cdp,r.x,r.y)}
async function readOnly(){
  await pressKey(cdp,'Alt','AltLeft',18,1);await sleep(150);
  await click(`[...document.querySelectorAll('.menu-item,.menu-btn')].find(e=>e.textContent.includes('编辑'))`);await sleep(150);
  await click(`[...document.querySelectorAll('.menu-dropdown .menu-action')].find(e=>e.querySelector('.ma-label')?.textContent.includes('全局只读锁定'))`);
}
try{
  cdp=await connectCDP((await waitTargets(60000)).webSocketDebuggerUrl);await cdp.send('Page.enable');
  await waitFor(cdp,`!!document.querySelector('.md-col,.md-ir:not(.md-ir-loading) .cm-content')`,180000);await dismissOverlay(cdp);
  await setNativeWindowSize(child.pid,1296,841);
  await switchMdMode(cdp,'即时渲染');await waitFor(cdp,`!!document.querySelector('.mdir-table td')`,180000);
  await cdp.evaluate(`window.__editingMain=()=>${main};window.__editingBefore=window.__editingMain().state.doc.toString()`);
  await click(`document.querySelector('.mdir-table td')`);
  await waitFor(cdp,`!!document.querySelector('.mdir-tablebox .cm-content')`);
  await cdp.send('Input.insertText',{text:'__NATIVE_CELL__'});
  await waitFor(cdp,`window.__editingMain().state.doc.toString().includes('__NATIVE_CELL__')`);
  check('真实表格单元格输入同步源缓冲',true);
  await pressKey(cdp,'Tab','Tab',9);await sleep(100);
  const tab=await cdp.evaluate(`({row:document.querySelector('.mdir-tablebox').dataset.mdTableRow,col:document.querySelector('.mdir-tablebox').dataset.mdTableCol})`);
  check('表格 Tab 移至下一格',tab.row==='1'&&tab.col==='1',tab);
  await pressKey(cdp,'Escape','Escape',27);await cdp.evaluate('window.__editingMain().focus()');
  await pressKey(cdp,'z','KeyZ',90,2);await waitFor(cdp,`window.__editingMain().state.doc.toString()===window.__editingBefore`);
  check('表格编辑可一次撤销',true);
  await pressKey(cdp,'Z','KeyZ',90,10);await waitFor(cdp,`window.__editingMain().state.doc.toString().includes('__NATIVE_CELL__')`);
  check('表格编辑可重做',true);
  await readOnly();locked=true;await waitFor(cdp,'window.__editingMain().state.readOnly');
  const before=await cdp.evaluate('window.__editingMain().state.doc.toString()');
  await cdp.evaluate('window.__editingMain().focus()');await cdp.send('Input.insertText',{text:'MUST_NOT_INSERT'});
  await click(`document.querySelector('.mdir-table td')`);
  const read=await cdp.evaluate(`({doc:window.__editingMain().state.doc.toString(),cell:!!document.querySelector('.mdir-tablebox .cm-content')})`);
  check('全局只读阻止正文输入和表格编辑',read.doc===before&&!read.cell,{cellEditor:read.cell});
  await readOnly();locked=false;await waitFor(cdp,'!window.__editingMain().state.readOnly');
  await click(`[...document.querySelectorAll('.sidebar-tab')].find(e=>e.textContent==='大纲')`);
  await waitFor(cdp,`!!document.querySelector('.sym-item')`);
  await cdp.evaluate(`(()=>{const v=window.__editingMain();v.dispatch({changes:[{from:0,insert:'Preface\\n\\n'},{from:v.state.doc.length,insert:'\\n# Refreshed\\n'}],userEvent:'input'})})()`);
  await waitFor(cdp,`[...document.querySelectorAll('.sym-item')].some(e=>e.textContent.includes('Refreshed'))`);
  await click(`[...document.querySelectorAll('.sym-item')].find(e=>e.textContent.includes('Refreshed'))`);await sleep(100);
  const outline=await cdp.evaluate(`(()=>{const v=window.__editingMain(),line=v.state.doc.lineAt(v.state.doc.toString().indexOf('# Refreshed')).number;
    const b=v.lineBlockAt(v.state.doc.line(line).from),r=v.scrollDOM.getBoundingClientRect(),y=v.documentTop+b.top;
    return{expected:line,indexed:Number([...document.querySelectorAll('.sym-item')].find(e=>e.textContent.includes('Refreshed'))?.dataset.line),visible:y>=r.top-1&&y<r.bottom}})()`);
  check('大纲刷新后按最新源位置定位',outline.indexed===outline.expected&&outline.visible,outline);
  const giant=path.join(RUN_DIR,'corpus/single-table-400k.md');
  if(!fs.existsSync(giant))throw new Error('Generate gen-md-surfaces-corpus.mjs before the giant-table layout check');
  const opener=spawn(EXE,[giant],{stdio:'ignore',windowsHide:true,env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:profile}});opener.unref();
  await waitFor(cdp,`document.querySelector('.tab.active')?.title.split('\\n')[0].toLowerCase()===${JSON.stringify(giant.toLowerCase())}`);
  await switchMdMode(cdp,'渲染预览');await waitFor(cdp,`!!document.querySelector('.md-reading-table')`,180000);
  await cdp.evaluate(`document.querySelector('.md-preview').scrollTop=0`);await sleep(100);
  const columns=await cdp.evaluate(`(()=>{const t=document.querySelector('.md-reading-table'),h=[...t.querySelectorAll('th')],r=[...t.querySelector('tbody tr').cells];return{rows:t.querySelectorAll('tr').length,chunks:t.querySelectorAll('.md-table-chunk').length,error:Math.max(...h.map((c,i)=>{const a=c.getBoundingClientRect(),b=r[i].getBoundingClientRect();return Math.max(Math.abs(a.left-b.left),Math.abs(a.width-b.width))}))}})()`);
  check('超长表完整保留行且表头与正文列对齐',columns.rows>256&&columns.chunks>1&&columns.error<=1,columns);
  const png=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(output+'.png',Buffer.from(png.data,'base64'));
  out.verdict=out.checks.every(c=>c.pass);
}catch(error){out.errors.push(String(error.stack??error));}
finally{if(locked)await readOnly().catch(()=>{});cdp?.close();await killTree(child.pid);save();}
console.log(JSON.stringify({verdict:out.verdict,errors:out.errors}));process.exitCode=out.verdict?0:1;
