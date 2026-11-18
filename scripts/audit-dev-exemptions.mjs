// npm audit 定点豁免门禁：生产依赖无豁免（由 ci.yml 的 --omit=dev 步骤硬失败），
// 本脚本审全量（生产+开发），仅允许 EXEMPT 清单内「已评估、上游无补丁、不随应用分发」
// 的公告放行；清单外任何 high 及以上仍然失败。上游发布补丁后应升级依赖并删除对应条目。
//
// 本地验证（npmmirror 不支持 audit 端点，需指官方 registry）：
//   $env:NPM_CONFIG_REGISTRY='https://registry.npmjs.org'; node scripts/audit-dev-exemptions.mjs
// 自检豁免逻辑（强制忽略清单，应失败）：
//   $env:ZIEDIT_AUDIT_TEST_NO_EXEMPT='1'; node scripts/audit-dev-exemptions.mjs
import { spawnSync } from 'node:child_process';

const SEVERITY_RANK = { low: 1, moderate: 2, high: 3, critical: 4 };

// 豁免清单：只加「构建/测试期工具链、不进 dist、上游暂无补丁」的条目，并写明复查条件。
const EXEMPT = [
  {
    id: 'GHSA-fc5q-39xc-vjpf', // picomatch ReDoS（单分支重复 extglob）
    packageName: 'picomatch',
    added: '2026-11-18',
    reason: '构建期 glob 匹配器（vite/vitest 经 fdir/tinyglobby 传递），不随应用分发；npm audit --omit=dev 为 0 漏洞；ReDoS 需攻击者可控的匹配模式，本仓库构建配置均为自有输入。',
    removeWhen: 'picomatch 发布补丁版本（>4.0.7）或 vite/vitest 改用替代实现——升级后删除本条目。',
  },
];

const audit = spawnSync('npm', ['audit', '--json', '--audit-level=low'], { encoding: 'utf8', shell: process.platform === 'win32' });
let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error('npm audit --json 输出无法解析（本地 npmmirror 不支持 audit 端点，请设 NPM_CONFIG_REGISTRY=https://registry.npmjs.org）：');
  console.error(audit.stdout || audit.stderr);
  process.exit(1);
}
if (report.error) {
  console.error('npm audit 报错：', report.error.summary ?? report.error);
  process.exit(1);
}

const vulnerabilities = report.vulnerabilities ?? {};
const exemptIds = new Set(process.env.ZIEDIT_AUDIT_TEST_NO_EXEMPT === '1' ? [] : EXEMPT.map(e => e.id));

// 每个包条目的 via 里：对象 = 公告（含 url/GHSA id），字符串 = 它依赖的其他脆弱包名。
// 条目可豁免 ⟺ 其全部 high+ 公告都在豁免清单，且其引用的脆弱依赖条目本身也可豁免。
const nameOf = via => (typeof via === 'string' ? via : null);
const idsOf = via => (typeof via === 'object' && via.url ? (via.url.match(/GHSA-[\w-]+/)?.[0] ?? null) : null);

const canExempt = new Map();
const resolve = (name, seen = new Set()) => {
  if (canExempt.has(name)) return canExempt.get(name);
  if (seen.has(name)) return true; // 环引用按可豁免处理，最终由公告判定收口
  seen.add(name);
  const entry = vulnerabilities[name];
  if (!entry) return true; // via 指向的包未单独成条（不应发生），交给公告判定
  const advisories = (entry.via ?? []).filter(v => typeof v === 'object');
  const depNames = (entry.via ?? []).map(nameOf).filter(Boolean);
  const ok = advisories.every(v => {
    const id = idsOf(v);
    const rank = SEVERITY_RANK[v.severity] ?? 0;
    return rank < SEVERITY_RANK.high || (id !== null && exemptIds.has(id));
  }) && depNames.every(n => resolve(n, seen));
  canExempt.set(name, ok);
  return ok;
};

const blockers = [];
const exempted = new Set();
for (const [name, entry] of Object.entries(vulnerabilities)) {
  const rank = SEVERITY_RANK[entry.severity] ?? 0;
  if (rank < SEVERITY_RANK.high) continue;
  if (resolve(name)) {
    for (const v of (entry.via ?? [])) { const id = idsOf(v); if (id && exemptIds.has(id)) exempted.add(`${id} (${name})`); }
  } else {
    const ids = (entry.via ?? []).map(idsOf).filter(Boolean).join(', ') || '（经依赖传递）';
    blockers.push(`${name}@${entry.range ?? '*'} [${entry.severity}] ${ids}`);
  }
}

if (exempted.size > 0) {
  console.log('已豁免（仅开发工具链，上游无补丁，不随应用分发）：');
  for (const e of exempted) console.log(`  - ${e}`);
  for (const x of EXEMPT.filter(e => exemptIds.has(e.id))) console.log(`    理由：${x.reason}\n    移除条件：${x.removeWhen}`);
}
if (blockers.length > 0) {
  console.error('豁免清单外存在 high 及以上漏洞，失败：');
  for (const b of blockers) console.error(`  - ${b}`);
  process.exit(1);
}
console.log(`npm audit 定点豁免门禁通过（${exempted.size ? `豁免 ${exempted.size} 条` : '无豁免生效'}）。`);
