// gen-39.mjs — 3.9MiB 密集语料生成（ac36 深压测口径：每事务分段 + fullRebuild 观察）
// 迁移自 docs/tmp/audit-r2/gen-39.mjs（只读源）。整备：产物落 RUN_DIR/corpus/dense-39.md（不入库）。
// 注意：3.9MiB 超 walk-f 的 2MiB 分屏/IR 准入闸——该语料只用于 ac36/arrow/scroll/phys-ab。
// 用法: node tests/gates/gen-39.mjs
import fs from 'node:fs';
import path from 'node:path';
import { RUN_DIR } from './gate-lib.mjs';
let seq = 0;
const block = () => {
  const i = seq++;
  return [
    `## 第 ${i} 节 性能与渲染对照`, '',
    `这是第 ${i} 段的正文，包含 **粗体 ${i}**、*斜体*、\`inlineCode(${i})\` 与行内公式 $a_{${i}}^2+b^2=c^2$，以及 [链接${i}](#anchor-${i}) 和 \`反引号\` 混排。`, '',
    `- 列表项 ${i}.1 含行内公式 $E=mc^2$`, `- 列表项 ${i}.2 **加粗** 与 *倾斜* 叠加`, `  - 嵌套项 ${i}.2.1 中文与 English 混排`,
    `- [ ] 任务 ${i} 未完成`, `- [x] 任务 ${i} 已完成`, '',
    '> 引用段落，包含 **强调** 与第二行', `> 延续引用 $x_{i}+y_{i}$`, '',
    '```js', `function f${i}(x){ return x * ${i}; } // 代码行`, `const v${i} = f${i}(${i});`, '```', '',
    `| 列A${i} | 列B | 列C |`, '|---|---|---|', `| ${i} | **加粗单元格** | $z_{${i}}$ |`, `| 长文本长文本长文本长文本 | ${i * 7} | end |`, '',
    '$$', `\\int_{0}^{${i}} x^2 \\,dx = \\frac{${i}^3}{3}`, '$$', '',
    `![图片${i}](images/pic-${i}.png)`, '',
    `段落结尾 ${i}，重复文本用于填充体积。重复文本用于填充体积。重复文本用于填充体积。`, '',
  ].join('\n') + '\n';
};
let out = '# 密集性能语料\n\n';
const target = 3.9 * 1024 * 1024;
while (Buffer.byteLength(out, 'utf8') < target) out += block();
const file = path.join(RUN_DIR, 'corpus', 'dense-39.md');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, out);
console.log(JSON.stringify({ file, bytes: Buffer.byteLength(out, 'utf8'), lines: out.split('\n').length - 1 }));
