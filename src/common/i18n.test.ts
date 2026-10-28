// i18n 一致性单测（001 规则 26 界面多语言 / AGENTS 红线：不自造术语、文案全覆盖）
// 双向守护：① 中英字典 key 对齐且占位符一致 ② 代码引用的 key 必在字典、字典 key 必被引用（无缺失、无冗余）
/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { dict, t, tf } from './i18n';

// 源码原始文本（?raw）：排除测试与字典自身，避免自引用
const SOURCES = import.meta.glob('../**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const CODE = Object.entries(SOURCES).filter(
  ([p]) => !p.endsWith('.test.ts') && !p.replace(/\\/g, '/').endsWith('common/i18n.ts')
);

const ZH = dict('zh-CN');
const EN = dict('en-US');
const ZH_KEYS = Object.keys(ZH);
const EN_KEYS = Object.keys(EN);

// i18n key 前缀取自字典自身（key 形态：前缀.路径），避免写死清单
const PREFIXES = [...new Set(ZH_KEYS.map(k => k.split('.')[0]))].sort();
const KEY_RE = new RegExp(`^(?:${PREFIXES.join('|')})\\.[A-Za-z0-9.]+$`);
const LITERAL_RE = /'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)'/g;

/** 剥离注释与动作 id：action id 与 i18n key 形态相同但语义无关，避免误判 */
function stripNoise(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    .replace(/\b(?:id|action)\s*:\s*'[^']*'/g, ' ')
    .replace(/\breg\.(?:run|get)\(\s*'[^']*'/g, ' ');
}

/** 源码中出现的所有合法 i18n key 字面量（含三元、数组、映射表等间接引用形态） */
function referencedKeys(): Set<string> {
  const out = new Set<string>();
  for (const [, raw] of CODE) {
    for (const m of stripNoise(raw).matchAll(LITERAL_RE)) if (KEY_RE.test(m[1])) out.add(m[1]);
  }
  return out;
}

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort();

describe('i18n 字典', () => {
  it('中英 key 完全对齐', () => {
    expect([...EN_KEYS].sort()).toEqual([...ZH_KEYS].sort());
  });

  it('无空文案', () => {
    for (const k of ZH_KEYS) {
      expect(ZH[k].length, `zh-CN 缺失文案：${k}`).toBeGreaterThan(0);
      expect(EN[k].length, `en-US 缺失文案：${k}`).toBeGreaterThan(0);
    }
  });

  it('中英同一 key 的插值占位符一致', () => {
    const bad = ZH_KEYS.filter(k => EN[k] !== undefined && placeholders(ZH[k]).join() !== placeholders(EN[k]).join());
    expect(bad, `占位符不一致：${bad.join(', ')}`).toEqual([]);
  });
});

describe('i18n 与代码的双向一致', () => {
  const used = referencedKeys();

  it('代码引用的 key 都在字典里（无缺失 key）', () => {
    expect([...used].filter(k => !(k in ZH))).toEqual([]);
  });

  it('字典 key 都被代码引用（无冗余 key）', () => {
    expect(ZH_KEYS.filter(k => !used.has(k))).toEqual([]);
  });
});

describe('t / tf', () => {
  it('取当前语言文案，缺 key 回退为 key 本身', () => {
    expect(t('__no_such_key__')).toBe('__no_such_key__');
    expect(t('common.ok').length).toBeGreaterThan(0);
  });

  it('tf 按 {0}/{1} 插值（英文语序可调整）', () => {
    expect(tf('__nope__{0}-{1}', 'a', 2)).toBe('__nope__a-2');
    expect(tf('act.restoreSessionOf', 'S')).toBe('恢复会话：S');
  });
});
