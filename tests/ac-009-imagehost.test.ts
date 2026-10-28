// @vitest-environment jsdom
// 009 v0.2 验收锁（UX-C6 图床 / ADR 016 网络例外）：
// AC-1 配置形状与缺省（imageHostConfigOf + 启用开关默认关）；
// AC-3 命名与去重（{date}/{hash} 幂等键、同内容并发合并 + 会话内复用 → 单次 put）；
// 规则 7 ≤2 并发队列；E6001/E6003 上传前拒绝（不发起 put）；
// 规则 4 imageIngestPlan 判决单一函数（未启用本地兜底 / 出厂 ask / 直连）；
// 规则 5/6 对象键、URL 编码、alt 转义与插入片段；
// 规则 10 渲染面远程图回填（host 全等过滤、幂等标记、失败静默 + 缓存逐出重试）；
// 源契约锁（lib.rs 三命令注册 / Cargo.toml reqwest rustls / CSP 零变更 / app 三触发接线）。
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const {
  imageHostConfigOf,
  imageHostEnabled,
  imageIngestPlan,
  buildObjectKey,
  buildPublicUrl,
  encodePath,
  escapeAlt,
  imageMarkdown,
  findImageRefRange,
  mimeOfPath,
  sanitizeName,
  bytesToBase64,
  createUploader,
  hostOf,
  fetchRemoteDataUrl,
  resolveRemoteImages,
  readImageFile,
  MIME_EXT,
  MAX_UPLOAD_BYTES,
  UPLOAD_CONCURRENCY,
  UploadError,
} = await import('../src/markdown-view/imagehost');

const CFG = (over: Record<string, unknown> = {}): ReturnType<typeof imageHostConfigOf>['cfg'] =>
  imageHostConfigOf({
    s3Endpoint: 'https://s3.example.local',
    s3Region: 'cn-north-1',
    s3Bucket: 'ZiEdit-bucket',
    s3Credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
    publicBaseUrl: 'https://cdn.example.local',
    ...over,
  }).cfg;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('009/007 AC-29 图片请求归属与重试', () => {
  it('同一缓存 DOM 请求失败后，下一次重渲可以重试', async () => {
    const root = document.createElement('div');
    const img = document.createElement('img');
    const url = 'https://cdn.example.local/dom-retry.png';
    img.src = url;
    root.append(img);
    const get = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ mime: 'image/png', dataBase64: 'AA==' });
    resolveRemoteImages(root, 'https://cdn.example.local', get);
    await sleep(0);
    resolveRemoteImages(root, 'https://cdn.example.local', get);
    await sleep(0);
    expect(get).toHaveBeenCalledTimes(2);
    expect(img.src).toBe('data:image/png;base64,AA==');
  });

  it.each(['reference', 'lifecycle'])('%s 变化后迟到请求不能覆盖图片', async kind => {
    const root = document.createElement('div');
    const img = document.createElement('img');
    const url = `https://cdn.example.local/late-${kind}.png`;
    img.src = url;
    root.append(img);
    let current = true;
    let finish!: (r: { mime: string; dataBase64: string }) => void;
    resolveRemoteImages(root, 'https://cdn.example.local', () => new Promise(r => { finish = r; }), () => current);
    if (kind === 'reference') img.src = 'data:image/png;base64,BB==';
    else current = false;
    finish({ mime: 'image/png', dataBase64: 'AA==' });
    await sleep(0);
    expect(img.src).toBe(kind === 'reference' ? 'data:image/png;base64,BB==' : url);
  });
});

