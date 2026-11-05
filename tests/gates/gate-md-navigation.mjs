// 原生功能门：完整选择/查找、增量正文身份、分屏接管、右轨导航与撤销历史。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EXE, RUN_DIR, waitTargets, connectCDP, waitFor, switchMdMode, dismissOverlay,
  clickXY, pressKey, killTree, sleep, percentile, setNativeWindowSize } from './gate-lib.mjs';

const corpus=path.resolve(process.argv[2]??path.join(RUN_DIR,'corpus/repeated-6001.md'));
const output=path.resolve(process.argv[3]??path.join(RUN_DIR,'results/md-navigation.json'));
fs.mkdirSync(path.dirname(output),{recursive:true});
const out={verdict:false,exe:EXE,sha256:crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex'),corpus,checks:[],errors:[]};
const save=()=>fs.writeFileSync(output,JSON.stringify(out,null,2));
const check=(name,pass,detail)=>{out.checks.push({name,pass,...detail});save();console.log(`${pass?'PASS':'FAIL'} ${name} ${JSON.stringify(detail)}`)};
const child=spawn(EXE,[corpus],{stdio:'ignore',windowsHide:true,env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:process.env.ZIEDIT_GATE_PROFILE_ROOT ? path.join(process.env.ZIEDIT_GATE_PROFILE_ROOT,'navigation') : path.join(RUN_DIR,'profiles/md-navigation-'+crypto.randomUUID())}});
let cdp;
let originalBounds;
const probe=`window.__nav={...window.__nav,
 cm(){return [...document.querySelectorAll('.cm-content')].find(e=>e.offsetParent!==null)?.cmTile?.view},
 preview(){return document.querySelector('.md-split-preview')??document.querySelector('.md-preview')},
 block(sc,offset=2){const root=sc.querySelector('.md-col'),y=sc.getBoundingClientRect().top+offset;
   const at=nodes=>{let lo=0,hi=nodes.length;while(lo+1<hi){const mid=(lo+hi)>>>1;if(nodes[mid].getBoundingClientRect().top<=y)lo=mid;else hi=mid;}return nodes[lo]};
   const outer=at([...root.children].filter(e=>!e.hidden));return outer?.classList.contains('md-reading-page')?at([...outer.children].filter(e=>!e.hidden)):outer;
 },
 lines(){const v=this.cm(),s=this.preview();if(!v||!s)return null;
   const y=v.scrollDOM.getBoundingClientRect().top-v.documentTop,b=v.lineBlockAtHeight(Math.max(0,y));
   const first=v.state.doc.lineAt(b.from).number,last=v.state.doc.lineAt(b.to).number;
   const left=first+Math.max(0,Math.min(1,(y-b.top)/b.height))*(last-first+1);
   const rect=s.getBoundingClientRect(), hit=this.block(s);
   const top=hit.getBoundingClientRect().top-rect.top+s.scrollTop;
   const right=+hit.dataset.line+1+Math.max(0,Math.min(1,(s.scrollTop-top)/Math.max(1,hit.offsetHeight)))*(+hit.dataset.endLine-+hit.dataset.line);
   return {left,right,delta:Math.abs(left-right),leftTop:v.scrollDOM.scrollTop,rightTop:s.scrollTop};
 },
 twoFrames(){return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(this.lines()))))}
};`;
try{
 cdp=await connectCDP((await waitTargets(60000)).webSocketDebuggerUrl);
 await waitFor(cdp,`!!document.querySelector('.md-col[data-render-complete="1"]')`,180000);await dismissOverlay(cdp);await cdp.evaluate(probe);
 const initial=await cdp.evaluate(`(()=>{const root=document.querySelector('.md-col');window.__nav.root=root;window.__nav.nodes=[...root.querySelectorAll('.md-block')];return{blocks:window.__nav.nodes.length,text:root.textContent.length}})()`);
 check('完整正文保留全部块',initial.blocks>=6001,initial);
 const at=await cdp.evaluate(`(()=>{const r=document.querySelector('.md-col p').getBoundingClientRect();return{x:r.left+20,y:r.top+5}})()`);
 await clickXY(cdp,at.x,at.y);await pressKey(cdp,'a','KeyA',65,2);
 const selection=await cdp.evaluate(`(()=>{const nodes=window.__nav.nodes,s=getSelection();return{first:s.containsNode(nodes[0],true),last:s.containsNode(nodes[nodes.length-1],true),length:s.toString().length}})()`);
 check('Ctrl+A 包含首尾与跨段正文',selection.first&&selection.last&&selection.length>initial.text*.9,selection);
 await pressKey(cdp,'f','KeyF',70,2);
 await waitFor(cdp,`[...document.querySelectorAll('.tv-bar-input')].some(e=>e.offsetParent!==null)`);
 await cdp.send('Input.insertText',{text:'Last paragraph'});await pressKey(cdp,'Enter','Enter',13);await sleep(350);
 const found=await cdp.evaluate(`({count:[...document.querySelectorAll('.fb-count')].filter(e=>e.offsetParent!==null).map(e=>e.textContent),top:window.__nav.preview().scrollTop})`);
 check('全文查找可定位文末',found.top>1000&&found.count.some(s=>/1/.test(s)),found);await pressKey(cdp,'Escape','Escape',27);
 await switchMdMode(cdp,'分屏预览');await waitFor(cdp,`!!document.querySelector('.md-split-preview .md-col[data-render-complete="1"]')`);await cdp.evaluate(probe);
 await cdp.evaluate(`(()=>{const root=document.querySelector('.md-col'),v=window.__nav.cm();window.__nav.root=root;window.__nav.nodes=[...root.querySelectorAll('.md-block')];window.__nav.version=root.dataset.documentVersion;window.__nav.before=v.state.doc.toString();v.dispatch({selection:{anchor:v.state.doc.length}});v.focus()})()`);
 await cdp.send('Input.insertText',{text:'!'});
 await waitFor(cdp,`document.querySelector('.md-col')?.dataset.documentVersion!==window.__nav.version && document.querySelector('.md-col')?.dataset.renderComplete==='1'`);
 const update=await cdp.evaluate(`(()=>{const root=document.querySelector('.md-col'),nodes=window.__nav.nodes,next=root.querySelectorAll('.md-block');return{root:root===window.__nav.root,unchanged:nodes.slice(0,-1).every((n,i)=>n===next[i]),tail:root.lastElementChild.textContent.endsWith('!'),dirty:window.__nav.cm().state.doc.toString()===window.__nav.before+'!'}})()`);
 check('末尾改单字符保留正文根和6000未变块',update.root&&update.unchanged&&update.tail&&update.dirty,update);
 await pressKey(cdp,'z','KeyZ',90,2);await waitFor(cdp,`window.__nav.cm().state.doc.toString()===window.__nav.before`);
 await waitFor(cdp,`!document.querySelector('.md-col').lastElementChild.textContent.endsWith('!')`);
 check('真实键盘撤销同步预览',true,{});
 await pressKey(cdp,'Z','KeyZ',90,10);await waitFor(cdp,`window.__nav.cm().state.doc.toString()===window.__nav.before+'!'`);
 await waitFor(cdp,`document.querySelector('.md-col').lastElementChild.textContent.endsWith('!')`);
 check('真实键盘重做同步预览',true,{});
 // 每次真实输入换一侧；从该侧 scroll 事件开始计两个动画帧。
 const sync=[];
 for(const side of ['left','right','left','right']){
   await cdp.evaluate(`(()=>{const sc=${side==='left'?'window.__nav.cm().scrollDOM':'window.__nav.preview()'};window.__nav.synced=new Promise(resolve=>sc.addEventListener('scroll',()=>window.__nav.twoFrames().then(resolve),{once:true}));})()`);
   const point=await cdp.evaluate(`(()=>{const r=(${side==='left'?'window.__nav.cm().scrollDOM':'window.__nav.preview()'}).getBoundingClientRect();return{x:r.left+r.width*.4,y:r.top+r.height*.4}})()`);
   await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:side==='left'?-160:160});
   sync.push({side,...await cdp.evaluate('window.__nav.synced')});
 }
 check('分屏连续滚动与反向接管在两帧内同步',sync.every(s=>s.delta<=2),{samples:sync});
 const cursor=await cdp.evaluate(`({head:window.__nav.cm().state.selection.main.head,left:window.__nav.cm().scrollDOM.scrollLeft})`);
 const map=await cdp.evaluate(`(()=>{const r=document.querySelector('.minimap').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height*.6,end:r.top+r.height*.85}})()`);
 await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:map.x,y:map.y,button:'left',clickCount:1});
 await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:map.x,y:map.end,button:'left',buttons:1});
 await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:map.x,y:map.end,button:'left',clickCount:1});await sleep(200);
 const dragged=await cdp.evaluate(`(()=>{const v=window.__nav.cm(),s=window.__nav.preview();return{head:v.state.selection.main.head,horizontal:v.scrollDOM.scrollLeft,ratio:s.scrollTop/s.scrollHeight,...window.__nav.lines()}})()`);
 check('地图拖动保持光标和横向位置并同步源码',dragged.head===cursor.head&&dragged.horizontal===cursor.left&&dragged.ratio>.8&&dragged.delta<=2,dragged);
 // 阅读面自己负责尺寸变化；在同一块持续采样，不能等图片/布局停稳才开始。
 const trial=async mutation=>cdp.evaluate(`new Promise(resolve=>{
   const sc=window.__nav.preview(),r=sc.getBoundingClientRect();
   const node=window.__nav.block(sc,20);
   if(!node)return resolve({maxDrift:Infinity,missing:true});
   const col=sc.querySelector('.md-col').getBoundingClientRect();
   const caret=document.caretRangeFromPoint?.(Math.max(r.left+1,Math.min(r.right-1,col.left+70)),r.top+24);
   const geometry=caret?.startContainer.nodeType===Node.TEXT_NODE&&sc.contains(caret.startContainer)&&caret.getClientRects().length?caret:node;
   const start=geometry.getBoundingClientRect().top,top=sc.scrollTop;let maxDrift=0,lost=false;const begin=performance.now(),trace=[];
   ${mutation}
   const tick=()=>{lost ||= !node.isConnected; if(node.isConnected)maxDrift=Math.max(maxDrift,Math.abs(geometry.getBoundingClientRect().top-start));
     if(${!!process.env.ZIEDIT_MD_TRACE})trace.push({at:performance.now()-begin,y:geometry.getBoundingClientRect().top,top:sc.scrollTop,height:sc.scrollHeight,imageReady:window.__nav.delayedImage?.complete});
     if(performance.now()-begin<1500)requestAnimationFrame(()=>setTimeout(tick,0));
     else resolve({maxDrift,lost,anchorKind:geometry===node?'block':'text',topDelta:sc.scrollTop-top,imageReady:window.__nav.delayedImage?.complete,trace});};
   requestAnimationFrame(()=>setTimeout(tick,0));
 })`);
 const font=await trial(`window.__nav.oldFont=document.documentElement.style.getPropertyValue('--md-fs-user');document.documentElement.style.setProperty('--md-fs-user','17px');`);
 check('字号变化后连续1.5秒保持阅读锚',!font.lost&&font.maxDrift<=4,font);
 await cdp.evaluate(`document.documentElement.style.setProperty('--md-fs-user',window.__nav.oldFont)`);await sleep(100);
 const image=await trial(`const parent=node.previousElementSibling??node;const img=document.createElement('img');window.__nav.delayedImage=img;parent.append(img);
   setTimeout(()=>{const c=document.createElement('canvas');c.width=64;c.height=240;img.src=c.toDataURL('image/png')},250);`);
 check('图片延迟加载后连续1.5秒保持阅读锚',!image.lost&&image.maxDrift<=4&&image.imageReady,image);
 await cdp.evaluate(`window.__nav.delayedImage?.remove()`);await sleep(100);
 const resizeTrial=trial('');
 originalBounds=await setNativeWindowSize(child.pid,1196,761);
 const resize=await resizeTrial;
 check('原生窗口缩放后连续1.5秒保持阅读锚',!resize.lost&&resize.maxDrift<=4,{...resize,originalBounds});
 await setNativeWindowSize(child.pid,originalBounds.width,originalBounds.height);originalBounds=null;await sleep(100);
 await switchMdMode(cdp,'即时渲染');await waitFor(cdp,`!!document.querySelector('.md-ir:not(.md-ir-loading) .cm-content')`);await cdp.evaluate(probe);
 check('模式切换保留修改和选区',await cdp.evaluate(`window.__nav.cm().state.doc.toString()===window.__nav.before+'!' && window.__nav.cm().state.selection.main.head===${cursor.head}`),{});
 await pressKey(cdp,'z','KeyZ',90,2);await waitFor(cdp,`window.__nav.cm().state.doc.toString()===window.__nav.before`);
 check('跨模式撤销栈保留',true,{});
 // 输入到下一个可见帧，不把 Worker 正文完全完成当作输入响应。
 const responses=[];
 for(let i=0;i<10;i++){
   await cdp.evaluate(`window.__nav.cm().focus();window.__nav.inputStart=performance.now();window.__nav.inputLength=window.__nav.cm().state.doc.length`);
   await cdp.send('Input.insertText',{text:'x'});
   responses.push(await cdp.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>resolve(window.__nav.cm().state.doc.length===window.__nav.inputLength+1?performance.now()-window.__nav.inputStart:Infinity)))`));await sleep(50);
 }
 const inputP95=percentile(responses.sort((a,b)=>a-b),.95);check('即时渲染输入首帧 P95 ≤50ms',inputP95<=50,{inputP95,responses});
 await sleep(650);
 await cdp.evaluate(`window.__nav.imeBefore=window.__nav.cm().state.doc.toString();window.__nav.imeHead=window.__nav.cm().state.selection.main.head`);
 await cdp.send('Input.imeSetComposition',{text:'中',selectionStart:1,selectionEnd:1});
 await cdp.send('Input.imeSetComposition',{text:'中文输入',selectionStart:4,selectionEnd:4});
 await cdp.send('Input.insertText',{text:'中文输入'});
 const ime=await cdp.evaluate(`(()=>{const s=window.__nav.imeBefore,p=window.__nav.imeHead;return window.__nav.cm().state.doc.toString()===s.slice(0,p)+'中文输入'+s.slice(p)})()`);
 check('原生输入法组合只提交一次正文',ime,{});
 await pressKey(cdp,'z','KeyZ',90,2);
 check('输入法组合可一次撤销',await cdp.evaluate(`window.__nav.cm().state.doc.toString()===window.__nav.imeBefore`),{});
 await switchMdMode(cdp,'渲染预览');await waitFor(cdp,`!!document.querySelector('.md-col[data-render-complete="1"]')`);
 const roundTrip=await cdp.evaluate(`({blocks:document.querySelectorAll('.md-col .md-block:not([hidden])').length,text:document.querySelector('.md-col').textContent.length})`);
 check('即时渲染返回预览保留全文与修改',roundTrip.blocks===initial.blocks&&roundTrip.text>=initial.text,roundTrip);
 const screenshot=await cdp.send('Page.captureScreenshot',{format:'png'});
 fs.writeFileSync(output+'.png',Buffer.from(screenshot.data,'base64'));
 out.verdict=out.checks.every(c=>c.pass);
}catch(error){out.errors.push(String(error.stack??error));}
finally{if(originalBounds)await setNativeWindowSize(child.pid,originalBounds.width,originalBounds.height).catch(()=>{});cdp?.close();await killTree(child.pid);save();}
console.log(JSON.stringify({verdict:out.verdict,errors:out.errors}));process.exitCode=out.verdict?0:1;
