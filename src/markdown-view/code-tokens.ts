/** 仅消费随包高亮器的 span 输出，返回 UTF-16 范围；源码永不作为 HTML 插入编辑器。 */
export interface CodeToken { from: number; to: number; classes: string }

export function codeLanguage(info: string): string {
  const name = info.trim().split(/\s+/, 1)[0]!.toLowerCase();
  return ['sh', 'shell', 'zsh'].includes(name) ? 'bash' : name;
}
