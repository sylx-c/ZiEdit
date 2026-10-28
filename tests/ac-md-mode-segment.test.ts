// @vitest-environment jsdom
// 状态栏 Markdown 形态入口（2026-10 定稿）：**单一模式格**——显示当前形态名，点击弹出
// 四形态菜单选择（当前项打 ✓、超限置灰）。散装快捷格与多按钮分段均为用户否决形态，不得回潮。
import { describe, expect, it } from 'vitest';
import { shell, startShell, settle } from './shell-behavior-harness';
import { t } from '../src/common/i18n';

describe('状态栏 Markdown 形态入口（单一模式格）', () => {
  it('md 标签：模式格点击弹四形态菜单，当前项打钩，选择即切换；无分段无散装快捷格', async () => {
    await startShell();
    shell.actions.run('file.newDraft');
    await settle();
    // 纯文本草稿：同样只有单一模式格
    expect(document.querySelector('.st-mdseg')).toBeNull();

    const lang = [...document.querySelectorAll<HTMLElement>('.st-cell')].find(el => el.title === t('st.tip.lang'))!;
    lang.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    [...document.querySelectorAll<HTMLElement>('.ctx-menu div')].find(el => el.textContent?.includes('Markdown'))!.click();
    await settle();

    const mode = [...document.querySelectorAll<HTMLElement>('.st-cell')].find(el => el.title === t('st.tip.mode'));
    expect(mode).toBeTruthy();
    expect(document.querySelector('.st-mdseg')).toBeNull(); // 多按钮分段不回潮

    // 点击模式格 → 四形态菜单，恰一项打钩（出厂即时渲染）
    mode!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const items = [...document.querySelectorAll<HTMLElement>('.ctx-menu div')];
    const labels = items.map(el => el.textContent ?? '');
    for (const key of ['act.mdSource', 'act.mdSplit', 'act.mdPreview', 'act.mdWysiwyg']) {
      expect(labels.some(x => x.includes(t(key)))).toBe(true);
    }
    expect(labels.filter(x => x.trimStart().startsWith('✓')).length).toBe(1);

    // 选择「渲染预览」→ 形态切换，模式格文本随之更新（单一事实源）
    items.find(el => el.textContent?.includes(t('act.mdPreview')))!.click();
    await settle();
    expect(shell.getMode()).toBe('md');
    const mode2 = [...document.querySelectorAll<HTMLElement>('.st-cell')].find(el => el.title === t('st.tip.mode'))!;
    expect(mode2.textContent).toBe(t('act.mdPreview'));
  });
});
