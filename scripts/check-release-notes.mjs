#!/usr/bin/env node
// 发布说明格式守卫（2026-11-18）：拦截「内部草稿内容流入公开 Release」这类人肉失误。
// 用法：node scripts/check-release-notes.mjs docs/tmp/release-<版本>/notes.md
// 规则来源仓库发布版式规范（§5）。CI 不跑（notes 在 docs/tmp 不入库）；发布前本地必跑。
import fs from 'node:fs';
const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('用法: node scripts/check-release-notes.mjs <notes.md>'); process.exit(2); }
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
const errors = [];
// 1) 正文不得含 H1（标题由 GitHub Release 标题头承担，正文直接从一句话简介开始）
if (lines.some(l => /^#\s/.test(l))) errors.push('正文含有 H1（# ）标题行——标题由 Release 标题头承担，正文不重复标题');
// 2) 第一段非空行必须直接是简介，不得是标题或括号备注
const first = lines.find(l => l.trim());
if (!first || first.trim().startsWith('#') || first.trim().startsWith('（')) errors.push('正文第一行必须是产品一句话简介（不得是标题/括号内部备注）');
// 3) 固定章节齐全
for (const section of ['## 下载', '## 测试状态', '## 构建说明', '## 本版亮点', '## 验证'])
  if (!lines.includes(section)) errors.push(`缺少固定章节「${section}」`);
// 4) 内部工作语言禁入公开正文
const banned = [/发布草案/, /lead 拟/, /待补/, /发布须等/, /留档/, /安静窗口/, /远程会话/, /虚拟屏/, /物理本地/, /AweSun/, /runner/, /所有者决定/, /试用记录按流程/];
for (const re of banned) { const m = text.match(re); if (m) errors.push(`正文含内部工作标记「${m[0]}」`); }
// 5) 下载表哈希不得留占位
if (/（以上传资产|（同上）|（发布时回填/.test(text)) errors.push('下载表仍含哈希占位符——必须回填实际上传资产 digest');
if (errors.length) { console.error('发布说明未通过格式守卫：'); for (const e of errors) console.error('  - ' + e); process.exit(1); }
console.log('发布说明格式守卫通过：无 H1、简介开头、章节齐全、无内部标记、无占位符。');
