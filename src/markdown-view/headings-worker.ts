// worker 入口：自带 markdown-it 实例并注入链接/实体工具接缝。
// headings.ts 不再静态 import markdown-it（主 chunk 解除该依赖后，markdown-it 只随本 worker
// chunk 与主线程懒加载 chunk 各打包一份）；此处静态导入保证 worker 的同步提取路径零等待。
import MarkdownIt from 'markdown-it';
import { extractMarkdownMetadata } from './headings';
import { bindMdLinkTools } from './md-link';
import { metadataFingerprint, type MarkdownMetadataReport } from './metadata-fingerprint';

bindMdLinkTools(new MarkdownIt({ html: false }));

self.onmessage = (event: MessageEvent<{ text: string; version: number }>) => {
  const metadata = extractMarkdownMetadata(event.data.text);
  self.postMessage({ version: event.data.version, ...metadata,
    fingerprint: metadataFingerprint(metadata, event.data.text) } satisfies MarkdownMetadataReport);
};
