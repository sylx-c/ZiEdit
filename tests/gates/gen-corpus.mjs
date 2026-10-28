// gen-corpus.mjs — 门禁语料生成（密集混合块：公式/表格/列表/围栏/引用/任务）
// 迁移自 docs/tmp/audit-r2/gen-corpus.mjs（只读源）。整备：产物落 RUN_DIR/corpus/（默认
// <repo>/docs/tmp/gates-run/corpus/，不入库——语料体积大，占 docs 体检预算），可用 argv[2] 覆盖输出目录。
// 用法: node tests/gates/gen-corpus.mjs [outDir]
// 产物：dense-2m.md（1.9MiB，ac36/arrow/scroll/phys-ab/walk-f 默认口径，≤2MiB 分屏/IR 准入闸内）、
// dense-9m.md（9MiB 大文档压测）、mixed-100k.md（100KiB 轻量）、note-small.md（小笔记）。
import fs from 'node:fs';
import path from 'node:path';
import { RUN_DIR } from './gate-lib.mjs';
const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(RUN_DIR, 'corpus');
fs.mkdirSync(dir, { recursive: true });

// 密集混合块：约 31 行/块，含 1 块公式 + 2 行内公式，贴近前轮 1.9MiB/82863 行/2673 公式口径
let seq = 0;
function block() {
  const i = seq++;
  return [
    `## 第 ${i} 节 性能与渲染对照`,
    '',
    `这是第 ${i} 段的正文，包含 **粗体 ${i}**、*斜体*、\`inlineCode(${i})\` 与行内公式 $a_{${i}}^2+b^2=c^2$，以及 [链接${i}](#anchor-${i}) 和 \`反引号\` 混排。`,
    '',
    `- 列表项 ${i}.1 含行内公式 $E=mc^2$`,
    `- 列表项 ${i}.2 **加粗** 与 *倾斜* 叠加`,
    `  - 嵌套项 ${i}.2.1 中文与 English 混排`,
    `- [ ] 任务 ${i} 未完成`,
    `- [x] 任务 ${i} 已完成`,
    '',
    '> 引用段落，包含 **强调** 与第二行',
    '> 延续引用 $x_{i}+y_{i}$',
    '',
    '```js',
    `function f${i}(x){ return x * ${i}; } // 代码行含 \`\`\` 之外的符号`,
    `const v${i} = f${i}(${i});`,
    '```',
    '',
    `| 列A${i} | 列B | 列C |`,
    '|---|---|---|',
    `| ${i} | **加粗单元格** | $z_{${i}}$ |`,
    `| 长文本长文本长文本长文本 | ${i * 7} | end |`,
    '',
    '$$',
    `\\int_{0}^{${i}} x^2 \\,dx = \\frac{${i}^3}{3}`,
    '$$',
    '',
    `![图片${i}](images/pic-${i}.png)`,
    '',
    `段落结尾 ${i}，重复文本用于填充体积。重复文本用于填充体积。重复文本用于填充体积。`,
    '',
  ].join('\n');
}

function build(targetBytes, file) {
  let out = '# 密集性能语料\n\n';
  while (Buffer.byteLength(out, 'utf8') < targetBytes) out += block();
  fs.writeFileSync(file, out);
  const lines = out.split('\n').length - 1;
  const math = (out.match(/\$\$/g) || []).length / 2 + (out.match(/\$[a-zA-Z]/g) || []).length;
  return { file, bytes: Buffer.byteLength(out, 'utf8'), lines, blocks: seq, mathApprox: math };
}

const results = [];
seq = 0; results.push(build(1.9 * 1024 * 1024, path.join(dir, 'dense-2m.md')));
seq = 0; results.push(build(9 * 1024 * 1024, path.join(dir, 'dense-9m.md')));
fs.writeFileSync(path.join(dir, 'note-small.md'), '# 日常笔记\n\n今天的事项：\n\n- 买牛奶\n- 写周报\n\n**重要**：周五前提交。\n');
let mixed = '# 100KiB 混合语料\n\n';
seq = 0; while (Buffer.byteLength(mixed, 'utf8') < 100 * 1024) mixed += block();
fs.writeFileSync(path.join(dir, 'mixed-100k.md'), mixed);
results.push({ file: 'mixed-100k.md', bytes: Buffer.byteLength(mixed, 'utf8') });
console.log(JSON.stringify(results, null, 2));
