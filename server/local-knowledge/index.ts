import path from "node:path";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as yauzl from "yauzl";
import mammoth from "mammoth";
import ExcelJS from "exceljs";

export interface LocalDocument {
  id: string;
  name: string;
  importedAt: string;
  status: "indexed" | "empty";
  segmentCount: number;
  warning?: string;
}
export interface LocalMatch {
  fileId: string;
  name: string;
  location: string;
  text: string;
}
type Extension = "docx" | "xlsx" | "pdf";
type Segment = { location: string; text: string };
type Manifest = { version: 1; document: LocalDocument; extension: Extension; segments: Segment[] };

const DATA_DIR = "assistant-data";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2048;
const MAX_ZIP_EXPANDED = 50 * 1024 * 1024;
const MAX_ZIP_ENTRY = 16 * 1024 * 1024;
const MAX_SEGMENTS = 3000;
const MAX_TEXT = 2_000_000;
const MAX_SEGMENT_TEXT = 12_000;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_PDF_PAGES = 200;
const MAX_PDF_ITEMS = 100_000;
const MAX_SHEETS = 32;
const MAX_ROWS = 10_000;
const MAX_CELLS = 100_000;
const MAX_COL = 512;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}
function validName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 255 &&
    name !== "." && name !== ".." && !/[\\/:\x00-\x1f\x7f]/.test(name);
}
function isRegular(stat: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return stat.isFile() && !stat.isSymbolicLink();
}
function boundedPath(dir: string, name: string): string {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error("非法文件名");
  }
  const result = path.resolve(dir, name);
  if (path.dirname(result) !== dir) throw new Error("路径越界");
  return result;
}
async function checkDirectory(dir: string, create: boolean): Promise<boolean> {
  try {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("知识库目录不能是符号链接、junction 或普通文件");
    return true;
  } catch (e) {
    if (errorCode(e) !== "ENOENT") throw e;
    if (!create) return false;
    try { await fs.mkdir(dir); } catch (mkdirError) {
      if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
    }
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("知识库目录不能是符号链接、junction 或普通文件");
    return true;
  }
}
async function readRegular(file: string, max: number): Promise<Buffer> {
  const stat = await fs.lstat(file);
  if (!isRegular(stat) || stat.size > max) throw new Error("索引不是安全的普通文件或过大");
  // O_NOFOLLOW is available on POSIX; on Windows lstat also rejects junctions/links.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
  const handle = await fs.open(file, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > max) throw new Error("索引不是安全的普通文件或过大");
    return await handle.readFile();
  } finally { await handle.close(); }
}
function parseManifest(bytes: Buffer, id: string): Manifest {
  let m: Manifest;
  try { m = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("本地索引已损坏"); }
  const d = m?.document;
  if (m?.version !== 1 || !d || d.id !== id || !UUID.test(id) || !validName(d.name) ||
      typeof d.importedAt !== "string" || !Number.isFinite(Date.parse(d.importedAt)) ||
      (d.status !== "indexed" && d.status !== "empty") || !Number.isInteger(d.segmentCount) ||
      (d.warning !== undefined && (typeof d.warning !== "string" || d.warning.length > 2000)) ||
      !["docx", "xlsx", "pdf"].includes(m.extension) || !Array.isArray(m.segments) ||
      m.segments.length > MAX_SEGMENTS || d.segmentCount !== m.segments.length ||
      (d.status === "empty") !== (m.segments.length === 0)) throw new Error("本地索引已损坏");
  let size = 0;
  for (const segment of m.segments) {
    if (!segment || typeof segment.location !== "string" || segment.location.length > 500 ||
        typeof segment.text !== "string" || segment.text.length > MAX_SEGMENT_TEXT) throw new Error("本地索引已损坏");
    size += segment.text.length;
  }
  if (size > MAX_TEXT) throw new Error("本地索引过大");
  return m;
}
function makeSegments() {
  const segments: Segment[] = [];
  let characters = 0;
  return {
    segments,
    add(location: string, text: string) {
      if (!text.trim()) return;
      characters += text.length;
      if (characters > MAX_TEXT) throw new Error("提取文字超过限制");
      const count = Math.ceil(text.length / MAX_SEGMENT_TEXT);
      if (segments.length + count > MAX_SEGMENTS) throw new Error("文档片段数超过限制");
      for (let i = 0; i < count; i++) {
        segments.push({ location: count > 1 ? `${location}（第 ${i + 1} 部分）` : location,
          text: text.slice(i * MAX_SEGMENT_TEXT, (i + 1) * MAX_SEGMENT_TEXT) });
      }
    },
  };
}
function columnNumber(ref: string): number {
  const col = /^([A-Za-z]+)/.exec(ref)?.[1];
  if (!col || col.length > 3) return MAX_COL + 1;
  let n = 0;
  for (const letter of col.toUpperCase()) n = n * 26 + letter.charCodeAt(0) - 64;
  return n;
}
function inspectWorksheetXml(xml: string): number {
  // Reject oversized sparse coordinates before ExcelJS allocates its workbook model.
  let cells = 0, rows = 0, mergedCells = 0;
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?row\b([^>]*)>/g)) {
    if (++rows > MAX_ROWS) throw new Error("Excel 行数超过限制");
    const n = /\br\s*=\s*["'](\d+)["']/.exec(match[1]);
    if (n && Number(n[1]) > MAX_ROWS) throw new Error("Excel 行数超过限制");
  }
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?c\b([^>]*)>/g)) {
    if (++cells > MAX_CELLS) throw new Error("Excel 单元格数超过限制");
    const ref = /\br\s*=\s*["']([A-Za-z]+)(\d+)["']/.exec(match[1]);
    if (ref && (Number(ref[2]) > MAX_ROWS || columnNumber(ref[1]) > MAX_COL)) throw new Error("Excel 单元格位置超过限制");
  }
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?mergeCell\b([^>]*)>/g)) {
    const ref = /\bref\s*=\s*["']([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)["']/.exec(match[1]);
    if (!ref) throw new Error("Excel 合并区域无效");
    const c1 = columnNumber(ref[1]), r1 = Number(ref[2]), c2 = columnNumber(ref[3]), r2 = Number(ref[4]);
    if (c1 < 1 || r1 < 1 || c2 > MAX_COL || r2 > MAX_ROWS || c2 < c1 || r2 < r1) throw new Error("Excel 合并区域超过限制");
    mergedCells += (c2 - c1 + 1) * (r2 - r1 + 1);
    if (mergedCells > MAX_CELLS) throw new Error("Excel 合并区域超过限制");
  }
  return cells + mergedCells;
}
async function validateZip(data: Buffer, ext: "docx" | "xlsx"): Promise<void> {
  if (data.length < 4 || !data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new Error("文件签名与扩展名不匹配");
  }
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (err, value) => {
      if (err || !value) reject(err || new Error("无法打开 ZIP")); else resolve(value);
    });
  });
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let total = 0, entries = 0, sheets = 0, worksheetCells = 0;
    const names = new Set<string>();
    const fail = (err: unknown) => {
      if (finished) return;
      finished = true;
      zip.close();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (finished) return;
      const required = ext === "docx" ? "word/document.xml" : "xl/workbook.xml";
      if (!names.has("[Content_Types].xml") || !names.has(required)) return fail(new Error("不是有效的对应 Office 文档"));
      finished = true;
      resolve();
    });
    zip.on("entry", entry => {
      try {
        if (++entries > MAX_ZIP_ENTRIES || entry.uncompressedSize > MAX_ZIP_ENTRY ||
            entry.uncompressedSize < 0 || total + entry.uncompressedSize > MAX_ZIP_EXPANDED) throw new Error("ZIP 解压规模超过限制");
        const name: string = entry.fileName;
        if (!name || name.includes("\\") || name.startsWith("/") || name.includes("\0") ||
            name.split("/").some(p => p === "." || p === "..") || names.has(name) || /^[A-Za-z]:/.test(name)) {
          throw new Error("ZIP 条目路径不安全或重复");
        }
        if ((entry.generalPurposeBitFlag & 1) || ![0, 8].includes(entry.compressionMethod)) throw new Error("不支持加密或该压缩格式");
        if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error("ZIP 中不允许符号链接");
        if (/vbaproject\.bin$/i.test(name)) throw new Error("不支持含宏的文档");
        names.add(name);
        const worksheet = ext === "xlsx" && /^xl\/worksheets\/[^/]+\.xml$/i.test(name);
        if (worksheet && ++sheets > MAX_SHEETS) throw new Error("Excel 工作表数超过限制");
        if (name.endsWith("/")) { zip.readEntry(); return; }
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) return fail(err || new Error("ZIP 条目无法读取"));
          let actual = 0;
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => {
            actual += chunk.length;
            if (actual > entry.uncompressedSize || actual > MAX_ZIP_ENTRY || total + actual > MAX_ZIP_EXPANDED) {
              stream.destroy(); fail(new Error("ZIP 实际展开规模超过限制")); return;
            }
            if (worksheet) chunks.push(chunk);
          });
          stream.on("error", fail);
          stream.on("end", () => {
            if (finished) return;
            try {
              if (actual !== entry.uncompressedSize) throw new Error("ZIP 条目大小不匹配");
              total += actual;
              if (worksheet) {
                worksheetCells += inspectWorksheetXml(Buffer.concat(chunks).toString("utf8"));
                if (worksheetCells > MAX_CELLS) throw new Error("Excel 单元格数超过限制");
              }
              zip.readEntry();
            } catch (error) { fail(error); }
          });
        });
      } catch (error) { fail(error); }
    });
    zip.readEntry();
  });
}
function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return Number.isFinite(value.valueOf()) ? value.toISOString() : "";
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map(x => x.text).join("");
    if ("text" in value && typeof value.text === "string") return value.text;
    // A formula is never executed; only a value already cached in the uploaded file is used.
    if ("result" in value && value.result != null) return cellText(value.result as ExcelJS.CellValue);
  }
  return "";
}
type WordNode = { type?: string; value?: unknown; breakType?: string; children?: WordNode[] };
function collectWordParagraphs(document: WordNode, add: (location: string, text: string) => void): void {
  const stack: WordNode[] = [document];
  let paragraph = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "paragraph") {
      paragraph++;
      const children = [...(node.children || [])].reverse();
      let text = "";
      while (children.length) {
        const child = children.pop()!;
        if (child.type === "text" && typeof child.value === "string") text += child.value;
        else if (child.type === "tab") text += "\t";
        else if (child.type === "break") text += "\n";
        else if (child.children) for (let i = child.children.length - 1; i >= 0; i--) children.push(child.children[i]);
        if (text.length > MAX_TEXT) throw new Error("提取文字超过限制");
      }
      add(`段落 ${paragraph}`, text);
    } else if (node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
  }
}
async function extract(data: Buffer, extension: Extension): Promise<{ segments: Segment[]; warning?: string }> {
  const out = makeSegments();
  if (extension === "docx") {
    await validateZip(data, extension);
    // Capture the parsed document tree before HTML rendering. Unlike splitting
    // raw text on blank lines, this preserves both actual paragraphs and breaks.
    await mammoth.convertToHtml({ buffer: data }, {
      externalFileAccess: false, includeEmbeddedStyleMap: false, includeDefaultStyleMap: false,
      transformDocument: (document: WordNode) => {
        collectWordParagraphs(document, out.add);
        return { ...document, children: [] }; // Do not render or read embedded images.
      },
    });
  } else if (extension === "xlsx") {
    await validateZip(data, extension);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(data as unknown as ExcelJS.Buffer);
    if (workbook.worksheets.length > MAX_SHEETS) throw new Error("Excel 工作表数超过限制");
    let cells = 0;
    for (const sheet of workbook.worksheets) {
      if (sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COL) throw new Error("Excel 规模超过限制");
      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber > MAX_ROWS) throw new Error("Excel 行数超过限制");
        const values: string[] = [];
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          if (++cells > MAX_CELLS || colNumber > MAX_COL) throw new Error("Excel 单元格数超过限制");
          const value = cellText(cell.value);
          if (value) values.push(`${cell.address}：${value}`);
        });
        out.add(`工作表「${sheet.name}」第 ${rowNumber} 行`, values.join("\t"));
      });
    }
  } else {
    if (data.length < 5 || data.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("文件签名与扩展名不匹配");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // Package-owned resources only; disable fetch and never resolve PDF-provided URLs.
    const packageRoot = path.resolve(path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.mjs")), "../..");
    const task = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false,
      disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, disableAutoFetch: true,
      disableStream: true, maxImageSize: 1, stopAtErrors: true,
      standardFontDataUrl: path.join(packageRoot, "standard_fonts") + path.sep,
      cMapUrl: path.join(packageRoot, "cmaps") + path.sep, cMapPacked: true });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > MAX_PDF_PAGES) throw new Error("PDF 页数超过限制");
      let count = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        try {
          const content = await page.getTextContent();
          count += content.items.length;
          if (count > MAX_PDF_ITEMS) throw new Error("PDF 文字对象数超过限制");
          let text = "";
          for (const item of content.items) {
            if ("str" in item) {
              text += item.str + (item.hasEOL ? "\n" : "");
              if (text.length > MAX_TEXT) throw new Error("PDF 文字超过限制");
            }
          }
          out.add(`第 ${i} 页`, text);
        } finally { page.cleanup(); }
      }
    } finally { await task.destroy(); }
  }
  return { segments: out.segments, warning: out.segments.length === 0
    ? extension === "pdf" ? "PDF 未提取到文字，可能是扫描件；暂不支持 OCR。" : "文件中没有可索引的文字。"
    : undefined };
}
function queryTerms(question: string): { terms: string[]; grams: string[] } | null {
  if (typeof question !== "string" || question.length > 4000) return null;
  const normalized = question.normalize("NFKC").toLowerCase();
  const clean = normalized.replace(/(?:请问|请|帮我|帮忙|查询|查找|搜索|寻找|告诉我|介绍一下|说明一下|有哪些|有没有|是什么|怎么样|如何|为什么|多少|哪些|哪个|什么|怎么|能否|是否|有关|关于|相关|一下|一下子|知识库|文档中|文件中|里面|其中|这个|那个|以及|或者|还是|以及|的|了|吗|呢|是|有|和|与|在)/g, " ");
  const parts = clean.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) || [];
  const broad = new Set(["资料", "内容", "文件", "文档", "知识", "安全", "操作", "规定", "标准", "流程", "制度", "介绍", "要求", "情况", "信息", "问题", "数据", "文字", "规定", "全部", "所有", "内容信息", "anything", "everything", "document", "documents", "information", "what", "show", "list", "the", "all", "and", "for", "about", "how"]);
  if (!parts.length || parts.every(p => broad.has(p) || (/^[\p{Script=Han}]+$/u.test(p) &&
      p.replace(/资料|内容|文件|文档|知识|安全|操作|规定|规程|标准|流程|制度|介绍|要求|情况|信息|问题|数据|文字|全部|所有/g, "") === ""))) return null;
  const terms = [...new Set(parts.filter(p => p.length >= 2 && !broad.has(p) && (!/^[a-z]+$/.test(p) || p.length >= 3)))];
  if (!terms.length) return null;
  const grams = new Set<string>();
  for (const t of terms) {
    if (/^[\p{Script=Han}]+$/u.test(t)) {
      for (let i = 0; i < t.length - 1; i++) grams.add(t.slice(i, i + 2));
    } else grams.add(t);
  }
  return { terms, grams: [...grams] };
}
function relevance(text: string, query: NonNullable<ReturnType<typeof queryTerms>>): number {
  const value = text.normalize("NFKC").toLowerCase();
  let found = 0;
  for (const gram of query.grams) if (value.includes(gram)) found++;
  const exact = query.terms.filter(term => value.includes(term));
  if (found / query.grams.length < 0.5 || (!exact.length && found < 2)) return 0;
  return exact.reduce((s, term) => s + Math.min(term.length, 20) * 2, 0) + found / query.grams.length;
}

