#!/usr/bin/env node
/** Record reviewed project-authored artwork sources; no font/icon service is used. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=path.join(root,'compliance/asset-provenance/project-art');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const text=p=>fs.readFileSync(path.join(root,p),'utf8');
const walk=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)]);
const record=p=>{const b=fs.readFileSync(path.join(root,p));return{path:p,bytes:b.length,sha256:digest(b)}};
function snapshot(){
 const chrome=text('src/shell/chrome.ts');
 const iconSource=/export const ICONS = \{[\s\S]*?\} as const;/.exec(chrome)?.[0];
 const brandSource=/export function brandSvg\([^]*?\n\}/.exec(chrome)?.[0];
 if(!iconSource||!brandSource)throw Error('Project SVG source shape changed; review extractor');
 const sources=['src-tauri/icons/icon-master.svg','website/favicon.svg'];
 const icons=walk(path.join(root,'src-tauri/icons')).map(p=>path.relative(root,p).replaceAll('\\','/')).filter(p=>/\.(png|ico|icns|xml)$/.test(p)).sort();
 return{schemaVersion:1,licenseExpression:'MIT (project LICENSE; project-authored source declaration)',projectCopyright:'Copyright (c) 2026 ZiEdit Contributors',scope:'Committed ZiEdit SVG geometry and locally regenerated raster packaging icons. No external font files or paid icon packages are used by these source paths. This records repository source and reproduction, not an independent trademark/ownership legal opinion.',sourceHistory:{packageBrandFirstCommit:'72220ac42ff3037e6de2c019ef8744918319e615',websiteFirstCommit:'631a7ce80129593ad75710c1f7ded700f0c6152d'},generation:{command:'npm exec tauri icon -- src-tauri/icons/icon-master.svg --output docs/tmp/license-icon-regeneration',tool:'tauri-cli 2.12.2',review:'51 of 52 generated files matched pre-existing icon bytes; ICNS container was replaced with this exact regeneration. Source SVG geometry unchanged.'},sourceFiles:sources.map(record),inlineSources:[{path:'src/shell/chrome.ts',symbol:'ICONS',bytes:Buffer.byteLength(iconSource),sha256:digest(iconSource)},{path:'src/shell/chrome.ts',symbol:'brandSvg',bytes:Buffer.byteLength(brandSource),sha256:digest(brandSource)}],generatedFiles:icons.map(record),license:record('LICENSE')};
}
const current=snapshot();
if(process.argv.includes('--record')){fs.mkdirSync(base,{recursive:true});fs.copyFileSync(path.join(root,'LICENSE'),path.join(base,'LICENSE'));fs.copyFileSync(path.join(root,'src-tauri/icons/icon-master.svg'),path.join(base,'icon-master.svg'));fs.copyFileSync(path.join(root,'website/favicon.svg'),path.join(base,'website-favicon.svg'));fs.writeFileSync(path.join(base,'manifest.json'),JSON.stringify(current,null,2)+'\n');}
const saved=JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));
if(JSON.stringify(saved)!==JSON.stringify(current))throw Error('Project SVG/icon provenance changed; review source and regenerate exact icons before recording');
for(const [copy,original]of[['LICENSE','LICENSE'],['icon-master.svg','src-tauri/icons/icon-master.svg'],['website-favicon.svg','website/favicon.svg']])if(!fs.readFileSync(path.join(base,copy)).equals(fs.readFileSync(path.join(root,original))))throw Error('Project art source copy changed: '+copy);
console.log(JSON.stringify({projectArtSources:current.sourceFiles.length+current.inlineSources.length,generatedIcons:current.generatedFiles.length,status:'project source and generated icon hashes verified'}));
