// Record the actual module graph and output bytes of Vite's production build.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function licenseBuildInventory(root){return{name:'license-build-inventory',apply:'build',enforce:'post',generateBundle(_options,bundle){
 const inputs=[];
 for(const id of this.getModuleIds()){
  if(id.startsWith('\0'))continue;
  const file=id.split('?')[0];if(!path.isAbsolute(file)||!fs.existsSync(file)||!fs.statSync(file).isFile())continue;
  const relative=path.relative(root,file).replaceAll('\\','/');
  if(relative.startsWith('../'))throw Error('Build dependency outside reviewed workspace: '+id);
  const data=fs.readFileSync(file),marker=relative.lastIndexOf('node_modules/');
  const rest=marker>=0?relative.slice(marker+'node_modules/'.length).split('/'):[];
  const packageName=rest.length?(rest[0].startsWith('@')?rest.slice(0,2).join('/'):rest[0]):null;
  inputs.push({path:relative,sha256:sha(data),packageName});
 }
 const outputs=Object.entries(bundle).map(([name,item])=>{const data=item.type==='chunk'?Buffer.from(item.code):Buffer.from(item.source);return{path:name,bytes:data.length,sha256:sha(data)}}).sort((a,b)=>a.path.localeCompare(b.path));
 this.emitFile({type:'asset',fileName:'license-build-inputs.json',source:JSON.stringify({schemaVersion:1,method:'Vite main module graph and generated bundle bytes; workers and static vendored resources additionally covered by exact renderer/font evidence.',packageLockSHA256:sha(fs.readFileSync(path.join(root,'package-lock.json'))),inputs:inputs.sort((a,b)=>a.path.localeCompare(b.path)),outputs},null,2)+'\n'});
},writeBundle(options,bundle){
  const outputRoot=path.resolve(root,options.dir??'dist');
  const inventoryPath=path.join(outputRoot,'license-build-inputs.json');
  const inventory=JSON.parse(fs.readFileSync(inventoryPath,'utf8'));
  inventory.outputs=Object.keys(bundle).filter(name=>name!=='license-build-inputs.json').map(name=>{const data=fs.readFileSync(path.join(outputRoot,name));return{path:name,bytes:data.length,sha256:sha(data)}}).sort((a,b)=>a.path.localeCompare(b.path));
  inventory.method='Vite main module graph and actual final written bundle bytes; worker/static payloads additionally covered by exact renderer/font evidence.';
  fs.writeFileSync(inventoryPath,JSON.stringify(inventory,null,2)+'\n');
}};}