describe('009 AC-1 配置与启用开关', () => {
  it('缺省值：模板 {date}/{hash}、path 风格、明文豁免关、启用默认关', () => {
    const { cfg } = imageHostConfigOf({});
    expect(cfg.s3NameTemplate).toBe('{date}/{hash}');
    expect(cfg.s3AddressStyle).toBe('path');
    expect(cfg.s3AllowInsecure).toBe(false);
    expect(cfg.s3Credentials).toBeNull();
    expect(imageHostEnabled({})).toBe(false);
    expect(imageHostEnabled({ imageHostEnabled: true })).toBe(true);
  });

  it('缺必填字段列名（E6001 呈现用）；齐全则空', () => {
    const none = imageHostConfigOf({});
    expect(none.missing.sort()).toEqual(['s3Bucket', 's3Credentials', 's3Endpoint', 's3Region']);
    const full = imageHostConfigOf({
      s3Endpoint: 'https://e', s3Region: 'r', s3Bucket: 'b',
      s3Credentials: { accessKeyId: 'a', secretAccessKey: 's' },
    });
    expect(full.missing).toEqual([]);
  });

  it('凭据形状不完整（半填）判缺 s3Credentials', () => {
    const { missing } = imageHostConfigOf({
      s3Endpoint: 'https://e', s3Region: 'r', s3Bucket: 'b',
      s3Credentials: { accessKeyId: 'a' },
    });
    expect(missing).toEqual(['s3Credentials']);
  });
});

describe('009 规则 4 imageIngestPlan（判决单一函数）', () => {
  it('未启用 → ask 或 local（本地保存不依赖图床）', () => {
    expect(imageIngestPlan({ enabled: false })).toBe('ask');
    expect(imageIngestPlan({ enabled: false, pasteAction: 'upload' })).toBe('ask');
    expect(imageIngestPlan({ enabled: false, pasteAction: 'local' })).toBe('local');
  });

  it('出厂 ask；显式动作直连跳过弹窗', () => {
    expect(imageIngestPlan({ enabled: true })).toBe('ask');
    expect(imageIngestPlan({ enabled: true, pasteAction: 'upload' })).toBe('upload');
    expect(imageIngestPlan({ enabled: true, pasteAction: 'local' })).toBe('local');
  });
});

describe('009 规则 5 命名与 URL', () => {
  it('对象键 = 前缀 + 模板展开 + 扩展名（{hash} 取 12 位）', () => {
    const key = buildObjectKey({ s3Prefix: 'img/', s3NameTemplate: '{date}/{hash}' }, {
      date: '2026-10-17', hash: 'abcdef1234567890', mime: 'image/png',
    });
    expect(key).toBe('img/2026-10-17/abcdef123456.png');
  });

  it('{name} 取净化 stem（剥扩展名与非法字符，空则 image）', () => {
    const key = buildObjectKey({ s3Prefix: '', s3NameTemplate: '{name}-{hash}' }, {
      date: '2026-10-17', hash: '000000000001', name: 'D:\\截图\\A.png', mime: 'image/jpeg',
    });
    expect(key).toBe('A-000000000001.jpg');
    const spaced = buildObjectKey({ s3Prefix: '', s3NameTemplate: '{name}' }, {
      date: 'd', hash: 'h', name: 'My Shot.png', mime: 'image/png',
    });
    expect(spaced).toBe('My Shot.png');
    const fallback = buildObjectKey({ s3Prefix: '', s3NameTemplate: '{name}' }, {
      date: 'd', hash: 'h', name: '???.bmp', mime: 'image/bmp',
    });
    expect(fallback).toBe('image.bmp');
    expect(sanitizeName(undefined)).toBe('image');
  });

  it('encodePath：保留集外全 %XX 大写（与 Rust uri_encode 同字符集）；基址剥尾斜杠', () => {
    expect(encodePath('a b/截.png')).toBe('a%20b/%E6%88%AA.png');
    expect(encodePath('A-z0._~_/')).toBe('A-z0._~_/');
    expect(buildPublicUrl('https://cdn.example.local//', 'img/a b.png')).toBe('https://cdn.example.local/img/a%20b.png');
  });
});

describe('009 规则 6 插入片段与转义', () => {
  it('alt 转义 \\ [ ] < >；imageMarkdown 组装', () => {
    expect(escapeAlt('a[b]<c>\\d')).toBe('a\\[b\\]\\<c\\>\\\\d');
    expect(imageMarkdown('shot', 'https://cdn/x.png')).toBe('![shot](https://cdn/x.png)');
    expect(imageMarkdown('a[b]', 'https://cdn/x.png')).toBe('![a\\[b\\]](https://cdn/x.png)');
  });
});

