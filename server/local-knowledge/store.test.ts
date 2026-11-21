import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { createLocalKnowledgeStore } from "./index";

let temp: string;
beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "local-knowledge-test-")); });
afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function zip(files: Record<string, string | Buffer>, compressed = false): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const body = compressed ? deflateRawSync(data) : data;
    const crc = crc32(data), method = compressed ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const record = Buffer.concat([local, filename, body]);
    locals.push(record);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(filename.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, filename]));
    offset += record.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function docx(paragraphs: string[]): Buffer {
  return zip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`,
  });
}
async function xlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("运行记录");
  sheet.getCell("A2").value = "阀门巡检周期";
  sheet.getCell("B2").value = "每周一次";
  sheet.getCell("A3").value = "蒸汽压力";
  sheet.getCell("B3").value = 42;
  sheet.getCell("A4").value = "安全操作规程";
  sheet.getCell("D4").value = "每周一次";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
function pdf(text: string, pageCount = 1): Buffer {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array(pageCount).fill("3 0 R").join(" ")}] /Count ${pageCount} >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let content = "%PDF-1.4\n", offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(content));
    content += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const start = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) content += `${String(offset).padStart(10, "0")} 00000 n \n`;
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(content);
}
function input(name: string, data: Buffer) { return { name, dataBase64: data.toString("base64") }; }

describe("local knowledge store", () => {
  it("requires an absolute root, and list/search never create directories", async () => {
    expect(() => createLocalKnowledgeStore("relative")).toThrow();
    const root = path.join(temp, "not-created");
    const store = createLocalKnowledgeStore(root);
    expect(await store.list()).toEqual([]);
    expect(await store.search("锅炉压力")).toEqual([]);
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("indexes real DOCX text, copies upload bytes, and deletes only the owned copy", async () => {
    const root = path.join(temp, "library"), source = path.join(temp, "original.docx");
    const original = docx(["这里是第一段", "锅炉压力应保持稳定，定期检查安全阀。"]);
    await fs.writeFile(source, original);
    const store = createLocalKnowledgeStore(root);
    const doc = await store.importFile(input("original.docx", await fs.readFile(source)));
    expect(doc.status).toBe("indexed");
    expect(doc.segmentCount).toBe(2);
    expect(await store.list()).toEqual([doc]);
    const found = await store.search("请问锅炉压力应如何保持？");
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({ fileId: doc.id, name: "original.docx", location: "段落 2", text: "锅炉压力应保持稳定，定期检查安全阀。" });
    expect(await store.search("")).toEqual([]);
    expect(await store.search("有哪些内容？")).toEqual([]);
    expect(await store.search("所有文件资料内容")).toEqual([]);
    expect(await store.search("火星探测器燃料")).toEqual([]);
    expect(await store.search(`锅炉压力${"？".repeat(1001)}`)).toHaveLength(1);
    await expect(store.search("a".repeat(4001))).rejects.toThrow(/4000/);
    const copy = path.join(root, "assistant-data", `${doc.id}.docx`);
    expect(await fs.readFile(copy)).toEqual(original);
    await store.remove(doc.id);
    expect(await store.list()).toEqual([]);
    await expect(fs.lstat(copy)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(source)).toEqual(original);
  });
  it("keeps internal Word line breaks within the correct paragraph", async () => {
    const store = createLocalKnowledgeStore(path.join(temp, "root"));
    const bytes = docx(["first paragraph", "lineone</w:t><w:br/><w:br/><w:t>linetwo", "final paragraph"]);
    await store.importFile(input("breaks.docx", bytes));
    const middle = await store.search("linetwo");
    expect(middle[0].location).toBe("段落 2");
    expect(middle[0].text).toBe("lineone\n\nlinetwo");
    const last = await store.search("final paragraph");
    expect(last[0].location).toBe("段落 3");
  });
  it("extracts XLSX sheet/row and PDF page; blank PDF reports no OCR", async () => {
    const store = createLocalKnowledgeStore(path.join(temp, "root"));
    const spreadsheet = await store.importFile(input("工况.xlsx", await xlsx()));
    const row = await store.search("阀门巡检周期");
    expect(row).toEqual([{ fileId: spreadsheet.id, name: "工况.xlsx", location: "工作表「运行记录」第 2 行", text: "A2：阀门巡检周期\tB2：每周一次" }]);
    expect((await store.search("安全操作规程"))[0].text).toBe("A4：安全操作规程\tD4：每周一次");
    const document = await store.importFile(input("manual.pdf", pdf("The boiler pressure is 2 bar")));
    const match = await store.search("boiler pressure");
    expect(match).toHaveLength(1);
    expect(match[0].fileId).toBe(document.id);
    expect(match[0].location).toBe("第 1 页");
    expect(match[0].text).toContain("boiler pressure");
    const blank = await store.importFile(input("scan.pdf", pdf("")));
    expect(blank.status).toBe("empty");
    expect(blank.segmentCount).toBe(0);
    expect(blank.warning).toContain("OCR");
  });
  it("rejects unsupported, disguised, oversized and invalid uploads and malicious ZIPs", async () => {
    const store = createLocalKnowledgeStore(path.join(temp, "root"));
    await expect(store.importFile(input("../bad.docx", docx([])))).rejects.toThrow();
    await expect(store.importFile(input("evil.docm", docx([])))).rejects.toThrow();
    await expect(store.importFile(input("wrong.xlsx", pdf("hello")))).rejects.toThrow();
    await expect(store.importFile(input("wrong.pdf", docx([])))).rejects.toThrow();
    await expect(store.importFile({ name: "x.pdf", dataBase64: "not base64!" })).rejects.toThrow();
    await expect(store.importFile(input("large.pdf", Buffer.alloc(10 * 1024 * 1024 + 1)))).rejects.toThrow();
    const bomb = zip({ "[Content_Types].xml": "x", "word/document.xml": Buffer.alloc(16 * 1024 * 1024 + 1, 65) }, true);
    await expect(store.importFile(input("bomb.docx", bomb))).rejects.toThrow(/超过限制/);
    const traversal = zip({ "[Content_Types].xml": "x", "word/document.xml": "x", "../outside": "x" });
    await expect(store.importFile(input("bad.docx", traversal))).rejects.toThrow();
    const sparse = zip({ "[Content_Types].xml": "x", "xl/workbook.xml": "x", "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1000000"><c r="A1000000"/></row></sheetData></worksheet>` });
    await expect(store.importFile(input("sparse.xlsx", sparse))).rejects.toThrow(/超过限制/);
    const merged = zip({ "[Content_Types].xml": "x", "xl/workbook.xml": "x", "xl/worksheets/sheet1.xml": `<worksheet><mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>` });
    await expect(store.importFile(input("merged.xlsx", merged))).rejects.toThrow(/超过限制/);
    await expect(store.importFile(input("pages.pdf", pdf("hello", 201)))).rejects.toThrow(/页数超过限制/);
    const manySheets = new ExcelJS.Workbook();
    for (let i = 0; i < 33; i++) manySheets.addWorksheet(`Sheet${i}`);
    await expect(store.importFile(input("sheets.xlsx", Buffer.from(await manySheets.xlsx.writeBuffer())))).rejects.toThrow(/工作表数超过限制/);
    const many = docx(Array.from({ length: 3001 }, (_, i) => `测试段落${i}`));
    await expect(store.importFile(input("many.docx", many))).rejects.toThrow(/片段数/);
    expect(await store.list()).toEqual([]);
  });
  it("preserves all indexes across concurrent independent store instances", async () => {
    const root = path.join(temp, "root"), a = createLocalKnowledgeStore(root), b = createLocalKnowledgeStore(root);
    const bytes = docx(["设备巡检记录" ]);
    const docs = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).importFile(input(`${i}.docx`, bytes))));
    expect(new Set(docs.map(d => d.id)).size).toBe(12);
    expect(await a.list()).toHaveLength(12);
    await Promise.all(docs.slice(0, 6).flatMap(d => [a.remove(d.id), b.remove(d.id)]));
    expect((await b.list()).map(d => d.id).sort()).toEqual(docs.slice(6).map(d => d.id).sort());
    expect(await b.search("设备巡检记录")).toHaveLength(3);
  });
  it("rejects traversal IDs, linked roots, linked data dirs and linked copies", async () => {
    const root = path.join(temp, "root");
    const outside = path.join(temp, "outside");
    await fs.mkdir(outside);
    const a = createLocalKnowledgeStore(root);
    await expect(a.remove("../../outside/file")).rejects.toThrow();
    try { await fs.symlink(outside, root, "junction"); } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) return;
      throw error;
    }
    await expect(a.list()).rejects.toThrow(/符号链接/);
    await expect(a.importFile(input("blocked.docx", docx(["禁止写入链接"])))).rejects.toThrow(/符号链接/);
    if (process.platform === "win32") await fs.rmdir(root); else await fs.unlink(root);
    await fs.mkdir(root);
    await fs.symlink(outside, path.join(root, "assistant-data"), "junction");
    await expect(a.list()).rejects.toThrow(/符号链接/);
    await expect(a.importFile(input("blocked.docx", docx(["禁止写入链接"])))).rejects.toThrow(/符号链接/);
    expect(await fs.readdir(outside)).toEqual([]);
    if (process.platform === "win32") await fs.rmdir(path.join(root, "assistant-data"));
    else await fs.unlink(path.join(root, "assistant-data"));
    const doc = await a.importFile(input("a.docx", docx(["普通原文内容"])));
    const copy = path.join(root, "assistant-data", `${doc.id}.docx`);
    const source = path.join(outside, "source.docx");
    await fs.writeFile(source, "original");
    await fs.unlink(copy);
    try { await fs.symlink(source, copy, "file"); } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) return;
      throw error;
    }
    await expect(a.remove(doc.id)).rejects.toThrow(/普通文件/);
    expect(await fs.readFile(source, "utf8")).toBe("original");
    expect(await a.list()).toHaveLength(1);
  });
});
