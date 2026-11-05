// @vitest-environment jsdom
import { beforeAll, afterEach, describe, it, expect, vi } from 'vitest';
import { ChangeSet } from '@codemirror/state';
import { loadMarkdownIt } from '../src/markdown-view/md';
import { MarkdownDocumentSession, blockHtml } from '../src/markdown-view/document-model';
import { MarkdownDocumentClient } from '../src/markdown-view/document-client';
import { createBlockRenderer } from '../src/markdown-view/blockcache';
import { previewScrollToLine, previewTopLine, renderPreviewInto, destroyPreview } from '../src/markdown-view/preview';
import { ReadingSurface, readingSurface } from '../src/markdown-view/reading-surface';
import { Minimap } from '../src/text-view/minimap';
import { SplitScrollCoordinator } from '../src/markdown-view/split-scroll';
import { fillReadingBlock } from '../src/markdown-view/reading-dom';
import type { ScrollSurfaceAdapter } from '../src/common/scroll-surface';

beforeAll(() => loadMarkdownIt());
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('统一阅读正文', () => {
  it('阅读地图为纯图片块保留结构占位', () => {
    const host = document.createElement('div'), root = document.createElement('div'), element = document.createElement('div');
    element.append(document.createElement('img')); root.append(element); host.append(root); document.body.append(host);
    Object.defineProperty(element, 'offsetHeight', { value: 200 });
    const doc = new MarkdownDocumentSession().update('![alt](local.png)');
    const surface = new ReadingSurface(host, root); surface.update([{ block: doc.blocks[0]!, element }], doc.lines);
    expect(surface.overview(1, { version: 1, height: 200, top: 0, viewport: 100 })[0]).toMatchObject({ text: '[image]', kind: 'Image' });
    surface.destroy();
  });
  it('派生内容交付时立即补偿文字位置，不等待下一帧尺寸观察', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const host = document.createElement('div'), root = document.createElement('div'), element = document.createElement('div');
    element.textContent = 'stable reading text'; root.append(element); host.append(root); document.body.append(host);
    Object.defineProperty(host, 'clientHeight', { value: 100 });
    host.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 400, width: 400, height: 100 } as DOMRect);
    root.getBoundingClientRect = host.getBoundingClientRect;
    let top = 120;
    element.getBoundingClientRect = () => ({ top: top - host.scrollTop, bottom: top + 100 - host.scrollTop, height: 100 } as DOMRect);
    Object.defineProperty(element, 'offsetHeight', { value: 100 });
    const doc = new MarkdownDocumentSession().update(element.textContent);
    host.scrollTop = 100;
    const surface = new ReadingSurface(host, root); surface.update([{ block: doc.blocks[0]!, element }], doc.lines);
    top += 40; surface.contentChanged();
    expect(host.scrollTop).toBe(140);
    expect(element.getBoundingClientRect().top).toBe(20);
    surface.destroy();
  });
  it('自然滚动在读取文字锚前展开当前及相邻页，滚远后释放旧页', () => {
    let frame!: FrameRequestCallback;
    vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frame=callback;return 1;});
    vi.stubGlobal('cancelAnimationFrame',()=>{});
    const host=document.createElement('div'),root=document.createElement('div');host.append(root);document.body.append(host);
    Object.defineProperty(host,'clientHeight',{value:100});
    host.getBoundingClientRect=()=>({top:0,bottom:100,left:0,right:400,width:400,height:100} as DOMRect);
    const doc=new MarkdownDocumentSession().update(Array.from({length:8},(_,i)=>'paragraph '+i).join('\n\n'));
    const entries=doc.blocks.map((block,i)=>{
      const page=document.createElement('div'),element=document.createElement('div');
      page.className='md-reading-page';element.textContent=block.src;page.append(element);root.append(page);
      element.style.containIntrinsicSize='auto 100px';
      const rect=()=>({top:i*100-host.scrollTop,bottom:i*100+100-host.scrollTop,height:100} as DOMRect);
      page.getBoundingClientRect=rect;element.getBoundingClientRect=rect;
      return {block,element};
    });
    const surface=new ReadingSurface(host,root);surface.update(entries,doc.lines);
    host.scrollTop=320;host.dispatchEvent(new Event('scroll'));frame(16);
    expect(entries.slice(2,5).every(entry=>entry.element.parentElement!.style.contentVisibility==='visible')).toBe(true);
    host.scrollTop=720;host.dispatchEvent(new Event('scroll'));frame(32);
    expect(entries[2]!.element.parentElement!.style.contentVisibility).toBe('');
    expect(entries[7]!.element.parentElement!.style.contentVisibility).toBe('visible');
    surface.destroy();
  });
  it('引用定义只更新使用该标签的正文，代码括号和直接链接不依赖同名定义', async () => {
    const host=document.createElement('div'),renderer=createBlockRenderer();
    const text='[a]: /a "old"\n[b]: /b\n\n[a]\n\n[b]\n\n`[a]`\n\n[a](/direct)\n\n[new]\n';
    try {
      const first=await renderer.render(host,text,{dark:false});
      const nodes=[...first.col.querySelectorAll('.md-block')],paragraphs=[...first.col.querySelectorAll('p')];
      expect(paragraphs[3]!.querySelector('a')?.hasAttribute('title')).toBe(false);
      const changed=await renderer.render(host,text.replace('/a "old"','/changed "new"'),{dark:false});
      const next=[...changed.col.querySelectorAll('.md-block')];
      expect(changed.col.querySelector('p a')?.getAttribute('href')).toBe('/changed');
      expect(next.slice(3).every((node,index)=>node===nodes[index+3])).toBe(true);
      expect(changed.col.querySelectorAll('p')[1]).toBe(paragraphs[1]);
      expect(changed.col.querySelectorAll('p')[2]).toBe(paragraphs[2]);
      const last=await renderer.render(host,text.replace('/a "old"','/changed "new"')+'\n[new]: /resolved\n',{dark:false});
      expect([...last.col.querySelectorAll('p a')].some(a=>a.getAttribute('href')==='/resolved')).toBe(true);
    } finally { renderer.destroy(); }
  });

  it('脚注正文改变不替换既有引用块，新增前置引用只更新受影响的编号', async () => {
    const renderer=createBlockRenderer(),host=document.createElement('div');
    const text='first[^a]\n\nsecond[^b]\n\nunchanged\n\n[^a]: body a\n\n[^b]: body b\n';
    try {
      const first=await renderer.render(host,text,{dark:false}),firstRef=first.col.querySelector('.footnotes-ref')?.closest('.md-block');
      const second=await renderer.render(host,text.replace('body b','new body b'),{dark:false});
      expect(second.col.querySelector('.footnotes-ref')?.closest('.md-block')).toBe(firstRef);
      expect(second.col.querySelector('.footnotes-defs-ol')?.textContent).toContain('new body b');
      const reordered=await renderer.render(host,text.replace('[^a]: body a\n\n[^b]: body b','[^b]: body b\n\n[^a]: body a'),{dark:false});
      const definitions=[...reordered.col.querySelectorAll('.footnotes-defs-ol>li')];
      expect(definitions[0]?.textContent).toContain('body a');
      expect(definitions[1]?.textContent).toContain('body b');
      const plan=new MarkdownDocumentSession().update(text);
      expect(plan.blocks.find(block=>block.src==='first[^a]')?.dependencies?.[0]).toMatch(/^footnote:A:/);
    } finally { renderer.destroy(); }
  });
  it('尺寸交付校正锚点时不在观察器内展开相邻离屏页', () => {
    let resized!: ResizeObserverCallback;
    class Observer { constructor(callback:ResizeObserverCallback){resized=callback;} observe():void{} unobserve():void{} disconnect():void{} }
    vi.stubGlobal('ResizeObserver',Observer);
    const host=document.createElement('div'),root=document.createElement('div');host.append(root);document.body.append(host);
    const doc=new MarkdownDocumentSession().update('one\n\ntwo\n\nthree');
    const entries=doc.blocks.map(block=>{
      const page=document.createElement('div'),element=document.createElement('div');
      page.className='md-reading-page';page.append(element);root.append(page);
      return {element,block};
    });
    const surface=new ReadingSurface(host,root);surface.update(entries,doc.lines);
    resized([{target:root,borderBoxSize:[{blockSize:60}],contentRect:{height:60,width:300}}] as unknown as ResizeObserverEntry[],{} as ResizeObserver);
    expect([...root.children].every(page=>(page as HTMLElement).style.contentVisibility==='')).toBe(true);
    surface.restore({line:3,surface:'source'});
    expect(entries[1]!.element.parentElement!.style.contentVisibility).toBe('visible');
    surface.destroy();
  });
  it('重建预览时按块内比例等待目标水合，用户输入取消未完成的恢复', () => {
    let resized!: ResizeObserverCallback;
    class Observer { constructor(callback:ResizeObserverCallback){resized=callback;} observe():void{} unobserve():void{} disconnect():void{} }
    vi.stubGlobal('ResizeObserver',Observer);
    const host=document.createElement('div'),root=document.createElement('div'),element=document.createElement('div');
    element.innerHTML='<span class="md-render-target"><code>formula</code></span>';root.append(element);host.append(root);document.body.append(host);
    Object.defineProperty(host,'clientHeight',{value:200});let height=40;
    host.getBoundingClientRect=()=>({top:0,left:0,right:400,bottom:200,width:400,height:200} as DOMRect);
    element.getBoundingClientRect=()=>({top:20-host.scrollTop,height} as DOMRect);
    const doc=new MarkdownDocumentSession().update('first\ncontinued\n\nsecond'),surface=new ReadingSurface(host,root);
    surface.update([{element,block:doc.blocks[0]!}],doc.lines);
    surface.restore({line:1.5,surface:'preview',blockId:doc.blocks[0]!.id,offset:25,blockHeight:100});
    expect(host.scrollTop).toBe(30);expect(surface.capture().line).toBe(1.5);
    height=100;element.firstElementChild!.setAttribute('data-render-done','1');
    resized([{target:element,borderBoxSize:[{blockSize:100}],contentRect:{height:100}}] as unknown as ResizeObserverEntry[],{} as ResizeObserver);
    expect(host.scrollTop).toBe(45);expect(surface.capture().line).toBe(1.5);
    host.dispatchEvent(new WheelEvent('wheel'));height=300;
    resized([{target:element,borderBoxSize:[{blockSize:300}],contentRect:{height:300}}] as unknown as ResizeObserverEntry[],{} as ResizeObserver);
    expect(host.scrollTop).toBe(45);surface.destroy();
  });
  it('快跳先展开目标组，用真实块坐标恢复，不把离屏占位比例当成当前排版', () => {
    const host=document.createElement('div'),root=document.createElement('div');host.append(root);document.body.append(host);
    Object.defineProperty(host,'clientHeight',{value:200});
    host.getBoundingClientRect=()=>({top:0,bottom:200,left:0,right:400,width:400,height:200} as DOMRect);
    const doc=new MarkdownDocumentSession().update('one\n\ntwo\ncontinued\n\nlast');
    const entries=doc.blocks.map((block,index)=>{
      const page=document.createElement('div');page.className='md-reading-page';root.append(page);
      page.getBoundingClientRect=()=>({top:index*200-host.scrollTop,bottom:index*200+200-host.scrollTop,height:200} as DOMRect);
      const element=document.createElement('div');page.append(element);element.style.containIntrinsicSize='auto 20px';
      element.getBoundingClientRect=()=>({top:index*200+20-host.scrollTop,height:100} as DOMRect);
      return {block,element};
    });
    const surface=new ReadingSurface(host,root);surface.update(entries,doc.lines);
    surface.restore({line:3.5,surface:'source'});
    expect(host.scrollTop).toBe(245);
    expect(surface.capture().line).toBe(3.5);expect(surface.capture().blockId).toBe(entries[1]!.block.id);
    expect(entries[1]!.element.parentElement!.style.contentVisibility).toBe('visible');
    surface.destroy();expect(entries[1]!.element.parentElement!.style.contentVisibility).toBe('');
  });
  it('离屏组的浏览器占位高度与块索引一致，尺寸交付后保持同一阅读块', () => {
    let resized!: ResizeObserverCallback;
    class Observer {
      constructor(callback: ResizeObserverCallback) { resized=callback; }
      observe(): void {} unobserve(): void {} disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver',Observer);
    const host=document.createElement('div'),root=document.createElement('div');host.append(root);document.body.append(host);
    const doc=new MarkdownDocumentSession().update('one\n\ntwo\n\nthree\n\nfour');
    const entries=doc.blocks.map(block=>({block,element:document.createElement('div')}));
    for(let i=0;i<2;i++){
      const page=document.createElement('div');page.className='md-reading-page';root.append(page);
      page.getBoundingClientRect=()=>({height:i===0?100:200} as DOMRect);
      for(const entry of entries.slice(i*2,i*2+2)){
        entry.element.style.containIntrinsicSize='auto 20px';
        Object.defineProperty(entry.element,'offsetHeight',{get(){throw new Error('forced offscreen block layout');}});page.append(entry.element);
      }
    }
    const surface=new ReadingSurface(host,root);surface.update(entries,doc.lines);
    surface.restore({line:5,surface:'source'});expect(host.scrollTop).toBe(100);
    expect(surface.capture().blockId).toBe(entries[2]!.block.id);
    resized([{target:root.firstElementChild,borderBoxSize:[{blockSize:300}],contentRect:{height:300}}] as unknown as ResizeObserverEntry[],{} as ResizeObserver);
    expect(host.scrollTop).toBe(300);expect(surface.capture().blockId).toBe(entries[2]!.block.id);
    surface.scrollTo(400);expect(surface.capture().blockId).toBe(entries[3]!.block.id);
    surface.destroy();
  });
  it('恢复到标题边距时，前块的命中结果不能接走恢复目标', () => {
    let frame!: FrameRequestCallback;
    vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frame=callback;return 1;});
    vi.stubGlobal('cancelAnimationFrame',()=>{});
    let resized!: ResizeObserverCallback;
    class Observer { constructor(callback: ResizeObserverCallback) { resized=callback; } observe():void{} unobserve():void{} disconnect():void{} }
    vi.stubGlobal('ResizeObserver',Observer);
    const host=document.createElement('div'),root=document.createElement('div'); host.append(root);document.body.append(host);
    Object.defineProperty(host,'clientHeight',{value:200});
    host.getBoundingClientRect=()=>({top:0,bottom:200,height:200,left:0,right:400,width:400} as DOMRect);
    const doc=new MarkdownDocumentSession().update('previous\n\n# Heading');let growth=0;
    const entries=doc.blocks.map((block,i)=>{
      const element=document.createElement('div');element.innerHTML=i?'<h1>Heading</h1>':'<p>previous</p>';root.append(element);
      const height=i?80:100;
      Object.defineProperty(element,'offsetHeight',{get:()=>height+(i?0:growth)});
      element.getBoundingClientRect=()=>({top:(i?100+growth:0)-host.scrollTop,bottom:(i?180+growth:100+growth)-host.scrollTop,height:height+(i?0:growth)} as DOMRect);
      return {block,element};
    });
    Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>entries[0]!.element.firstElementChild});
    const surface=new ReadingSurface(host,root);surface.update(entries,doc.lines);surface.restore({line:3,surface:'source'});
    expect(host.scrollTop).toBe(100);
    host.dispatchEvent(new Event('scroll'));growth=50;
    // 程序回声先于尺寸观察交付，不能把已移动 50px 的正文当成新的阅读基线。
    frame(16);
    resized([{target:entries[0]!.element,borderBoxSize:[{blockSize:150}],contentRect:{height:150}}] as unknown as ResizeObserverEntry[],{} as ResizeObserver);
    expect(host.scrollTop).toBe(150);expect(entries[1]!.element.getBoundingClientRect().top).toBe(0);
    surface.destroy();Reflect.deleteProperty(document,'elementFromPoint');
  });
  it('图片改变同一块内部高度时保持可见文字，新用户输入立即取消旧锚', () => {
    let resized!: ResizeObserverCallback;
    class Observer { constructor(callback:ResizeObserverCallback){resized=callback;} observe():void{} unobserve():void{} disconnect():void{} }
    vi.stubGlobal('ResizeObserver',Observer);
    const host=document.createElement('div'),root=document.createElement('div'),block=document.createElement('div'),paragraph=document.createElement('p');
    root.append(block);block.append(paragraph);host.append(root);document.body.append(host);
    Object.defineProperty(host,'clientHeight',{value:200});let growth=0;
    paragraph.getBoundingClientRect=()=>({top:40+growth-host.scrollTop} as DOMRect);
    Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>paragraph});
    const surface=new ReadingSurface(host,root),doc=new MarkdownDocumentSession().update('paragraph');
    surface.update([{element:block,block:doc.blocks[0]!}],doc.lines);surface.scrollTo(0);
    // 浏览器已在布局阶段补偿的位移不能再叠加一次；未补偿的后续尺寸仍要处理。
    growth=120;host.scrollTop=120;
    resized([{target:block,borderBoxSize:[{blockSize:180}],contentRect:{height:180}}] as unknown as ResizeObserverEntry[],{} as ResizeObserver);
    expect(host.scrollTop).toBe(120);expect(paragraph.getBoundingClientRect().top).toBe(40);
    growth=240;
    resized([{target:block,borderBoxSize:[{blockSize:300}],contentRect:{height:300}}] as unknown as ResizeObserverEntry[],{} as ResizeObserver);
    expect(host.scrollTop).toBe(240);expect(paragraph.getBoundingClientRect().top).toBe(40);
    host.dispatchEvent(new WheelEvent('wheel'));growth=260;
    resized([{target:block,borderBoxSize:[{blockSize:320}],contentRect:{height:320}}] as unknown as ResizeObserverEntry[],{} as ResizeObserver);
    expect(host.scrollTop).toBe(240);surface.destroy();Reflect.deleteProperty(document,'elementFromPoint');
  });
  it('图片 load 在尺寸观察交付前通知唯一锚管理器，用户输入与销毁取消旧锚', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const host=document.createElement('div'),root=document.createElement('div'),block=document.createElement('div');
    const image=document.createElement('img'),paragraph=document.createElement('p');
    root.append(block);block.append(image,paragraph);host.append(root);document.body.append(host);
    Object.defineProperty(host,'clientHeight',{value:200});let growth=0;
    paragraph.getBoundingClientRect=()=>({top:40+growth-host.scrollTop} as DOMRect);
    Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>paragraph});
    const surface=new ReadingSurface(host,root),doc=new MarkdownDocumentSession().update('paragraph');
    try {
      surface.update([{element:block,block:doc.blocks[0]!}],doc.lines);surface.scrollTo(0);
      growth=240;image.dispatchEvent(new Event('load'));
      expect(host.scrollTop).toBe(240);expect(paragraph.getBoundingClientRect().top).toBe(40);
      host.dispatchEvent(new WheelEvent('wheel'));growth=300;image.dispatchEvent(new Event('load'));
      expect(host.scrollTop).toBe(240);
      surface.destroy();growth=360;image.dispatchEvent(new Event('load'));
      expect(host.scrollTop).toBe(240);
    } finally { surface.destroy();Reflect.deleteProperty(document,'elementFromPoint'); }
  });
  it('图片固有尺寸先于 load 和尺寸观察交付时，在绘制前保持最新阅读锚', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const frames=new Map<number,FrameRequestCallback>();let serial=0;
    vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++serial,callback);return serial;});
    vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
    const frame=()=>{const batch=[...frames];frames.clear();for(const [,callback] of batch)callback(0);};
    const host=document.createElement('div'),root=document.createElement('div'),block=document.createElement('div'),paragraph=document.createElement('p');
    root.append(block);block.append(paragraph);host.append(root);document.body.append(host);
    Object.defineProperty(host,'clientHeight',{value:200});let growth=0,complete=false;
    paragraph.getBoundingClientRect=()=>({top:40+growth-host.scrollTop} as DOMRect);
    Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>paragraph});
    const surface=new ReadingSurface(host,root),doc=new MarkdownDocumentSession().update('paragraph');
    try {
      surface.update([{element:block,block:doc.blocks[0]!}],doc.lines);surface.scrollTo(0);frame();
      const image=document.createElement('img');Object.defineProperty(image,'complete',{get:()=>complete});
      block.prepend(image);image.src='pending.png';await Promise.resolve();
      growth=240;frame(); // 浏览器已解出尺寸，load/RO 尚未送达。
      expect(host.scrollTop).toBe(240);expect(paragraph.getBoundingClientRect().top).toBe(40);
      host.dispatchEvent(new WheelEvent('wheel'));growth=300;frame();
      expect(host.scrollTop).toBe(240); // 新输入取消旧基线。
      host.scrollTop=260;host.dispatchEvent(new Event('scroll'));frame();
      growth=340;frame();expect(host.scrollTop).toBe(300); // 新滚动建立的新基线仍受保护。
      complete=true;image.dispatchEvent(new Event('load'));frame();frame();frame();
      expect(frames.size).toBe(0); // 完成后不保留逐帧轮询。
      image.src='later.png';await Promise.resolve();surface.destroy();growth=400;frame();
      expect(host.scrollTop).toBe(300);expect(frames.size).toBe(0);
    } finally { surface.destroy();Reflect.deleteProperty(document,'elementFromPoint'); }
  });
  it('Worker 元数据请求不清除阅读缓存，迟到的无主结果不能改缓存', async () => {
    let worker!: FakeWorker;
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      session = new MarkdownDocumentSession();
      html = new Set<string>();
      constructor() { worker=this; }
      terminate(): void {}
      postMessage(request: {version:number;metadataOnly:boolean;text?:string}): void {
        const doc=this.session.update(request.text ?? 'paragraph');
        const blocks=request.metadataOnly?[]:doc.blocks.map(block=>{
          const html=this.html.has(block.id)?undefined:blockHtml(doc,block);this.html.add(block.id);return {...block,html};
        });
        queueMicrotask(()=>this.onmessage?.({data:{version:request.version,blocks,metadata:doc.metadata,lines:doc.lines}} as MessageEvent));
      }
    }
    vi.stubGlobal('Worker',FakeWorker);
    const client=new MarkdownDocumentClient(), first=await client.render('paragraph');
    const id=first.blocks[0]!.id, html=client.html.get(id);
    expect(html).toContain('paragraph');
    await client.render('paragraph',true);
    expect(client.html.get(id)).toBe(html);
    const next=await client.render('paragraph');
    expect(next.blocks[0]!.html).toBeUndefined();expect(client.html.get(id)).toBe(html);
    worker.onmessage?.({data:{version:0,blocks:[{id:'late',html:'late'}]}} as MessageEvent);
    expect(client.html.has('late')).toBe(false);client.destroy();
  });
  it('页面按需连接两个后台 Worker，销毁终止两者，迟到连接请求不重建', async () => {
    const workers: ChannelWorker[] = [];
    class ChannelWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      stopped = false;
      messages: unknown[] = [];
      constructor() { workers.push(this); }
      terminate(): void { this.stopped = true; }
      postMessage(request: { version?: number; text?: string; port?: unknown; codePort?: unknown }, transfer?: unknown[]): void {
        this.messages.push({ request, transfer });
        if (!request.version) return;
        const doc = new MarkdownDocumentSession().update(request.text!);
        queueMicrotask(() => this.onmessage?.({ data: { version: request.version, blocks: doc.blocks,
          metadata: doc.metadata, lines: doc.lines } } as MessageEvent));
      }
    }
    const port1 = {}, port2 = {};
    vi.stubGlobal('Worker', ChannelWorker);
    vi.stubGlobal('MessageChannel', class { port1 = port1; port2 = port2; });
    const client = new MarkdownDocumentClient();
    await client.render('ordinary paragraph');
    expect(workers).toHaveLength(1);
    workers[0]!.onmessage?.({ data: { codePortRequested: true } } as MessageEvent);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.messages).toEqual([{ request: { port: port1 }, transfer: [port1] }]);
    expect(workers[0]!.messages.at(-1)).toEqual({ request: { codePort: port2 }, transfer: [port2] });
    client.destroy();
    expect(workers.every(worker => worker.stopped)).toBe(true);
    workers[0]!.onmessage?.({ data: { codePortRequested: true } } as MessageEvent);
    expect(workers).toHaveLength(2);
  });
  it('后续 HTML 尚未交付时先显示首批正文，交付后保留已显示节点', async () => {
    let finish!: () => void;
    class StreamingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      terminate(): void {}
      postMessage(request: { version: number; text: string }): void {
        const doc = new MarkdownDocumentSession().update(request.text);
        const blocks = doc.blocks.map((block, index) => ({ ...block,
          html: index === 0 ? blockHtml(doc, block) : undefined, htmlPending: index > 0 }));
        finish = () => this.onmessage?.({ data: { version: request.version,
          htmlChunk: doc.blocks.slice(1).map(block => ({ id: block.id, html: blockHtml(doc, block) })), complete: true } } as MessageEvent);
        queueMicrotask(() => this.onmessage?.({ data: { version: request.version, blocks,
          metadata: doc.metadata, lines: doc.lines, streaming: true } } as MessageEvent));
      }
    }
    vi.stubGlobal('Worker', StreamingWorker);
    const host = document.createElement('div'); document.body.append(host);
    const renderer = createBlockRenderer();
    const rendering = renderer.render(host, 'first paragraph\n\nlast paragraph', { dark: false });
    await vi.waitFor(() => expect(host.querySelector('p')?.textContent).toBe('first paragraph'));
    const first = host.querySelector('p');
    expect(host.textContent).not.toContain('last paragraph');
    expect(host.querySelector('.md-col')?.getAttribute('data-render-complete')).toBe('0');
    finish(); await rendering;
    expect(host.querySelector('p')).toBe(first);
    expect(host.textContent).toContain('last paragraph');
    expect(host.querySelector('.md-col')?.getAttribute('data-render-complete')).toBe('1');
    renderer.destroy();
  });
  it('并发请求按快照顺序应用增量，降级后保留重复段落身份', async () => {
    const client = new MarkdownDocumentClient();
    const text = 'same\n\nsame\n\ntail';
    const first = client.render(text);
    client.noteChanges(ChangeSet.of({ from:0, insert:'same\n\n' }, text.length));
    const second = client.render('same\n\n' + text);
    client.noteChanges(ChangeSet.of({ from:text.length + 6, insert:'!' }, text.length + 6));
    const third = client.render('same\n\n' + text + '!');
    const [a,b,c] = await Promise.all([first,second,third]);
    expect(b.blocks.slice(1).map(block => block.id)).toEqual(a.blocks.map(block => block.id));
    expect(c.blocks.slice(0,-1).map(block => block.id)).toEqual(b.blocks.slice(0,-1).map(block => block.id));
    expect(c.blocks[c.blocks.length-1]!.src).toBe('tail!');
    expect([...client.html.keys()].sort()).toEqual(c.blocks.map(block=>block.id).sort());
    client.destroy();
    await expect(client.render('closed')).rejects.toThrow('closed');
  });
  it.each(['error', 'destroy'])('流式首批交付后 %s 会结束等待，迟到 HTML 不回填缓存', async action => {
    let worker!: StreamingWorker;
    class StreamingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      version = 0;
      constructor() { worker = this; }
      terminate(): void {}
      postMessage(request: { version: number; text: string }): void {
        this.version = request.version;
        const doc = new MarkdownDocumentSession().update(request.text);
        queueMicrotask(() => this.onmessage?.({ data: { version: request.version, blocks: doc.blocks.map(block => ({ ...block, htmlPending: true })),
          metadata: doc.metadata, lines: doc.lines, streaming: true } } as MessageEvent));
      }
    }
    vi.stubGlobal('Worker', StreamingWorker);
    const client = new MarkdownDocumentClient(), plan = await client.render('paragraph');
    const failed = expect(plan.htmlReady).rejects.toThrow('unavailable');
    if (action === 'destroy') client.destroy(); else worker.onerror?.();
    await failed;
    worker.onmessage?.({ data: { version: worker.version, htmlChunk: [{ id: 'late', html: 'late' }], complete: true } } as MessageEvent);
    expect(client.html.has('late')).toBe(false);
    if (action === 'error') {
      const fallback = await client.render('paragraph updated');
      expect(fallback.blocks[0]?.html).toContain('paragraph updated');
    }
    client.destroy();
  });
  it('超大代码与表格分片保持实体、反斜杠和 Unicode，仍可全文选择', async () => {
    const root = document.createElement('div');
    const text = ('\\* 😀 & < > "\n').repeat(10000);
    const html = '<pre><code><span class="hljs-keyword">' + text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!) + '</span></code></pre>'
      + '<table><tbody>' + '<tr><td>&amp; 😀</td><td>\\*</td></tr>'.repeat(3000) + '</tbody></table>';
    await fillReadingBlock(root, html, () => true);
    expect(root.querySelector('code')?.textContent).toBe(text);
    const codeChunks = [...root.querySelectorAll('.md-code-chunk')];
    expect(codeChunks.length).toBeGreaterThan(1);
    expect(codeChunks.every(chunk => chunk.querySelector('.hljs-keyword'))).toBe(true);
    expect(root.querySelectorAll('tr')).toHaveLength(3000);
    expect([...root.querySelectorAll('.md-table-chunk')].every(chunk => chunk.children.length <= 64)).toBe(true);
    expect(root.querySelectorAll('.md-table-chunk').length).toBeGreaterThan(1);
    expect(root.querySelector('td')?.textContent).toBe('& 😀');
    expect(root.querySelectorAll('td')[1]?.textContent).toBe('\\*');
  });
  it('6000 块文档末尾改单字符，根与全部未变块保持身份', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const renderer = createBlockRenderer();
    const text = Array.from({ length: 6000 }, (_, i) => `paragraph ${i}`).join('\n\n');
    const first = await renderer.render(host, text, { dark: false });
    const nodes = [...first.col.querySelectorAll('.md-block')];
    const second = await renderer.render(host, text + '!', { dark: false });
    expect(second.col).toBe(first.col);
    const next = [...second.col.querySelectorAll('.md-block')];
    expect(next).toHaveLength(6000);
    expect(next.slice(0, -1).every((node, index) => node === nodes[index])).toBe(true);
    expect(next[5999]).not.toBe(nodes[5999]);
    const changed:MutationRecord[]=[];
    const observer=new MutationObserver(records=>changed.push(...records));observer.observe(second.col,{childList:true,subtree:true});
    const third=await renderer.render(host,'!' + text + '!',{dark:false});
    changed.push(...observer.takeRecords());observer.disconnect();
    const latest=[...third.col.querySelectorAll('.md-block')];
    expect(latest.slice(1).every((node,index)=>node===next[index+1])).toBe(true);
    expect(changed.flatMap(record=>[...record.removedNodes])).toContain(next[0]);
    expect(changed.flatMap(record=>[...record.removedNodes]).filter(node=>next.slice(1).includes(node as Element))).toHaveLength(0);
    renderer.destroy();
  }, 20000);

  it('Front Matter、目录、脚注保持分块和未变正文，目录不随无关输入重建', async () => {
    const host = document.createElement('div'), renderer = createBlockRenderer();
    const text = '---\ntitle: test\n---\n\n[toc]\n\n# Heading\n\nbody[^x]\n\nkeep\n\n[^x]: note\n';
    const first = await renderer.render(host, text, { dark: false });
    const keep = [...host.querySelectorAll('p')].find(p => p.textContent === 'keep');
    const toc = host.querySelector('.md-toc'), front = host.querySelector('.md-frontmatter');
    await renderer.render(host, text + '\nmore', { dark: false });
    expect(host.firstElementChild).toBe(first.col);
    expect([...host.querySelectorAll('p')].find(p => p.textContent === 'keep')).toBe(keep);
    expect(host.querySelector('.md-toc')).toBe(toc);
    expect(host.querySelector('.md-frontmatter')).toBe(front);
    expect(host.querySelectorAll('.footnotes-defs-ol')).toHaveLength(1);
    renderer.destroy();
  });

  it('显式增量在重复段落前插入同文段落，原来的每个块保留身份', () => {
    const session = new MarkdownDocumentSession(), text = 'same\n\nsame\n\ntail';
    const first = session.update(text);
    const second = session.update('same\n\n' + text, [{ from: 0, to: 0, insert: 'same\n\n' }]);
    expect(second.blocks.slice(1).map(block => block.id)).toEqual(first.blocks.map(block => block.id));
    expect(new Set(second.blocks.map(block => block.id)).size).toBe(4);
  });

  it('脚注显示编号与源码次序不同时，独立定位定义及定义之间的正文', async () => {
    const host=document.createElement('div');document.body.append(host);
    const renderer=createBlockRenderer();
    const text='intro[^b] [^a]\n\n[^a]: A\n\nmiddle\n\n[^b]: B\n\ntail';
    await renderer.render(host,text,{dark:false});
    const blocks=[...host.querySelector('.md-col')!.children].filter(e=>!(e as HTMLElement).hidden) as HTMLElement[];
    blocks.forEach((element,index)=>Object.defineProperties(element,{offsetTop:{get:()=>index*100},offsetHeight:{value:100},getBoundingClientRect:{value:()=>({top:index*100})}}));
    const a=host.querySelector<HTMLElement>('#footnotes-def-2')!, b=host.querySelector<HTMLElement>('#footnotes-def-1')!;
    for(const [element,top] of [[a,360],[b,310]] as const)Object.defineProperties(element,{offsetHeight:{value:40},getBoundingClientRect:{value:()=>({top})}});
    const surface=readingSurface(host)!;surface.measure();
    surface.restore({line:5,surface:'source'});expect(host.scrollTop).toBe(100);
    surface.restore({line:3,surface:'source'});expect(host.scrollTop).toBe(360);expect(surface.capture().line).toBe(3);
    surface.restore({line:7,surface:'source'});expect(host.scrollTop).toBe(310);expect(surface.capture().line).toBe(7);
    const footer=host.querySelector('.footnotes-defs-ol');
    await renderer.render(host,text.replace('middle','middle changed'),{dark:false});
    expect(host.querySelector('.footnotes-defs-ol')).toBe(footer);
    renderer.destroy();
  });

  it('真实生产正文提供无标题定位、块内插值及完整的文末边界', async () => {
    const host = document.createElement('div'); document.body.append(host);
    await renderPreviewInto(host, 'first\nline\n\nsecond\nline\n\nlast', { dark: false });
    const root = host.firstElementChild!, blocks = [...root.children] as HTMLElement[];
    Object.defineProperties(host, { clientHeight: { value: 80 }, scrollHeight: { value: 600 } });
    blocks.forEach((element, index) => Object.defineProperties(element, {
      offsetTop: { get: () => index * 200 }, offsetHeight: { value: 200 },
    }));
    readingSurface(host)!.measure();
    expect(previewScrollToLine(host, 4)).toBe(true); expect(host.scrollTop).toBe(200);
    host.scrollTop = 250; expect(previewTopLine(host)).toBe(4.5);
    expect(previewScrollToLine(host, 7)).toBe(true); expect(host.scrollTop).toBe(400);
    destroyPreview(host);
  });

  it('主题改变、图片晚到、旧版本晚到不会覆盖新的正文', async () => {
    let release!: (value: string) => void;
    const renderer = createBlockRenderer(text => text === 'old' ? new Promise(resolve => { release = resolve; }) : Promise.resolve('<p>' + text + '</p>'));
    const host = document.createElement('div');
    const old = renderer.render(host, 'old', { dark: false });
    await renderer.render(host, 'new', { dark: true });
    release('<p>late</p>');
    expect((await old).committed).toBe(false); expect(host.textContent).toBe('new');
    renderer.destroy();
  });

  it('合并后的增量保持列表、表格与 Setext 语义和重新解析一致', () => {
    const session = new MarkdownDocumentSession();
    for (const text of ['title\n\nbody', 'title\n---\n\nbody', 'title\n---\n\n| a |\n| - |\n| b |', '- one\n\n  nested\n\nend', '- one\n  - nested\n\nend']) {
      const incremental = session.update(text), fresh = new MarkdownDocumentSession().update(text);
      expect(incremental.blocks.map(block => blockHtml(incremental, block)).join('')).toBe(fresh.blocks.map(block => blockHtml(fresh, block)).join(''));
    }
  });

  it('渲染地图使用同一布局快照，与滑块同位置、同高度，点击不经过源码行数', async () => {
    const host = document.createElement('div'), rail = document.createElement('div'), renderer = createBlockRenderer();
    document.body.append(host, rail);
    await renderer.render(host, '# one\n\ntwo', { dark: false });
    Object.defineProperties(host, { clientHeight: { value: 100 }, scrollHeight: { value: 1000 } });
    const surface = readingSurface(host)!;
    [...host.querySelectorAll<HTMLElement>('.md-block')].forEach(element => Object.defineProperty(element, 'offsetHeight', { value: 500 }));
    surface.measure();
    const mm = new Minimap(rail, { surface, scrollTop: () => host.scrollTop, scrollHeight: () => 1000, clientHeight: () => 100,
      scrollTo: top => surface.scrollTo(top), totalLines: () => 999999, lineText: () => { throw new Error('source sampler used'); } });
    Object.defineProperty(mm.root, 'clientHeight', { value: 400 });
    host.scrollTop = 450; mm.sync();
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(rail.querySelector('.mm-bars')!, { subtree: true, childList: true, attributes: true });
    // 排版版本改变但采样内容相同，不应重建每一根结构条纹。
    surface.measure(); mm.sync();
    const overview = surface.overview.bind(surface);
    vi.spyOn(surface, 'overview').mockImplementation((count, layout) => overview(count, layout)
      .map(sample => ({ ...sample, text: sample.text.replace(/[a-z]/g, 'z') })));
    // 样本文字改变，形状与类别不变，仍无需替换色段节点。
    surface.measure(); mm.sync();
    mutations.push(...observer.takeRecords()); observer.disconnect();
    expect(mutations).toHaveLength(0);
    const thumb = rail.querySelector<HTMLElement>('.vs-thumb')!, viewport = rail.querySelector<HTMLElement>('.mm-viewport')!;
    expect(viewport.style.top).toBe(thumb.style.top); expect(viewport.style.height).toBe(thumb.style.height);
    mm.root.getBoundingClientRect = () => ({ top: 0, height: 400 } as DOMRect);
    mm.root.dispatchEvent(new MouseEvent('mousedown', { clientY: 29 + (400 - 29 - 10) / 2 }));
    expect(host.scrollTop).toBe(450);
    mm.remove(); renderer.destroy();
  });

  it('组件接收编辑器 ChangeSet，重复段落插入后真实 DOM 保留', async () => {
    const renderer = createBlockRenderer(), host = document.createElement('div');
    const text = 'same\n\nsame\n\ntail';
    await renderer.render(host, text, { dark: false });
    const nodes = [...host.querySelectorAll('p')];
    renderer.noteChanges(ChangeSet.of({ from: 0, insert: 'same\n\n' }, text.length));
    await renderer.render(host, 'same\n\n' + text, { dark: false });
    expect([...host.querySelectorAll('p')].slice(1)).toEqual(nodes);
    renderer.destroy();
  });
});

