import fs from 'node:fs';
import path from 'node:path';

// 最小自造语料，避免依赖用户文件、外部下载或新增 ZIP 库。
function zip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const filename = Buffer.from(name), data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
    locals.push(local, filename, data); central.push(record, filename); offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function pdf() {
  const stream = 'BT /F1 16 Tf 40 100 Td (ZiEdit release fixture) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  return text + `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
export function releaseFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  // md 用 CRLF 行尾：Windows 常见形态，发布门据此同时守住「渲染入口按 LF 解析」的展示契约。
  // Office 夹具（批 2/5/6 后）：xlsx 为完整 OPC 包（calamine 需 _rels/.rels 与 rel Type），
  // 含日期/百分比格式化格与公式格——发布门同时守住「显示值口径」；docx 走富预览默认路由。
  const xlsxTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
  const rootRels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const types = { txt: 'ZiEdit 中文 text\nline two\n', md: '# ZiEdit\r\n\r\n中文 **Markdown**\r\n\r\n| A | B |\r\n|---|---|\r\n|1|2|\r\n', csv: 'Name,Value\n中文,42\n', pdf: pdf(),
    png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42jP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=', 'base64'),
    // docx 为完整 OPC 包（docx-preview 渲染层比 Rust 提取器严格：需 [Content_Types] + rels）
    docx: zip({
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
      'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>ZiEdit 中文 Office</w:t></w:r></w:p><w:p><w:r><w:t>第二段 富预览验收</w:t></w:r></w:p></w:body></w:document>' }),
    xlsx: zip({
      '[Content_Types].xml': xlsxTypes, '_rels/.rels': rootRels,
      'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="首表" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      'xl/styles.xml': '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="3"><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="10" applyNumberFormat="1"/><xf numFmtId="0"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ZiEdit 中文</t></is></c><c r="B1" s="0"><v>45292</v></c><c r="C1" s="1"><v>0.4512</v></c><c r="D1" s="2"><f>B1*2</f><v>90584</v></c></row></sheetData></worksheet>' }),
    pptx: zip({ '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
      'ppt/slides/slide1.xml': '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>幻灯片中文</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' }),
    ods: zip({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
      'META-INF/manifest.xml': '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
      'content.xml': '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="ODS表"><table:table-row><table:table-cell office:value-type="string"><text:p>ODS中文</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="7"/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>' }),
    doc: fs.readFileSync(new URL('../../src-tauri/src/ooxml/fixtures/nested_tables.doc', import.meta.url)) };
  const files = {};
  for (const [type, content] of Object.entries(types)) { const file = path.join(dir, '中文 空格.' + type); fs.writeFileSync(file, content); files[type] = file; }
  return files;
}
