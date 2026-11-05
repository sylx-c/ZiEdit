// 统一剪贴板读写（#17 整改）：桌面走 tauri-plugin-clipboard-manager（原生通道，
// 无 WebView2「想要查看剪贴板」权限弹窗）；Web harness（无 Tauri IPC，浏览器测试）
// 回退 navigator.clipboard。全部读写必须经由此模块，不得散落 navigator 调用。
import { convertEol } from './text';

/** 是否运行在 Tauri 桌面环境（与 app.ts 探测方式一致） */
function inTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

/** 读剪贴板文本；不可用/失败返回 ''（调用方以空串视为无内容，不中断流程）。
 *  出口统一行尾归一（CRLF/CR→LF，005 规则 5 v2.3）：Windows 其他应用复制的多行文本带
 *  \r，混进内容会让列粘贴逐行错位；编辑缓冲内部恒 LF（CM6 装载/插入均按 \r\n|\r|\n 分行），
 *  普通粘贴与列粘贴同口径。 */
export async function readClipboardText(): Promise<string> {
  let raw = '';
  if (inTauri()) {
    try {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
      raw = await readText();
    } catch {
      return '';
    }
  } else {
    try {
      raw = await navigator.clipboard.readText();
    } catch {
      return '';
    }
  }
  return convertEol(raw, '\n');
}

/** 写剪贴板文本；失败静默（复制失败不打断主流程，状态栏无提示为既有口径） */
export async function writeClipboardText(text: string): Promise<void> {
  if (inTauri()) {
    try {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
    } catch {
      /* 静默 */
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* 静默 */
  }
}

/** 写入原始字节并同时提供文本回退。
 * WebView2/浏览器支持自定义 MIME 时保留 application/octet-stream；不支持时仍把
 * 可读的 Hex 文本放入系统剪贴板，不能因为二进制格式失败而丢失复制结果。
 */
export async function writeClipboardBytes(bytes: Uint8Array, fallbackText: string): Promise<void> {
  try {
    if (typeof navigator.clipboard?.write === 'function' && typeof ClipboardItem !== 'undefined') {
      // 复制到独立 ArrayBuffer，兼容 TypeScript 6 对 ArrayBufferLike/SharedArrayBuffer 的
      // 更严格区分，且不把调用方可能复用的视图暴露给异步 Clipboard API。
      const owned = new Uint8Array(bytes.byteLength);
      owned.set(bytes);
      const raw = new Blob([owned.buffer as ArrayBuffer], { type: 'application/octet-stream' });
      const text = new Blob([fallbackText], { type: 'text/plain' });
      await navigator.clipboard.write([new ClipboardItem({
        'application/octet-stream': raw,
        'text/plain': text,
      })]);
      return;
    }
  } catch {
    /* fall through to the native text channel */
  }
  await writeClipboardText(fallbackText);
}
