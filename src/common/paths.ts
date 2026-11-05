// paths —— 标签路径形态裁决纯函数（002 规则 7b/30 v2.2：伪标签适用矩阵的单一判决）。
// 纯函数无 DOM / IPC 依赖，便于单测（tests/ac-001-pseudo-tab.test.ts）。
// 从 app.ts 顶层迁出（P0-2）：伪路径进 text_open 会以 ERROR_INVALID_NAME（os error 123）
// 失败并弹 E1001，判决必须收口在一处供全部「进入编辑/保存/规范化」入口共用。

/** 本地路径规范化（与 TabStore 归一化同义：Windows 统一反斜杠） */
export function normLocal(p: string): string {
  return /^[A-Za-z]:[\\/]/.test(p) ? p.replace(/\//g, '\\') : p;
}

/** 父目录（盘符根兜底为带分隔符形态，如 C:\） */
export function dirOf(p: string): string {
  const d = p.replace(/[\\/][^\\/]+$/, '');
  return /^[A-Za-z]:$/.test(d) ? d + '\\' : d;
}

/** 真实磁盘文件（排除草稿/对比/尾随台伪标签） */
export function isRealFilePath(p: string): boolean {
  return !p.startsWith('draft://') && !p.startsWith('compare://') && p !== 'tail://';
}

/** 不可编辑的伪标签（对比 compare:// / 尾随台 tail://）——无对应磁盘文件。
 *  编辑面入口与状态栏可点格（COL 灯/模式格）统一经此判决设防（002 规则 7b/30；
 *  v2.6 起查看⇄编辑切换入口已删，判决服务于编辑类动作与状态栏交互）：
 *  伪路径进 text_open 会以 ERROR_INVALID_NAME（os error 123）失败并弹 E1001。 */
export function isVirtualTab(p: string): boolean {
  return p.startsWith('compare://') || p === 'tail://';
}

/** 目录跟随判决（001 规则 25 v2.0/v2.5，P1-5）：活动标签决定树根。
 *  返回 'keep' = 保持现根不动；null = 树清空；字符串 = 应换根到该目录。
 *  切标签/关标签/会话恢复同口径；真实文件标签跟到其目录。
 *  v2.5：伪路径标签（草稿/对比/尾随台）按 hasRealTabs 分岔——仍有真实文件标签存续则
 *  保持现根（切到草稿不应动树）；仅剩伪标签时树清空回空态（显式根豁免在 app 层）。 */
export function deriveTreeRoot(
  activePath: string | null,
  currentRoot: string | null,
  hasRealTabs = true,
): 'keep' | null | string {
  if (activePath == null) return null;
  if (!isRealFilePath(activePath)) return hasRealTabs ? 'keep' : null;
  const dir = normLocal(dirOf(activePath));
  return dir === currentRoot ? 'keep' : dir;
}
