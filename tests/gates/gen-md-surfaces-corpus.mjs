// 统一 Markdown 阅读/滚动验收：正文、特殊语法、超大单块与模式上限。
import fs from 'node:fs';
import path from 'node:path';
import { RUN_DIR } from './gate-lib.mjs';
const dir = path.resolve(process.argv[2] ?? path.join(RUN_DIR, 'corpus'));
fs.mkdirSync(dir, { recursive:true });
const files = [];
const write = (name, text) => {
  const file = path.join(dir, name + '.md'); fs.writeFileSync(file, text);
  files.push({ file, bytes:Buffer.byteLength(text), lines:text.split('\n').length });
};
const plain = bytes => {
  const blocks = []; let size = 0;
  while (size < bytes) {
    const text = `Paragraph ${blocks.length}: ordinary Markdown reading content, repeated words and 中文正文. ` + 'The layout follows the available width. '.repeat(3) + '\n\n';
    blocks.push(text); size += Buffer.byteLength(text);
  }
  return blocks.join('');
};
for (const [name, bytes] of [['100k',100*1024],['400k',400*1024],['1m',1024*1024],['2m',2*1024*1024-1024],['4m',4*1024*1024-1024]]) write('plain-' + name, plain(bytes));
write('repeated-6001', Array.from({length:6001}, (_,i)=>i===6000?'Last paragraph.':'Repeated paragraph.').join('\n\n'));
write('single-heading-tail', '# Only heading\n\n' + plain(400*1024));
write('metadata', '---\ntitle: Metadata\n---\n\n[toc]\n\n# First\n\nRepeated[^last].\n\n## Second\n\n[ref][site].\n\n' + plain(100*1024) + '\n[site]: https://example.com\n\n[^last]: Footnote at the end.\n');
write('single-code-1m', '```text\n' + 'Code \\* 😀 & < > with long but safe text content.\n'.repeat(22000) + '```\n');
write('single-js-1m', '```javascript\n' + 'const answer = "中文<&😀"; // safe text\n'.repeat(26000) + '```');
write('single-table-400k', '| Index | Value |\n| --- | --- |\n' + Array.from({length:6500},(_,i)=>`| ${i} | table row ${i} ${'wide text '.repeat(4)} |\n`).join(''));
console.log(JSON.stringify(files,null,2));
