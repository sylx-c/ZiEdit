import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

// (2026-10-29 ac-011) 仅复制运行所需的数据、JS fallback 与许可，不复制 wasm 二进制。
export function syncPdfjsAssets() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = join(root, 'node_modules/pdfjs-dist');
  const target = join(root, 'public/pdfjs-assets');
  mkdirSync(join(target, 'wasm'), { recursive: true });
  for (const dir of ['cmaps', 'standard_fonts']) cpSync(join(source, dir), join(target, dir), { recursive: true });
  cpSync(join(source, 'LICENSE'), join(target, 'LICENSE'));
  for (const name of readdirSync(join(source, 'wasm'))) {
    if (name.endsWith('_nowasm_fallback.js') || name.startsWith('LICENSE')) {
      cpSync(join(source, 'wasm', name), join(target, 'wasm', name));
    }
  }
}

// CLI 直跑（CI 许可门禁前生成 public/pdfjs-assets；vite buildStart 仍走具名导入）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncPdfjsAssets();
  console.log('pdfjs-assets synced');
}
