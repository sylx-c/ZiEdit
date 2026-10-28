// markdown-view —— 图床前端编排（009 v0.2 / ADR 016：应用零网络的唯一例外）。
// 纯逻辑与 IO 注入分离：对象键命名（规则 5 {date}/{hash}/{name} 模板）、公开 URL 构造、
// Markdown 插入转义、上传去重（规则 8：同内容并发合并 + 会话内结果复用）与 ≤2 并发队列
// （规则 7：不排队堆积）、渲染面远程图回填（规则 10：仅 publicBaseUrl host、in-flight 去重、
// 失败静默）。出网调用经 ipc 的 s3_put_object / s3_get_image（仅此两条），测试注入替身。
// E6xxx 错误码口径与 Rust 侧 s3.rs 对齐（E6001 配置不全 / E6002 明文未豁免 / E6003 超 20MB /
// E6004 网络阶段 / E6005 非 2xx / E6006 403 / E6010 host 不在基址）。
import type { S3PutRequest } from '../common/ipc';
import { Compartment, StateEffect } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

/** 对象体上限（与 Rust 侧 MAX_OBJECT_BYTES 同口径，前端先拦不空跑 IPC） */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 上传并发上限（009 规则 7：≤2 串行排队，不并发压端点） */
export const UPLOAD_CONCURRENCY = 2;

/** 内容哈希取前 12 位十六进制（009 规则 5 {hash}） */
export const HASH_LEN = 12;

/** 允许上传的图片 MIME → 对象键扩展名 / 上传 Content-Type（009 规则 3 扩展名单源） */
export const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

/** 扩展名 → MIME（右键本地图片引用上传：磁盘读字节无 File.type，按扩展名定 MIME） */
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/** 路径扩展名 → MIME；不支持的非图片扩展返回 null（触发③上传前拒绝） */
export function mimeOfPath(p: string): string | null {
  const base = p.split(/[\\/]/).pop() ?? '';
  const m = /\.([a-z0-9]+)$/i.exec(base);
  return m ? EXT_MIME[m[1]!.toLowerCase()] ?? null : null;
}

// ── 配置形状（settings.json 平铺键，009 规则 2；凭据仅当前会话内存） ──

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ImageHostConfig {
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Credentials: S3Credentials | null;
  publicBaseUrl: string;
  s3Prefix: string;
  s3NameTemplate: string;
  s3AddressStyle: 'path' | 'virtual-host';
  s3AllowInsecure: boolean;
}

/** 图床启用开关（009 规则 2：默认关；未启用=三触发与远程图回填全部不出现，零网络守卫第一闸） */
export function imageHostEnabled(s: Record<string, unknown>): boolean {
  return s.imageHostEnabled === true;
}

/** settings 平铺键 → 图床配置（缺省值就地补齐）；缺必填字段列名交调用方判 E6001 */
export function imageHostConfigOf(s: Record<string, unknown>): { cfg: ImageHostConfig; missing: string[] } {
  const creds = s.s3Credentials as S3Credentials | null | undefined;
  const cfg: ImageHostConfig = {
    s3Endpoint: typeof s.s3Endpoint === 'string' ? s.s3Endpoint : '',
    s3Region: typeof s.s3Region === 'string' ? s.s3Region : '',
    s3Bucket: typeof s.s3Bucket === 'string' ? s.s3Bucket : '',
    s3Credentials: creds && typeof creds.accessKeyId === 'string' && typeof creds.secretAccessKey === 'string'
      ? { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey }
      : null,
    publicBaseUrl: typeof s.publicBaseUrl === 'string' ? s.publicBaseUrl : '',
    s3Prefix: typeof s.s3Prefix === 'string' ? s.s3Prefix : '',
    s3NameTemplate: typeof s.s3NameTemplate === 'string' && s.s3NameTemplate ? s.s3NameTemplate : '{date}/{hash}',
    s3AddressStyle: s.s3AddressStyle === 'virtual-host' ? 'virtual-host' : 'path',
    s3AllowInsecure: s.s3AllowInsecure === true,
  };
  const missing: string[] = [];
  if (!cfg.s3Endpoint) missing.push('s3Endpoint');
  if (!cfg.s3Region) missing.push('s3Region');
  if (!cfg.s3Bucket) missing.push('s3Bucket');
  if (!cfg.s3Credentials?.accessKeyId || !cfg.s3Credentials?.secretAccessKey) missing.push('s3Credentials');
  return { cfg, missing };
}