describe('009 规则 4③ findImageRefRange（上传后回填定位）', () => {
  it('原样命中与 preferFrom 精确定位', () => {
    const text = '![a](./x.png)\n\n![b](./y.png "题")\n';
    expect(findImageRefRange(text, './x.png')).toEqual({ from: 5, to: 12 });
    expect(findImageRefRange(text, './y.png')).toEqual({ from: 20, to: 27 });
    // preferFrom 优先：同名引用取光标处
    const dup = '![a](./x.png)\n![b](./x.png)\n';
    expect(findImageRefRange(dup, './x.png', 19)).toEqual({ from: 19, to: 26 });
  });
  it('渲染面编码引用按解码写法命中中文/空格路径', () => {
    const text = '![图](./图片/a b.png)\n';
    expect(findImageRefRange(text, './%E5%9B%BE%E7%89%87/a%20b.png')).toEqual({ from: 5, to: 5 + './图片/a b.png'.length });
  });
  it('角括号形式命中并剥除括号', () => {
    const text = '![图](<./a b.png>)\n';
    expect(findImageRefRange(text, './a%20b.png')).toEqual({ from: 6, to: 6 + './a b.png'.length });
  });
  it('终结符守卫不误配前缀相同的其他引用；找不到返回 null', () => {
    expect(findImageRefRange('![a](./x.png.bak)\n', './x.png')).toBeNull();
    expect(findImageRefRange('正文无图\n', './x.png')).toBeNull();
  });
});

describe('009 规则 3 扩展名单源', () => {
  it('mimeOfPath：七扩展正反查；非图片 null', () => {
    expect(Object.keys(MIME_EXT).sort()).toEqual(
      ['image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp'].sort()
    );
    expect(mimeOfPath('E:\\a\\b\\c.PNG')).toBe('image/png');
    expect(mimeOfPath('/x/shot.jpeg')).toBe('image/jpeg');
    expect(mimeOfPath('/x/a.svg')).toBe('image/svg+xml');
    expect(mimeOfPath('/x/a.txt')).toBeNull();
    expect(mimeOfPath('noext')).toBeNull();
  });

  it('readImageFile：MIME 优先（截图工具 image/png + 文件名 .jpg 错位以 MIME_EXT 认可为准）', async () => {
    const f = new File([new Uint8Array([1, 2, 3])], 'shot.jpg', { type: 'image/png' });
    const r = await readImageFile(f);
    expect(r.mime).toBe('image/png');
    expect(r.name).toBe('shot.jpg');
    expect(Array.from(r.bytes)).toEqual([1, 2, 3]);
  });
});

