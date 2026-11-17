// 标签显示名（一事一处权威）：标签栏 / 窗口标题栏 / 状态栏 / 悬停提示共用同一份口径。
// 对比伪标签（compare://A|B）必须显示 "A ↔ B"——修前窗口标题栏/状态栏/悬停提示对伪标签
// 退化成整条 URL 编码串，用户看不出是哪两个文件在比。
import { t, tf } from './i18n';

/** 安全解码：会话文件可被外部改写，坏编码不得让标题渲染抛错。 */
function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** 对比伪标签 → 两个真实路径；非对比标签或结构损坏返回 null。
 *  解码收口在此，标题栏/状态栏/悬停提示都不得直接打印 compare:// 伪路径。 */
export function comparePair(path: string): [string, string] | null {
  if (!path.startsWith('compare://')) return null;
  // 编码后的真实路径不会含裸 '|'（encodeURIComponent 转义为 %7C）；出现多个裸 '|'
  // 只会来自手改/旧格式会话，按第一个分隔符尽力拆分（审查 L5：修前整条判 null，
  // 显示名退化成编码串片段）。
  const rest = path.slice('compare://'.length);
  const sep = rest.indexOf('|');
  if (sep < 0) return null;
  return [safeDecode(rest.slice(0, sep)), safeDecode(rest.slice(sep + 1))];
}

/** 标签显示名：草稿 / 尾随台 / 对比伪标签各有渲染，真实文件取文件名。 */
export function tabDisplayName(tab: { path: string }): string {
  const path = tab.path;
  if (path.startsWith('draft://')) return tf('tab.draft', path.slice('draft://'.length));
  if (path === 'tail://') return t('tab.tailboard');
  const pair = comparePair(path);
  if (pair) {
    return pair
      .map(p => p.replace(/\\/g, '/').split('/').pop() ?? '')
      .join(' ↔ ');
  }
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}
