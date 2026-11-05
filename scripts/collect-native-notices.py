#!/usr/bin/env python3
"""Retain fixed native component notices; --check is offline and fails on drift."""
import pathlib, urllib.request, tarfile, zipfile, io, hashlib, json, re, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = ROOT / 'compliance/third-party-sources'
sha = lambda data: hashlib.sha256(data).hexdigest()
def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as response: return response.read()
def emit(out, files, name, data, source):
    p = pathlib.PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts: raise ValueError(name)
    target = out.joinpath(*p.parts); target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
    files.append(dict(path=name, bytes=len(data), sha256=sha(data), source=source))
def ring(cache):
    out = BASE / 'ring-notices'
    if out.exists(): raise SystemExit('Review existing ring output before regeneration')
    blocks = (ROOT/'src-tauri/Cargo.lock').read_text().split('[[package]]')[1:]
    block = next(b for b in blocks if re.search(r'^name = "ring"$',b,re.M) and re.search(r'^version = "0.17.14"$',b,re.M))
    digest = re.search(r'^checksum = "([a-f0-9]{64})"$',block,re.M)[1]
    url='https://static.crates.io/crates/ring/ring-0.17.14.crate'; archive=fetch(url)
    if sha(archive)!=digest: raise SystemExit('ring archive differs from Cargo.lock')
    inventory=[]; selected=[]; seen=set()
    legal=re.compile(r'copyright|licen[cs]e|SPDX|permission|redistribut|public[ -]domain|all rights reserved|attribution|authors|©',re.I)
    with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as tf:
        for member in tf.getmembers():
            p=pathlib.PurePosixPath(member.name)
            if p.is_absolute() or '..' in p.parts or p.parts[0]!='ring-0.17.14': raise SystemExit('Unsafe ring archive')
            if member.isdir(): continue
            if not member.isfile(): raise SystemExit('Unsupported ring member')
            rel=pathlib.PurePosixPath(*p.parts[1:]).as_posix()
            if rel in seen: raise SystemExit('Duplicate ring member')
            seen.add(rel); data=tf.extractfile(member).read()
            if cache.joinpath(*p.parts[1:]).read_bytes()!=data: raise SystemExit('Modified ring cache: '+rel)
            rec=dict(path=rel,bytes=len(data),sha256=sha(data));inventory.append(rec)
            try: text=data.decode('utf-8-sig')
            except UnicodeDecodeError: text=''
            if legal.search(text) or re.search('license|copying|copyright|notice|authors',p.name,re.I): selected.append((rel,data))
    files=[]; emit(out,files,'ring-0.17.14.crate',archive,url)
    for rel,data in selected: emit(out,files,'files/'+rel,data,url+'#'+rel)
    manifest=dict(schemaVersion=1,name='ring',version='0.17.14',sourceURL=url,archiveSHA256=digest,method='All archive members byte-compared with registry cache; complete legal-marker source files retained, including embedded and non-leading notices. Full source archive retained as fallback; selected files are a conservative evidence superset, not a linkage assertion.',archiveFiles=inventory,files=files,review=[])
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def sdk(cache):
    out=BASE/'webview2-loader'
    if out.exists(): raise SystemExit('Review existing SDK output before regeneration')
    url='https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.3800.47/microsoft.web.webview2.1.0.3800.47.nupkg'
    archive=fetch(url); expected='56c9f26bdd07916a2d1949fb58a5c7e434dfa1173577dca879206050c4e718db'
    if sha(archive)!=expected: raise SystemExit('SDK archive digest mismatch')
    mappings=[]
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        for arch in ['arm64','x64','x86']:
            for leaf in ['WebView2Loader.dll','WebView2LoaderStatic.lib']:
                member=next(n for n in z.namelist() if '/'+arch+'/' in n and n.endswith('/'+leaf))
                candidates=list(cache.rglob(leaf)); match=[p for p in candidates if arch in p.parts and p.read_bytes()==z.read(member)]
                if len(match)!=1: raise SystemExit('SDK/cache mismatch '+arch+'/'+leaf)
                data=z.read(member); mappings.append(dict(architecture=arch,path=member,cachePath=match[0].relative_to(cache).as_posix(),bytes=len(data),sha256=sha(data)))
        files=[]
        for member in ['LICENSE.txt','NOTICE.txt','Microsoft.Web.WebView2.nuspec']: emit(out,files,member,z.read(member),url+'#'+member)
    emit(out,files,'source-version-evidence.rs.txt',fetch('https://raw.githubusercontent.com/wravery/webview2-rs/edc2caf886175ccaebe86078c9cfe1ae2a187328/crates/update-bindings/src/main.rs'),'https://github.com/wravery/webview2-rs/blob/edc2caf886175ccaebe86078c9cfe1ae2a187328/crates/update-bindings/src/main.rs')
    manifest=dict(schemaVersion=1,name='Microsoft.Web.WebView2 loader',version='1.0.3800.47',license='BSD-3-Clause',archiveURL=url,archiveSHA256=expected,archiveBytes=len(archive),crate='webview2-com-sys 0.39.1',crateRevision='edc2caf886175ccaebe86078c9cfe1ae2a187328',loaderFiles=mappings,files=files,review=[],scope='Exact six SDK loader DLL/static LIB files match the crate. LICENSE and NOTICE cover their free redistribution. This is not a claim that the separate installed WebView2 Runtime or all SDK implementation sources are open source.')
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def check():
    for group in ['ring-notices','webview2-loader']:
        out=BASE/group; manifest=json.loads((out/'manifest.json').read_text(encoding='utf-8'))
        if manifest['review']: raise SystemExit('Unreviewed native evidence')
        if group=='ring-notices':
            archive=(out/'ring-0.17.14.crate').read_bytes()
            if sha(archive)!=manifest['archiveSHA256']:raise SystemExit('Changed ring source')
            with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as tf:
                for item in manifest['archiveFiles']:
                    if sha(tf.extractfile('ring-0.17.14/'+item['path']).read())!=item['sha256']:raise SystemExit('Changed ring archive')
        for item in manifest['files']:
            p=(out/item['path']).resolve()
            if not p.is_relative_to(out.resolve()):raise SystemExit('Unsafe evidence path')
            data=p.read_bytes()
            if len(data)!=item['bytes'] or sha(data)!=item['sha256']:raise SystemExit('Changed evidence '+str(p))
        print(group+': '+str(len(manifest['files']))+' retained files verified')
if '--check' in sys.argv: check()
else:
    if len(sys.argv)!=2: raise SystemExit('Usage: collect-native-notices.py CARGO_REGISTRY_SRC_ROOT | --check')
    cache=pathlib.Path(sys.argv[1]); ring(cache/'ring-0.17.14');sdk(cache/'webview2-com-sys-0.39.1');check()
