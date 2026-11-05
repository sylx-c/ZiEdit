// P0-1 回归锁（审计 2026-10-17）：编辑态查找栏输入框按 Enter 是导航操作，不得把默认动作
// 落进正文（fbRun 同步 view.focus() 抢焦点后，未 preventDefault 的 Enter 会在 CM 光标处
// 插入换行/替换当前选中命中词——probe-fbcount.js 实测每按一次 const 4→3→2）。
// 002 规则 7。jsdom 无法复现「焦点抢夺后默认动作落点」，本测试锁源码契约：两个输入框的
// keydown Enter 分支必须 preventDefault（F3 分支为同文件先例）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../src/text-view/findbar.ts', import.meta.url)), 'utf8');

function enterStatements(handlerVar: string): string[] {
  // 取「<var>.addEventListener('keydown', e => { … });」函数体内的完整 Enter 语句
  //（从 if (e.key === 'Enter') 起到其终止分号——不含后续 F3 分支）
  const re = new RegExp(`${handlerVar}\\.addEventListener\\('keydown', e => \\{([\\s\\S]*?)\\}\\);`);
  const m = re.exec(src);
  if (!m) return [];
  const body = m[1]!;
  const out: string[] = [];
  const reEnter = /if \(e\.key === 'Enter'\)/g;
  let mm: RegExpExecArray | null;
  while ((mm = reEnter.exec(body))) {
    const end = body.indexOf(';', mm.index);
    if (end > 0) out.push(body.slice(mm.index, end + 1));
  }
  return out;
}

describe('P0-1 查找栏 Enter 不得改文档（源码契约锁）', () => {
  it('查找输入框的 Enter 语句内带 preventDefault', () => {
    const stmts = enterStatements('this.inputEl');
    expect(stmts.length).toBe(1);
    for (const st of stmts) expect(st).toMatch(/preventDefault/);
  });

  it('替换输入框的 Enter 语句内带 preventDefault', () => {
    const stmts = enterStatements('this.repInputEl');
    expect(stmts.length).toBe(1);
    for (const st of stmts) expect(st).toMatch(/preventDefault/);
  });
});
