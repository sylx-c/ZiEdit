// UX 快赢批（用户 2026-10-17 工单，001 v2.5 / 007 v0.14）源码契约锁：
// 行高亮默认加深（四主题取值）｜--md-fs 废止（Markdown 正文脱离字号设置）｜
// IR 工具栏形态段移除｜会话恢复草稿序号续排｜opener open-path 权限移除。
// 规格依据：001 规则 17/19/25/30/31 v2.5；007 规则 2/3/20 v0.14。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const app = read('../src/shell/app.ts');
const css = read('../src/styles.css');
const caps = read('../src-tauri/capabilities/default.json');
const i18n = read('../src/common/i18n.ts');

describe('001 v2.17：只读入口与使用模式（只读本标签化）', () => {
  it('工具栏放本标签「编辑|只读」段，全局只读走工具菜单且保留选中态', () => {
    expect(app).toContain("seg: ['view.tabEdit', 'view.tabLock']");
    expect(app).toContain("id: 'view.tabEdit'");
    expect(app).toContain("id: 'view.tabLock'");
    expect(app).toContain("id: 'view.readOnly'");
    expect(app).toContain("{ action: 'view.readOnly' }");
    expect(app).toContain('currentView.setReadOnly(readOnlyMode)');
    expect(app).not.toContain("'view.hex'");
    expect(i18n).toContain("'tb.tabEdit': '编辑'");
    expect(i18n).toContain("'tb.readOnly': '只读'");
    expect(i18n).toContain("'tb.readOnly': 'Read-only'");
  });
  it('目录拖放先确认，状态栏右键复用视图动作，提示保留4秒', () => {
    expect(app).toContain("st.isDir && !await dlgConfirm($tf('msg.confirmDropFolder', p))");
    expect(app).toContain("statusbar.addEventListener('contextmenu'");
    expect(app).toContain("['view.invisible', 'view.toggleRuler', 'view.minimap']");
    expect(read('../src/shell/chrome.ts')).toContain('}, 4000)');
  });
});

describe('001 规则 17 v2.5：当前行高亮默认加深', () => {
  it('styles.css 四主题 --line-hl 精确取值（paper 降 L；cool/graphite/black 改 accent 低透明铺色）', () => {
    expect(css).toMatch(/--line-hl:oklch\(0\.938 0\.006 254\)/); // paper
    expect(css).toMatch(/--line-hl:oklch\(0\.54 0\.16 256 \/ 0\.12\)/); // cool
    expect(css).toMatch(/--line-hl:oklch\(0\.72 0\.12 254 \/ 0\.13\)/); // graphite
    expect(css).toMatch(/--line-hl:oklch\(0\.80 0\.085 234 \/ 0\.14\)/); // black
    expect(css).not.toMatch(/--line-hl:oklch\(0\.958/); // 修前 paper 过浅值不得残留
  });

  it('取色器初始色对齐 paper 新默认', () => {
    expect(app).toContain("'#eaeef4'");
    expect(app).not.toContain("'#e8f0fe'");
  });
});

describe('001 规则 19 v2.5：IR 工具栏形态切换段移除', () => {
  it('TOOLBAR_SPEC wysiwyg 上下文无 [源码|分屏|预览|即时] 分段（与状态栏快捷格/模式格入口重复）', () => {
    expect(app).not.toMatch(/seg:\s*\['tbmd\.source'/);
    expect(app).toMatch(/tbmd\.headings/); // 格式化按钮组保留
  });

  it('「文字大小 ▸」子菜单 i18n 双语', () => {
    expect(i18n).toContain("'menu.zoomGroup': '文字大小'");
    expect(i18n).toContain("'menu.zoomGroup': 'Text Size'");
  });
});

describe('001 规则 25 v2.5：会话恢复草稿序号续排', () => {
  it('bumpDraftSeqFromStore 定义 + 两处 restore 挂点（启动恢复/命名会话恢复）', () => {
    expect(app).toMatch(/function bumpDraftSeqFromStore\(\): void/);
    expect(app).toContain('const m = /^draft:\\/\\/(\\d+)$/.exec(t.path);'); // 按 draft://N 取历史最大
    expect(app.match(/bumpDraftSeqFromStore\(\); \/\/ v2\.5/g)?.length).toBe(2);
  });
});

describe('001 规则 30 v2.5：外链交系统浏览器', () => {
  it('opener 只剩 openUrl（外链系统浏览器）；open-path 权限移除', () => {
    expect(app).toMatch(/import \{ openUrl \} from '@tauri-apps\/plugin-opener'/);
    expect(app).not.toMatch(/openPath as openBundled/);
    expect(caps).not.toContain('opener:allow-open-path');
    expect(caps).toContain('opener:default'); // openUrl 外链仍需默认权限
  });
});

describe('007 规则 20 v2.1（2026-10 用户定稿）：--md-fs 令牌保持废止，正文随 --md-fs-user 派生', () => {
  it('旧字号令牌不复活；--md-fs-base 由 --md-fs-user 派生（缺省 13.5px），三形态消费同一令牌', () => {
    expect(app).not.toContain("'--md-fs'");
    // 恒定正文令牌不恢复旧字号设置令牌（007 规则 16/20）。
    expect(css).not.toContain('var(--md-fs)');
    expect(css).toContain('--md-fs-base:var(--md-fs-user,13.5px)');
    expect(app).toContain('--md-fs-user'); // applyFontSize/boot 注入派生字号
    expect(css).toMatch(/\.md-ir \.cm-scroller\{[^}]*font-size:var\(--md-fs-base\)/);
    expect(css).toMatch(/\.md-preview \.md-col\{[^}]*font-size:var\(--md-fs-base\)/);
  });
});

describe('007 规则 3 v0.14（v0.16 引擎重造收编）：代码块观感两管线分立', () => {
  it('不再携带旧编辑器样式；排版尺寸通过实际渲染面验收', () => {
    expect(css).not.toContain('.md-wysiwyg');
    expect(css).not.toContain('md-legacy-ir');
  });
});