// ── 对象键与公开 URL（规则 5） ──

/** 源文件名 stem 净化：剥路径分隔符与空白，空则 'image'（规则 5 {name} 默认） */
export function sanitizeName(name: string | undefined): string {
  const stem = (name ?? '').split(/[\\/]/).pop() ?? '';
  const bare = stem.replace(/\.[^.]*$/, '').trim().replace(/[/\\?%*:|"<>\u0000-\u001f]/g, '');
  return bare || 'image';
}

export interface ObjectKeySource {
  /** 本地日期 YYYY-MM-DD（调用方按本地时区生成，测试可注入） */
  date: string;
  /** 内容 SHA-256 前缀（取前 12 位） */
  hash: string;
  /** 源文件名（含扩展名；{name} 取 stem） */
  name?: string;
  mime: string;
}

/** 对象键 = 前缀 + 模板展开 + 扩展名（幂等：同内容同日期同模板必同键，重传 PUT 覆盖自身） */
export function buildObjectKey(cfg: Pick<ImageHostConfig, 's3Prefix' | 's3NameTemplate'>, src: ObjectKeySource): string {
  const ext = MIME_EXT[src.mime] ?? 'bin';
  const expanded = cfg.s3NameTemplate
    .replace(/\{date\}/g, src.date)
    .replace(/\{hash\}/g, src.hash.slice(0, HASH_LEN))
    .replace(/\{name\}/g, sanitizeName(src.name));
  const prefix = cfg.s3Prefix.replace(/[/\\]+$/, '');
  const body = prefix ? `${prefix}/${expanded}` : expanded;
  return `${body}.${ext}`;
}

/** URL 路径编码（保留 A-Za-z0-9 - . _ ~ /；与 Rust 侧 uri_encode(keep_slash) 同字符集，
 *  空格/括号等百分号化——插入 Markdown 的 URL 不含裸空格与半角括号，免 <> 包裹歧义） */
export function encodePath(s: string): string {
  let out = '';
  for (const ch of s) {
    if (/[A-Za-z0-9\-._~/]/.test(ch)) out += ch;
    else for (const b of new TextEncoder().encode(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** 公开 URL = 基址（剥尾斜杠）+ '/' + 编码后的对象键 */
export function buildPublicUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, '')}/${encodePath(key)}`;
}

// ── Markdown 插入文本转义（规则 6） ──

/** alt/title 转义：\ [ ] < >（009 规则 6：按 Markdown 内联语法转义；反斜杠逃逸对 ASCII 标点合法） */
export function escapeAlt(alt: string): string {
  return alt.replace(/[\\[\]<>]/g, c => `\\${c}`);
}

/** 完整插入片段 ![alt](url)（alt 经转义；URL 经 encodePath 已安全） */
export function imageMarkdown(alt: string, url: string): string {
  return `![${escapeAlt(alt)}](${url})`;
}

// ── 触发动作判决（规则 4：单一函数 imageIngestPlan，三形态共用） ──

export type IngestPlan = 'upload' | 'local' | 'ask' | 'none';

/**
 * 触发①②（贴图/拖入）动作判决：图床未启用仍可本地保存；上传偏好退回询问。
 * pasteImageAction 缺省 'ask'（出厂三选弹窗）；显式 'upload'/'local' 直连跳过弹窗。
 * 触发③（右键改写）是显式上传意图，不经本判决。
 */
export function imageIngestPlan(opts: { enabled: boolean; pasteAction?: 'ask' | 'upload' | 'local' }): IngestPlan {
  if (!opts.enabled) return opts.pasteAction === 'local' ? 'local' : 'ask';
  return opts.pasteAction ?? 'ask';
}

/** 本地图片内容寻址命名，不使用剪贴板提供的文件名作为路径。 */
export async function localImageName(bytes: Uint8Array, mime: string, _timestamp?: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  return `${hash}.${MIME_EXT[mime] ?? 'png'}`;
}

// ── 错误口径（E6xxx 解析，规则 7） ──

export class UploadError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 从 Rust 错误串提取 E6xxx 前缀；非 E6 串归 E6004（网络面兜底） */
export function errorCodeOf(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  const m = s.match(/^(E6\d{3})/);
  return m ? m[1]! : 'E6004';
}

// ── 上传编排（规则 4/5/7/8：去重 + ≤2 并发队列 + 幂等键） ──

export type PutFn = (req: S3PutRequest) => Promise<unknown>;

export interface UploadOutcome {
  url: string;
  key: string;
  etag: string | null;
  deduped: boolean;
}

export interface UploaderOpts {
  put: PutFn;
  /** 内容 SHA-256 十六进制（默认 WebCrypto；jsdom 注入替身） */
  hashHex?: (bytes: Uint8Array) => Promise<string>;
  /** 本地日期 YYYY-MM-DD（默认取当前；测试注入固定值） */
  now?: () => Date;
}

/**
 * 上传器工厂：会话级单例（app 挂载时建一次）。
 * 去重两级：进行中同内容（12 位哈希）复用同一 Promise；已完成复用既有 URL（规则 8）。
 * 队列：全局 ≤2 并发，超出排队（FIFO）；单次上传失败不牵连队列。
 */
export function createUploader(opts: UploaderOpts) {
  const hashHex = opts.hashHex ?? (async (bytes: Uint8Array) => {
    const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  });
  const now = opts.now ?? (() => new Date());
  const results = new Map<string, UploadOutcome>(); // hash12 → 已完成结果
  const inflight = new Map<string, Promise<UploadOutcome>>(); // hash12 → 进行中
  let active = 0;
  const waiting: Array<() => void> = [];
  const slot = async (): Promise<void> => {
    if (active < UPLOAD_CONCURRENCY) {
      active++;
      return;
    }
    await new Promise<void>(r => waiting.push(r));
    active++;
  };
  const release = (): void => {
    active--;
    waiting.shift()?.();
  };

  async function upload(
    bytes: Uint8Array,
    mime: string,
    sourceName: string | undefined,
    cfg: ImageHostConfig
  ): Promise<UploadOutcome> {
    if (!MIME_EXT[mime]) throw new UploadError('E6001', `unsupported mime: ${mime}`);
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new UploadError('E6003', `${bytes.byteLength} > ${MAX_UPLOAD_BYTES}`);
    }
    const full = await hashHex(bytes);
    const h12 = full.slice(0, HASH_LEN);
    // 去重必须绑定目的地与命名策略；完整哈希避免短指纹碰撞复用错误对象。
    const destination = JSON.stringify([cfg.s3Endpoint, cfg.s3Region, cfg.s3Bucket, cfg.publicBaseUrl, cfg.s3Prefix, cfg.s3NameTemplate, cfg.s3AddressStyle, cfg.s3Credentials?.accessKeyId, mime, cfg.s3NameTemplate.includes('{name}') ? sanitizeName(sourceName ?? '') : null]);
    const cacheKey = destination + '\u0000' + full;
    const cached = results.get(cacheKey);
    if (cached) return { ...cached, deduped: true };
    const running = inflight.get(cacheKey);
    if (running) return { ...(await running), deduped: true };
    const work = (async () => {
      await slot();
      try {
        const d = now();
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const key = buildObjectKey(cfg, { date, hash: h12, name: sourceName, mime });
        const b64 = bytesToBase64(bytes);
        let etag: string | null = null;
        try {
          const r = (await opts.put({
            endpoint: cfg.s3Endpoint,
            region: cfg.s3Region,
            bucket: cfg.s3Bucket,
            accessKeyId: cfg.s3Credentials!.accessKeyId!,
            secretAccessKey: cfg.s3Credentials!.secretAccessKey!,
            key,
            contentBase64: b64,
            contentType: mime,
            addressStyle: cfg.s3AddressStyle,
            allowInsecure: cfg.s3AllowInsecure,
          })) as { etag?: string | null };
          etag = r?.etag ?? null;
        } catch (err) {
          throw new UploadError(errorCodeOf(err), String(err instanceof Error ? err.message : err));
        }
        const outcome: UploadOutcome = {
          url: buildPublicUrl(cfg.publicBaseUrl, key),
          key,
          etag,
          deduped: false,
        };
        results.set(cacheKey, outcome);
        while (results.size > 1024) results.delete(results.keys().next().value as string);
        return outcome;
      } finally {
        release();
      }
    })();
    inflight.set(cacheKey, work);
    try {
      return await work;
    } finally {
      inflight.delete(cacheKey);
    }
  }

  return { upload, results, inflight };
}

/** Uint8Array → base64（分块避参数超限；上传体过 IPC 用） */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ── 渲染面远程图回填（规则 10：data: URL 内联，CSP img-src data: 已放行，零 CSP 变更） ──

export type GetImageFn = (url: string, allowedBase: string) => Promise<{ mime: string; dataBase64: string }>;
const remoteRequests = new WeakMap<HTMLImageElement, { src: string; base: string; current: () => boolean }>();

/** URL host（小写，含显式端口）；非 http(s) 返回 null —— host 过滤基准，AC-12 零请求边界 */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.host.toLowerCase();
  } catch {
    return null;
  }
}

const remoteDataCache = new Map<string, Promise<string>>();
const remoteDataSizes = new Map<string, number>();
const REMOTE_CACHE_BYTES = 64 * 1024 * 1024;
let remoteDataBytes = 0;

/**
 * 图床 URL → data: URL（模块级缓存 + in-flight 去重；预览/分屏/IR 图片件三路共用，
 * 失败清出缓存——下次重渲自然重试，规则 10「重试于重渲染」口径）。
 */
export function fetchRemoteDataUrl(url: string, base: string, getImage: GetImageFn): Promise<string> {
  if (!hostOf(base) || hostOf(url) !== hostOf(base)) return Promise.reject(new Error('E6010'));
  const key = JSON.stringify([base, url]);
  let p = remoteDataCache.get(key);
  if (p) { remoteDataCache.delete(key); remoteDataCache.set(key, p); }
  if (!p) {
    p = getImage(url, base).then(r => {
      const data = `data:${r.mime};base64,${r.dataBase64}`;
      const size = data.length * 2;
      remoteDataSizes.set(key, size);
      remoteDataBytes += size;
      for (const victim of remoteDataCache.keys()) {
        if (remoteDataBytes <= REMOTE_CACHE_BYTES) break;
        const weight = remoteDataSizes.get(victim);
        if (weight == null) continue;
        remoteDataBytes -= weight;
        remoteDataSizes.delete(victim);
        remoteDataCache.delete(victim);
      }
      return data;
    });
    remoteDataCache.set(key, p);
    p.catch(() => remoteDataCache.delete(key));
  }
  return p;
}

/**
 * 渲染容器内图床远程图 → s3_get_image 取回内联为 data: URL（WebView 不直接出网）。
 * 只处理 host 与 publicBaseUrl 全等的 img；其他 host 的远程图不碰（007 规则 21 口径：
 * CSP 拦截自然呈占位）。失败静默（规则 10：占位 + 下次重渲自然重试），同 URL 去重。
 * 幂等：已是 data:/asset: 的 src 与带 data-md-remote-done 标记的跳过。
 */
export function resolveRemoteImages(
  root: ParentNode,
  base: string,
  getImage: GetImageFn,
  isCurrent: () => boolean = () => true
): void {
  const baseHost = hostOf(base);
  if (!baseHost) return;
  const imgs = root.querySelectorAll<HTMLImageElement>('img[src]');
  for (const img of imgs) {
    const src = img.getAttribute('src') ?? '';
    if (!isCurrent() || !/^https?:\/\//i.test(src)) continue;
    if (hostOf(src) !== baseHost) continue;
    const pending = remoteRequests.get(img);
    if (pending?.src === src && pending.base === base && pending.current()) continue;
    const request = { src, base, current: isCurrent };
    remoteRequests.set(img, request);
    img.dataset.mdRemoteDone = '1';
    img.dataset.mdSrc = src; // 右键上下文（本地/远程统一入口）保留原始引用
    void fetchRemoteDataUrl(src, base, getImage).then(
      dataUrl => {
        if (remoteRequests.get(img) !== request) return;
        remoteRequests.delete(img);
        delete img.dataset.mdRemoteDone;
        if (isCurrent() && img.getAttribute('src') === src) img.src = dataUrl;
      },
      () => {
        if (remoteRequests.get(img) !== request) return;
        remoteRequests.delete(img);
        delete img.dataset.mdRemoteDone; // 保留原引用，下次重渲允许重试。
      }
    );
  }
}

// ── 粘贴/拖入源读取（规则 4 触发①②） ──

/** 剪贴板 DataTransfer 里的首张图片（image/* 非 文件路径文本）；无则 null */
export function clipboardImageOf(dt: DataTransfer): File | null {
  for (const item of Array.from(dt.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

/** DataTransfer 全为图片文件判定（拖入拦截口径：全图才拦，混合拖放走原打开逻辑） */
export function allItemsImages(dt: DataTransfer): boolean {
  const files = Array.from(dt.files);
  return files.length > 0 && files.every(f => f.type.startsWith('image/'));
}

/** File → {bytes, mime, name}（ArrayBuffer 一次读入——上传物 ≤20MB 上限内） */
export async function readImageFile(f: File): Promise<{ bytes: Uint8Array; mime: string; name: string }> {
  const buf = await f.arrayBuffer();
  // 截图工具有给 image/png 但文件名 .jpg 的错位——MIME 优先、以 MIME_EXT 认可为准
  const mime = MIME_EXT[f.type] ? f.type : 'image/png';
  return { bytes: new Uint8Array(buf), mime, name: f.name };
}

/**
 * 在源文本中定位图片引用的 URL 段（009 规则 4 ③ 上传后回填）。
 * 渲染面 data-md-src 可能被渲染引擎百分号编码（中文/空格路径），
 * 除原样命中外还按解码写法与 <...> 角括号形式重试；URL 段后必须跟终结符，防止误配前缀相同的其他引用。
 */
export function findImageRefRange(text: string, ref: string, preferFrom?: number): { from: number; to: number } | null {
  let decoded = ref;
  try { decoded = decodeURIComponent(ref); } catch { /* 非法转义保持原样 */ }
  const raws = decoded === ref ? [ref] : [ref, decoded];
  if (preferFrom != null) {
    for (const raw of raws) {
      if (text.slice(preferFrom, preferFrom + raw.length) === raw) return { from: preferFrom, to: preferFrom + raw.length };
      if (text.slice(preferFrom, preferFrom + raw.length + 2) === `<${raw}>`) return { from: preferFrom + 1, to: preferFrom + 1 + raw.length };
    }
  }
  const variants: { pat: string; start: number; len: number }[] = [];
  for (const raw of raws) {
    variants.push({ pat: `](${raw}`, start: 2, len: raw.length });
    variants.push({ pat: `](<${raw}>`, start: 3, len: raw.length });
  }
  const terminated = (i: number, patLen: number): boolean => {
    const after = text[i + patLen];
    return after === undefined || after === ')' || after === ' ' || after === '"' || after === "'";
  };
  for (const seed of preferFrom != null ? [preferFrom, 0] : [0]) {
    let best: { from: number; to: number } | null = null;
    for (const { pat, start, len } of variants) {
      let searchFrom = seed;
      for (;;) {
        const i = text.indexOf(pat, searchFrom);
        if (i < 0) break;
        if (terminated(i, pat.length)) {
          const hit = { from: i + start, to: i + start + len };
          if (!best || hit.from < best.from) best = hit;
          break;
        }
        searchFrom = i + 1;
      }
    }
    if (best) return best;
  }
  return null;
}

/** 异步图片操作固定文档和区间；期间的输入映射位置，目标内容被改写则放弃。 */
export function trackImageTarget(view: EditorView, from: number, to = from) {
  const compartment = new Compartment();
  let valid = true;
  let disposed = false;
  let alive = true;
  view.dispatch({ effects: StateEffect.appendConfig.of(compartment.of([ViewPlugin.define(() => ({ destroy: () => { alive = false; } })), EditorView.updateListener.of(u => {
    if (!u.docChanged) return;
    u.changes.iterChangedRanges((a, b) => {
      if (a < to && b > from || a === b && a > from && a < to) valid = false;
    });
    const empty = from === to;
    from = u.changes.mapPos(from, 1);
    to = empty ? from : u.changes.mapPos(to, -1);
  })])) });
  return {
    view,
    range: () => valid && alive ? { from, to } : null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (alive) view.dispatch({ effects: compartment.reconfigure([]) });
    },
  };
}
