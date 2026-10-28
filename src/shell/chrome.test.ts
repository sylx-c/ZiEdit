// 文案本地化 L()（chrome）：判据为「字典里有没有这个键」，不是前缀白名单。
// H-6f 查实：旧实现用 /^(act|menu|tb|ed|sidebar|st|cmd|common)\./ 白名单判 key，
// 漏掉 md.* 命名空间 ⇒ 八个 Markdown 格式钮的悬停提示显示裸 key（title="md.bold"），
// 而可见文字走 tb.*（在白名单内）是译好的，缺陷只在 title 上现形。
// 该缺陷的同类（任何新命名空间按白名单规则都会静默不翻译）由下面第一条批量锁死：
// 字典里**每一个**键都必须被 L 译出，新增命名空间自动被覆盖。
import { describe, expect, it } from 'vitest';
import { dict, t, tf } from '../common/i18n';
import { L } from './chrome';

describe('chrome.L 文案本地化', () => {
  it('字典中每个键都被翻译（不留裸 key，含 md.* 等白名单外命名空间）', () => {
    const keys = [...Object.keys(dict('zh-CN')), ...Object.keys(dict('en-US'))];
    expect(keys.length).toBeGreaterThan(600);
    const untranslated = keys.filter(k => L(k) === k);
    expect(untranslated).toEqual([]);
  });

  it('MD 格式钮的 label（缺陷现场八枚）返回译文而非键名', () => {
    expect(L('md.bold')).toBe(t('md.bold'));
    expect(L('md.italic')).toBe(t('md.italic'));
    expect(L('md.strike')).toBe(t('md.strike'));
    expect(L('md.inlineCode')).toBe(t('md.inlineCode'));
    expect(L('md.codeBlock')).toBe(t('md.codeBlock'));
    expect(L('md.link')).toBe(t('md.link'));
    expect(L('md.table')).toBe(t('md.table'));
    expect(L('md.headingBtn')).toBe('标题级别');
  });

  it('纯文本 label（文件名、路径、自造词）原样返回', () => {
    expect(L('E:\\work\\editor\\README.md')).toBe('E:\\work\\editor\\README.md');
    expect(L('未命名 1')).toBe('未命名 1');
    expect(L('sub-page.md')).toBe('sub-page.md');
  });

  it('空值返回空串（label 可缺省）', () => {
    expect(L(undefined)).toBe('');
    expect(L('')).toBe('');
  });

  it('动态会话项走 tf 插值（不是字典键）', () => {
    expect(L('act.restoreSession:排障')).toBe(tf('act.restoreSessionOf', '排障'));
  });
});
