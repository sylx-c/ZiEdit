import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const types = {'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.json':'application/json','.css':'text/css','.woff2':'font/woff2','.ttf':'font/ttf','.pfb':'application/octet-stream'};
http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 const rel=decodeURIComponent(url.pathname).replace(/^\//,'');
 const file=path.resolve(root, /^(renderers|pdfjs-assets|fonts|font-licenses)\//.test(rel)?'public/'+rel:rel || 'index.html');
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 try{res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);}catch{res.writeHead(404).end();}
}).listen(4182,'127.0.0.1',()=>console.log('Font verification http://127.0.0.1:4182'));