it('分屏每帧跟随最新意图，识别回声并允许立即反向接管', () => {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  let left = 0, right = 0, writes = 0;
  const surface = (side: 'left' | 'right'): ScrollSurfaceAdapter => ({
    element: document.createElement('div'), snapshot: () => ({ top: side === 'left' ? left : right, height: 1000, viewport: 100, version: 1 }),
    capture: () => ({ line: side === 'left' ? left : right, surface: 'source' }),
    restore: anchor => { writes++; if (side === 'left') left = anchor.line; else right = anchor.line; },
    scrollTo: () => {}, overview: () => [],
  });
  const surfaces = { left: surface('left'), right: surface('right') };
  const sync = new SplitScrollCoordinator(side => surfaces[side]);
  try {
    for (left of [10, 20, 30]) sync.scrolled('left');
    frame!(0); expect(right).toBe(30); expect(writes).toBe(1);
    sync.scrolled('right'); expect(writes).toBe(1);
    sync.claim('right'); right = 45; sync.scrolled('right'); frame!(16);
    expect(left).toBe(45); expect(writes).toBe(2);
    for (let i = 0; i < 20; i++) { right++; sync.scrolled('right'); frame!(32 + i * 16); }
    expect(left).toBe(right); expect(writes).toBe(22);
  } finally { sync.destroy(); vi.unstubAllGlobals(); }
});