describe('009 规则 7/8 上传器（put 替身，零网络）', () => {
  // 注入哈希：长度落在前 12 位（hash12 互异），供去重/队列测试区分内容
  const hashByLen = async (b: Uint8Array): Promise<string> =>
    b.length.toString(16).padStart(12, '0').padEnd(64, '0');

  it('AC-3 同内容并发合并：同哈希两次并发 → 单次 put；后到 deduped', async () => {
    const puts: number[] = [];
    const u = createUploader({
      put: async () => { puts.push(1); await sleep(15); return { status: 200, etag: 'E1' }; },
      hashHex: hashByLen,
    });
    const bytes = new Uint8Array(10);
    const [a, b] = await Promise.all([u.upload(bytes, 'image/png', 'a.png', CFG()), u.upload(bytes, 'image/png', 'b.png', CFG())]);
    expect(puts.length).toBe(1);
    // 日期 = 本地今日（未注入 now）；键尾 = 长度哈希 12 位
    expect(a.url.startsWith('https://cdn.example.local/')).toBe(true);
    expect(a.url.endsWith('/00000000000a.png')).toBe(true);
    expect(b.url).toBe(a.url);
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    // 会话内已完成复用：再传同内容不再发 put
    const c = await u.upload(bytes, 'image/png', 'c.png', CFG());
    expect(puts.length).toBe(1);
    expect(c.deduped).toBe(true);
  });

  it('不同内容同键幂等（{hash} 同 → PUT 覆盖自身，etag 更新）', async () => {
    let etagSeq = 0;
    const u = createUploader({
      put: async () => ({ status: 200, etag: `E${++etagSeq}` }),
      hashHex: async () => 'f'.repeat(64),
    });
    const a = await u.upload(new Uint8Array(4), 'image/png', undefined, CFG());
    // 第二次走已完成复用分支（规则 8 会话内结果复用，不发新 put）
    const b = await u.upload(new Uint8Array(6), 'image/png', undefined, CFG());
    expect(a.key).toBe(b.key);
    expect(b.etag).toBe('E1');
  });

  it('规则 7 队列 ≤2 并发（4 个不同内容）', async () => {
    let active = 0;
    let peak = 0;
    const u = createUploader({
      put: async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(12);
        active--;
        return { status: 200, etag: null };
      },
      hashHex: hashByLen,
      now: () => new Date(2026, 9, 17),
    });
    const cfg = CFG();
    const jobs = [4, 5, 6, 7].map(n => u.upload(new Uint8Array(n), 'image/png', undefined, cfg));
    await Promise.all(jobs);
    expect(peak).toBe(UPLOAD_CONCURRENCY);
    expect(UPLOAD_CONCURRENCY).toBe(2);
  });

  it('AC-8 E6003 超 20MB 上传前拒绝（不发起 put）；E6001 不支持的 mime', async () => {
    const put = vi.fn(async () => ({ status: 200, etag: null }));
    const u = createUploader({ put, hashHex: hashByLen });
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    await expect(u.upload(big, 'image/png', 'x.png', CFG())).rejects.toMatchObject({ code: 'E6003' });
    await expect(u.upload(new Uint8Array(4), 'application/zip', 'x.zip', CFG())).rejects.toMatchObject({ code: 'E6001' });
    expect(put).not.toHaveBeenCalled();
  });

  it('E6xxx 错误串包装（Rust 前缀透传；非 E6 串归 E6004 兜底）', async () => {
    const u = createUploader({
      put: async () => { throw new Error('E6005:404:NoSuchBucket'); },
      hashHex: hashByLen,
    });
    await expect(u.upload(new Uint8Array(4), 'image/png', undefined, CFG())).rejects.toBeInstanceOf(UploadError);
    await expect(u.upload(new Uint8Array(5), 'image/png', undefined, CFG())).rejects.toMatchObject({ code: 'E6005' });
    const u2 = createUploader({
      put: async () => { throw new Error('boom'); },
      hashHex: hashByLen,
    });
    await expect(u2.upload(new Uint8Array(6), 'image/png', undefined, CFG())).rejects.toMatchObject({ code: 'E6004' });
  });

  it('put 请求体：内容 base64、键含日期与哈希、地址风格/豁免透传', async () => {
    let seen: Record<string, unknown> | null = null;
    const u = createUploader({
      put: async req => { seen = { ...req }; return { status: 200, etag: 'ET' }; },
      hashHex: hashByLen,
      now: () => new Date(2026, 9, 17),
    });
    const out = await u.upload(new Uint8Array([104, 105]), 'image/png', 'shot.png', CFG({ s3AddressStyle: 'virtual-host', s3AllowInsecure: true }));
    expect(seen!.key).toBe('2026-10-17/000000000002.png');
    expect(seen!.contentBase64).toBe(bytesToBase64(new Uint8Array([104, 105])));
    expect(seen!.addressStyle).toBe('virtual-host');
    expect(seen!.allowInsecure).toBe(true);
    expect(seen!.endpoint).toBe('https://s3.example.local');
    expect(out.key).toBe(seen!.key);
  });
});

describe('009 base64 分块', () => {
  it('已知向量 + 超块路径（>0x8000）', () => {
    expect(bytesToBase64(new Uint8Array([104, 101, 108, 108, 111]))).toBe('aGVsbG8=');
    const big = new Uint8Array(0x8000 + 17);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const dec = atob(bytesToBase64(big));
    expect(dec.length).toBe(big.length);
    expect(dec.charCodeAt(big.length - 1)).toBe(big[big.length - 1]);
  });
});

