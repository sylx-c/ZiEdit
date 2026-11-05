#!/usr/bin/env python3
"""Record exact NSIS tool/plugin notices used by the Windows installer; offline check."""
import pathlib,urllib.request,hashlib,json,sys
root=pathlib.Path(__file__).resolve().parent.parent
out=root/'compliance/third-party-sources/windows-installer'
sha=lambda b:hashlib.sha256(b).hexdigest()
def fetch(url):
 with urllib.request.urlopen(url,timeout=90) as r:return r.read()
if '--check' not in sys.argv:
 if out.exists():raise SystemExit('Review existing installer evidence first')
 cache=pathlib.Path(sys.argv[1]);files=[]
 sources=[('NSIS-COPYING.txt','https://raw.githubusercontent.com/nsis-dev/nsis/a4ba28e60bd9e7c271cd2bfc1558889ce3355653/COPYING'),('tauri-utils-LICENSE_MIT','https://raw.githubusercontent.com/tauri-apps/nsis-tauri-utils/13d9edd27b69310e108d6fbd49f90992f8a05390/LICENSE_MIT'),('tauri-utils-LICENSE_APACHE-2.0','https://raw.githubusercontent.com/tauri-apps/nsis-tauri-utils/13d9edd27b69310e108d6fbd49f90992f8a05390/LICENSE_APACHE-2.0')]
 data=[(n,u,fetch(u)) for n,u in sources]
 local_copy=(cache/'COPYING').read_bytes()
 if data[0][2].replace(b'\r\n',b'\n')!=local_copy.replace(b'\r\n',b'\n'):raise SystemExit('NSIS COPYING text does not match fixed source')
 data.append(('NSIS-COPYING-packaged.txt','local NSIS3.13 distribution; line endings differ only',local_copy))
 plugin=(cache/'Plugins/x86-unicode/additional/nsis_tauri_utils.dll').read_bytes()
 if hashlib.sha1(plugin).hexdigest()!='75197fee3c6a814fe035788d1c34ead39349b860':raise SystemExit('Unreviewed Tauri NSIS plugin')
 out.mkdir(parents=True)
 for name,url,b in data:(out/name).write_bytes(b);files.append(dict(path=name,bytes=len(b),sha256=sha(b),sourceURL=url))
 toolfiles=['makensis.exe','Bin/makensis.exe','Stubs/zlib-x86-unicode','Plugins/x86-unicode/NSISdl.dll','Plugins/x86-unicode/StartMenu.dll','Plugins/x86-unicode/System.dll','Plugins/x86-unicode/nsDialogs.dll','Plugins/x86-unicode/additional/nsis_tauri_utils.dll']
 tools=[]
 for name in toolfiles:
  b=(cache/name).read_bytes();tools.append(dict(path=name,bytes=len(b),sha256=sha(b)))
 manifest=dict(schemaVersion=1,nsisVersion='3.13',nsisSourceCommit='a4ba28e60bd9e7c271cd2bfc1558889ce3355653',selectedCompressor='zlib',nsisLicense='Zlib; full upstream COPY includes other compressor licenses, not selected',pluginVersion='0.5.3',pluginSourceCommit='13d9edd27b69310e108d6fbd49f90992f8a05390',pluginSelectedLicense='MIT',method='Fixed source COPYING compared after CRLF/LF normalization; both original byte variants retained. official Tauri plugin SHA1 pinned by tauri-cli2.12.2 upstream bundle source. Tool/stub/plugin files separately hashed. Zlib compressor chosen explicitly, no CPL LZMA compressor included.',files=files,tools=tools,review=[])
 (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
m=json.loads((out/'manifest.json').read_text())
for item in m['files']:
 b=(out/item['path']).read_bytes()
 if len(b)!=item['bytes'] or sha(b)!=item['sha256']:raise SystemExit('Installer notice drift')
print('NSIS/plugin original notices verified')
