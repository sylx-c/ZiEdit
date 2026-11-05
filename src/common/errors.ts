/** IPC 仍接收旧版字符串；只有边界处解析，未知错误保留原文与原始对象。 */
export interface AppError {
  code: string;
  message: string;
  diagnostic: unknown;
}

export function parseError(error: unknown): AppError {
  const object = error !== null && typeof error === 'object' ? error as Record<string, unknown> : undefined;
  const message = error instanceof Error ? error.message
    : typeof error === 'string' ? error
    : typeof object?.message === 'string' ? object.message
    : (() => { try { return JSON.stringify(error) ?? String(error); } catch { return String(error); } })();
  // 只识别消息开头的协议哨兵；文件名包含 EXISTS 等字样不应改变错误分支。
  const sentinel = /^(EXTERNAL_CHANGED|UNMAPPABLE|EXISTS|NOT_FOUND|TOO_LARGE|INDEXING)(?=$|[:\s])/.exec(message)?.[1];
  const numbered = /^\[?(E\d{4})\]?(?=$|[:\s])/.exec(message)?.[1];
  const code = typeof object?.code === 'string' && object.code.length > 0 ? object.code : sentinel ?? numbered ?? 'UNKNOWN';
  return { code, message, diagnostic: error };
}