describe('009 规则 10 渲染面远程图回填', () => {
  const mkImg = (src: string): HTMLImageElement => {
    const img = document.createElement('img');
    img.setAttribute('src', src);
    return img;
  };

  it('host 全等过滤：仅图床基址 host 取回，其余 host 与 data: 不碰（AC-12 零请求）', async () => {
    const root = document.createElement('div');
    const good = mkImg('https://cdn.example.local/a.png');
    const other = mkImg('https://evil.example.local/a.png');
    const inline = mkImg('data:image/png;base64,xx');
    root.append(good, other, inline);
    const gets: string[] = [];
    resolveRemoteImages(root, 'https://cdn.example.local', async url => {
      gets.push(url);
      return { mime: 'image/png', dataBase64: 'AA==', cached: false };
    });
    await sleep(5);
    expect(gets).toEqual(['https://cdn.example.local/a.png']);
    expect(good.src.startsWith('data:image/png;base64,')).toBe(true);
    expect(good.dataset.mdSrc).toBe('https://cdn.example.local/a.png');
    expect(other.getAttribute('src')).toBe('https://evil.example.local/a.png');
    expect(inline.getAttribute('src')).toBe('data:image/png;base64,xx');
  });

  it('端口参与全等；幂等标记二次不再请求', async () => {
    const root = document.createElement('div');
    const img = mkImg('https://cdn.example.local:8443/a.png');
    root.append(img);
    let calls = 0;
    const getImage = async (): Promise<{ mime: string; dataBase64: string }> => {
      calls++;
      return { mime: 'image/png', dataBase64: 'AA==' };
    };
    resolveRemoteImages(root, 'https://cdn.example.local:8443', getImage);
    resolveRemoteImages(root, 'https://cdn.example.local:8443', getImage); // 同步二连（首帧双渲染）
    await sleep(5);
    expect(calls).toBe(1);
    // 非图床基址（端口不同）不取
    const root2 = document.createElement('div');
    root2.append(mkImg('https://cdn.example.local:8443/a.png'));
    resolveRemoteImages(root2, 'https://cdn.example.local', getImage);
    await sleep(5);
    expect(calls).toBe(1);
  });

  it('失败静默：src 保留原样；缓存逐出 → 重渲自然重试（规则 10 口径）', async () => {
    const url = 'https://cdn.example.local/fail-1.png';
    let calls = 0;
    const getImage = async (): Promise<{ mime: string; dataBase64: string }> => {
      calls++;
      throw new Error('E6004:connect:x');
    };
    const p1 = fetchRemoteDataUrl(url, 'https://cdn.example.local', getImage);
    await expect(p1).rejects.toThrow();
    // 逐出后再次取 → 重新发起（受去重约束指 in-flight 内）
    await expect(fetchRemoteDataUrl(url, 'https://cdn.example.local', getImage)).rejects.toThrow();
    expect(calls).toBe(2);
    const root = document.createElement('div');
    const img = mkImg(url);
    root.append(img);
    resolveRemoteImages(root, 'https://cdn.example.local', getImage);
    await sleep(5);
    expect(img.getAttribute('src')).toBe(url); // 失败不打断渲染、原 src 保留（CSP 占位）
    expect(calls).toBe(3);
  });

  it('in-flight 去重：同 URL 并发只发一次', async () => {
    const url = 'https://cdn.example.local/dedupe-1.png';
    let calls = 0;
    const getImage = async (): Promise<{ mime: string; dataBase64: string }> => {
      calls++;
      await sleep(8);
      return { mime: 'image/png', dataBase64: 'AA==' };
    };
    const [a, b] = await Promise.all([
      fetchRemoteDataUrl(url, 'https://cdn.example.local', getImage),
      fetchRemoteDataUrl(url, 'https://cdn.example.local', getImage),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a).toBe('data:image/png;base64,AA==');
  });

  it('hostOf：小写 + 显式端口；非 http(s)/非法返回 null', () => {
    expect(hostOf('https://CDN.Example.LOCAL/a')).toBe('cdn.example.local');
    expect(hostOf('http://x.example:8080/a')).toBe('x.example:8080');
    expect(hostOf('asset://localhost/E%3A%5Ca.png')).toBeNull();
    expect(hostOf('not a url')).toBeNull();
  });
});

// ── 源契约锁（结构与边界不回归：命令注册 / 依赖收口 / CSP 零变更 / app 三触发接线） ──

const read = (p: string): string => readFileSync(resolvePath(__dirname, p), 'utf8');

describe('009 源契约锁', () => {
  it('lib.rs：两条出网命令 + 图片落盘辅助均注册（网络例外边界 = 仅此三条）', () => {
    const lib = read('../src-tauri/src/lib.rs');
    for (const cmd of ['commands::s3::s3_put_object', 'commands::s3::s3_get_image', 'commands::misc::image_write']) {
      expect(lib).toContain(cmd);
    }
  });

  it('Cargo.toml：reqwest 收口（default-features=false + rustls-tls，无原生 TLS）', () => {
    const toml = read('../src-tauri/Cargo.toml');
    expect(toml).toMatch(/reqwest\s*=\s*\{\s*version\s*=\s*"0\.12"\s*,\s*default-features\s*=\s*false\s*,\s*features\s*=\s*\[\s*"rustls-tls"\s*\]/);
  });

  it('CSP 零变更（ADR 016：回填 data: 内联，不开远程 img-src）', () => {
    const conf = read('../src-tauri/tauri.conf.json');
    const m = /img-src [^;]*/.exec(conf);
    expect(m?.[0]).toBe("img-src 'self' data: asset: http://asset.localhost");
  });

  it('app.ts 三触发接线：贴图/拖入拦截、右键（IR 回调 + 源码光标 + 分屏渲染图）、「上传中…」格', () => {
    const app = read('../src/shell/app.ts');
    expect(app).toContain('clipboardImageOf(dt)');
    expect(app).toContain('dropImagesIntoMd(paths)');
    expect(app).toContain('onUploadImage: ref => uploadLocalRef(tab, ref)');
    expect(app).toContain('canUploadImage: ihEnabled');
    expect(app).toContain('localImageRefAt(mview)');
    expect(app).toContain("dataset.mdSrc ?? ''");
    expect(app).toContain("const uploadCell = uploadActive > 0");
    expect(app).toContain('imageIngestPlan({');
    expect(app).toContain('askImageIngest');
  });

  it('工具独立面板：图床行 + 凭据掩码（password）+ 清除凭据 + 保存收集', () => {
    const app = read('../src/shell/app.ts');
    expect(app).not.toContain("card('set.grpImageHost'");
    expect(app).toContain("function openImageHost()");
    expect(app).toContain("action: 'tools.imageHost'");
    expect(app).toContain('ihSk.type = ');
    expect(app).toContain("'password'");
    expect(app).toContain('s3Credentials: ak && ihSk.value ? { accessKeyId: ak, secretAccessKey: ihSk.value } : undefined');
  });

  it('凭据仅当前会话：设置落盘统一剔除，启动时清除旧版明文字段', () => {
    const app = read('../src/shell/app.ts');
    expect(app).toContain('settingsSave as settingsSaveRaw');
    expect(app).toContain('delete persisted.s3Credentials');
    // 验收缺陷 D1：settingsLoad 可能解析为 null（后端 settings.json 缺失时曾返回 null），
    // 契约同步为可选链写法——语义不变（启动即剔除旧版明文凭据并重写）。
    expect(app).toContain('if (loadedSettings?.s3Credentials) settingsSave(settings);');
    expect(app).not.toContain('settingsSaveRaw(settings)');
  });

  it('Settings 契约：图床平铺键齐全（含启用开关与粘贴动作）', () => {
    const ipc = read('../src/common/ipc.ts');
    for (const key of [
      'imageHostEnabled?', 's3Endpoint?', 's3Region?', 's3Bucket?', 's3Credentials?', 'publicBaseUrl?',
      's3Prefix?', 's3NameTemplate?', 's3AddressStyle?', 's3AllowInsecure?', 'pasteImageAction?',
    ]) {
      expect(ipc).toContain(key);
    }
  });

  it('livepreview：上传入口可见性闸（未启用不出现）', () => {
    const lp = read('../src/markdown-view/livepreview.ts');
    expect(lp).toContain('canUploadImage?.() ?? true');
  });

  it('i18n：ctx.uploadImage 与 ih.* / set.ih* 双语键', () => {
    const zh = read('../src/common/i18n.ts');
    expect(zh).toContain("'ctx.uploadImage': '上传图片到图床'");
    expect(zh).toContain("'ih.uploading': '上传中…'");
    expect(zh).toContain("'act.imageHost': '图床…'");
    expect(zh).toContain("'act.imageHost': 'Image host…'");
    expect(zh).toContain("'ctx.uploadImage': 'Upload image to image host'");
    expect(zh).toContain("'ih.uploading': 'Uploading…'");
  });
});
