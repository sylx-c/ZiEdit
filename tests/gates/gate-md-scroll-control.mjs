// 同一原生 WebView2 的空白滚动对照，用于识别 CDP 输入或机器帧率的额外延迟。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EXE, RUN_DIR, connectCDP, waitTargets, waitFor, killTree, INIT_OBSERVERS, RAF_SAMPLER, sleep, percentile, setNativeWindowSize, readDisplayEnvironment } from './gate-lib.mjs';
const output = path.resolve(process.argv[2] ?? path.join(RUN_DIR,'results/md-scroll-control.json'));
const child=spawn(EXE,[],{stdio:'ignore',windowsHide:true,env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(RUN_DIR,'profiles/scroll-control-'+Date.now())}});
let cdp;
try {
  cdp=await connectCDP((await waitTargets(60000)).webSocketDebuggerUrl);
  await setNativeWindowSize(child.pid,1296,841);
  // 清掉应用上下文及其解析/恢复任务；只替换 body 仍会让后台任务污染空白对照。
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate',{url:'about:blank'});
  await waitFor(cdp, `location.href === 'about:blank' && document.readyState === 'complete'`);
  const environment=await cdp.evaluate(`({scale:devicePixelRatio,width:innerWidth,height:innerHeight,gpu:(()=>{const gl=document.createElement('canvas').getContext('webgl');const ext=gl?.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null})()})`);
  const display=await readDisplayEnvironment();
  await cdp.evaluate(INIT_OBSERVERS+RAF_SAMPLER+`document.body.innerHTML='<div id="control" style="position:fixed;inset:0;overflow:auto;background:white;color:black;font:14px/24px Arial"><div style="height:100000px">Ordinary control text</div></div>';
    const sc=document.querySelector('#control'); window.responses=[];let stamp=null;
    sc.addEventListener('wheel',e=>stamp=e.timeStamp,{passive:true});
    sc.addEventListener('scroll',()=>{if(stamp!=null){responses.push(performance.now()-stamp);stamp=null;}},{passive:true});
    window.__rafStart();`);
  for(const deltaY of [...Array(18).fill(160),...Array(9).fill(-160)]){
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:400,y:300,deltaX:0,deltaY});await sleep(45);
  }
  const frames=await cdp.evaluate('__rafStop()'), responses=await cdp.evaluate('responses');
  const out={exe:EXE,display,environment,frameP95:percentile(frames.sort((a,b)=>a-b),.95),responseP95:percentile(responses.sort((a,b)=>a-b),.95),frames,responses,longtasks:await cdp.evaluate('__gate.longtasks')};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(out,null,2));console.log(JSON.stringify({frameP95:out.frameP95,responseP95:out.responseP95,longtasks:out.longtasks}));
} finally {cdp?.close();await killTree(child.pid);}