/** Caller chooses and authorizes the absolute root; this module never accepts a source path. */
export function createLocalKnowledgeStore(root: string) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("知识库根目录必须是绝对路径");
  const rootDir = path.resolve(root);
  const dir = boundedPath(rootDir, DATA_DIR);
  async function ready(create: boolean): Promise<boolean> {
    if (!await checkDirectory(rootDir, create)) return false;
    return checkDirectory(dir, create);
  }
  async function readManifest(id: string): Promise<Manifest> {
    if (!UUID.test(id)) throw new Error("无效的文件 ID");
    return parseManifest(await readRegular(boundedPath(dir, `${id}.json`), MAX_INDEX_BYTES), id);
  }
  async function listManifests(): Promise<Manifest[]> {
    if (!await ready(false)) return [];
    const entries = await fs.readdir(dir);
    const all: Manifest[] = [];
    for (const name of entries) {
      const match = /^([0-9a-f-]+)\.json$/.exec(name);
      if (!match || !UUID.test(match[1])) continue;
      try { all.push(await readManifest(match[1])); }
      catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    }
    return all;
  }
  return {
    async list(): Promise<LocalDocument[]> {
      const manifests = await listManifests();
      return manifests.map(m => ({ ...m.document })).sort((a, b) => b.importedAt.localeCompare(a.importedAt) || a.id.localeCompare(b.id));
    },
    async importFile(input: { name: string; dataBase64: string }): Promise<LocalDocument> {
      if (!input || !validName(input.name)) throw new Error("文件名无效，不能包含路径");
      const ext = /\.(docx|xlsx|pdf)$/i.exec(input.name)?.[1].toLowerCase() as Extension | undefined;
      if (!ext) throw new Error("仅支持 .docx、.xlsx、.pdf 文件");
      const encoded = input.dataBase64;
      if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_FILE / 3) * 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("Base64 数据无效或文件超过 10 MiB");
      const data = Buffer.from(encoded, "base64");
      if (!data.length || data.length > MAX_FILE || data.toString("base64") !== encoded) throw new Error("Base64 数据无效或文件超过 10 MiB");
      const extracted = await extract(data, ext);
      if (!await ready(true)) throw new Error("无法创建知识库目录");
      const id = randomUUID();
      const document: LocalDocument = { id, name: input.name, importedAt: new Date().toISOString(),
        status: extracted.segments.length ? "indexed" : "empty", segmentCount: extracted.segments.length,
        ...(extracted.warning ? { warning: extracted.warning } : {}) };
      const manifest: Manifest = { version: 1, document, extension: ext, segments: extracted.segments };
      const serialized = JSON.stringify(manifest);
      if (Buffer.byteLength(serialized) > MAX_INDEX_BYTES) throw new Error("本地索引过大");
      const copy = boundedPath(dir, `${id}.${ext}`);
      const temp = boundedPath(dir, `${id}.${randomUUID()}.tmp`);
      const index = boundedPath(dir, `${id}.json`);
      let copyCreated = false, tempCreated = false;
      try {
        const copyHandle = await fs.open(copy, "wx", 0o600);
        copyCreated = true;
        try { await copyHandle.writeFile(data); } finally { await copyHandle.close(); }
        // Verify the directories again before publishing the index.
        if (!await ready(false)) throw new Error("知识库目录不存在");
        const tempHandle = await fs.open(temp, "wx", 0o600);
        tempCreated = true;
        try { await tempHandle.writeFile(serialized); } finally { await tempHandle.close(); }
        await fs.rename(temp, index);
        tempCreated = false;
        return { ...document };
      } catch (error) {
        if (tempCreated) await fs.unlink(temp).catch(() => {});
        if (copyCreated) await fs.unlink(copy).catch(() => {});
        throw error;
      }
    },
    async remove(id: string): Promise<void> {
      if (typeof id !== "string" || !UUID.test(id)) throw new Error("无效的文件 ID");
      if (!await ready(false)) return;
      let manifest: Manifest;
      try { manifest = await readManifest(id); }
      catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
      const index = boundedPath(dir, `${id}.json`);
      const deleting = boundedPath(dir, `${id}.${randomUUID()}.deleting`);
      // Rename claims this document atomically; other deletes and readers stop seeing it.
      try { await fs.rename(index, deleting); }
      catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
      const copy = boundedPath(dir, `${id}.${manifest.extension}`);
      try {
        try {
          const stat = await fs.lstat(copy);
          if (!isRegular(stat)) throw new Error("知识库副本不是普通文件，拒绝删除");
          await fs.unlink(copy);
        } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      } catch (error) {
        await fs.rename(deleting, index).catch(() => {});
        throw error;
      }
      await fs.unlink(deleting);
    },
    async search(question: string): Promise<LocalMatch[]> {
      if (typeof question !== "string" || question.length > 4000) throw new Error("问题不能超过 4000 字");
      const query = queryTerms(question);
      const exact = question.normalize("NFKC").trim().toLowerCase().replace(/^[\s?？!！。.,，、:：;；]+|[\s?？!！。.,，、:：;；]+$/g, "");
      if (!query && exact.length < 2) return [];
      const manifests = await listManifests();
      const matches: Array<LocalMatch & { score: number }> = [];
      for (const m of manifests) for (const segment of m.segments) {
        const value = segment.text.normalize("NFKC").toLowerCase();
        const score = exact.length >= 2 && value.includes(exact) ? 10_000 + Math.min(exact.length, 4000) : query ? relevance(segment.text, query) : 0;
        if (score) matches.push({ fileId: m.document.id, name: m.document.name, location: segment.location, text: segment.text, score });
      }
      return matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.location.localeCompare(b.location))
        .slice(0, 3).map(({ score: _score, ...match }) => match);
    },
  };
}
