"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// .scratch/bundle-pipeline.ts
var bundle_pipeline_exports = {};
__export(bundle_pipeline_exports, {
  createPipeline: () => createPipeline
});
module.exports = __toCommonJS(bundle_pipeline_exports);

// electron/pipeline.ts
var import_node_fs4 = require("node:fs");
var import_node_path4 = __toESM(require("node:path"));
var import_node_fs5 = require("node:fs");
var import_electron = require("electron");

// electron/queue/checkpoint.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
function isSafeJobId(id) {
  return typeof id === "string" && id !== "." && id !== ".." && /^[A-Za-z0-9_.-]+$/.test(id);
}
function assertSafe(jobId) {
  if (!isSafeJobId(jobId)) throw new Error(`\u975E\u6CD5\u7684\u4EFB\u52A1 id\uFF1A${String(jobId)}`);
}
var CHECKPOINT_FILE = "checkpoint.json";
var TRANSLATION_FILE = "translation.jsonl";
var STATE_FILE = "state.json";
var CAPTURE_META_FILE = "capture.json";
var CheckpointStore = class {
  jobsRoot;
  constructor(jobsRoot) {
    this.jobsRoot = jobsRoot;
  }
  /** Absolute dir for a job (created lazily on first write). */
  getJobDir(jobId) {
    assertSafe(jobId);
    return (0, import_node_path.join)(this.jobsRoot, jobId);
  }
  checkpointPath(jobId) {
    return (0, import_node_path.join)(this.getJobDir(jobId), CHECKPOINT_FILE);
  }
  translationPath(jobId) {
    return (0, import_node_path.join)(this.getJobDir(jobId), TRANSLATION_FILE);
  }
  statePath(jobId) {
    return (0, import_node_path.join)(this.getJobDir(jobId), STATE_FILE);
  }
  async ensureDir(jobId) {
    await import_node_fs.promises.mkdir(this.getJobDir(jobId), { recursive: true });
  }
  /**
   * Atomic write: serialize to `<path>.tmp`, fsync-less, then rename over the
   * target. On Windows rename replaces the destination atomically (libuv).
   */
  async atomicWrite(path3, data) {
    await import_node_fs.promises.mkdir((0, import_node_path.dirname)(path3), { recursive: true });
    const tmp = path3 + ".tmp";
    await import_node_fs.promises.writeFile(tmp, data, "utf8");
    await import_node_fs.promises.rename(tmp, path3);
  }
  // ----- checkpoint.json (atomic) -----
  /** Persist a progress snapshot atomically. */
  async save(jobId, data) {
    await this.ensureDir(jobId);
    await this.atomicWrite(this.checkpointPath(jobId), JSON.stringify(data));
  }
  /** Read the progress snapshot; null when the job has no checkpoint yet. */
  async load(jobId) {
    try {
      const raw = await import_node_fs.promises.readFile(this.checkpointPath(jobId), "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  // ----- translation.jsonl (append-only) -----
  /**
   * Append one finalized unit to translation.jsonl. Append-only: resume never
   * truncates this file, so a unit already translated is never re-translated.
   */
  async appendTranslation(jobId, unitId, translatedText) {
    await this.ensureDir(jobId);
    const record = { unitId, translatedText };
    const handle = await import_node_fs.promises.open(this.translationPath(jobId), "a");
    try {
      await handle.write(JSON.stringify(record) + "\n");
    } finally {
      await handle.close();
    }
  }
  /**
   * Read all durable translations back into a Map<unitId, translatedText>.
   * Tolerant of a partial trailing line (a crash mid-append) — unparseable
   * lines are skipped.
   */
  async loadTranslations(jobId) {
    const out = /* @__PURE__ */ new Map();
    let raw;
    try {
      raw = await import_node_fs.promises.readFile(this.translationPath(jobId), "utf8");
    } catch {
      return out;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.unitId === "string" && typeof rec.translatedText === "string") {
          out.set(rec.unitId, rec.translatedText);
        }
      } catch {
      }
    }
    return out;
  }
  // ----- state.json (atomic status snapshot) -----
  /** Persist an arbitrary status snapshot object (atomic). */
  async saveState(jobId, state) {
    await this.ensureDir(jobId);
    await this.atomicWrite(this.statePath(jobId), JSON.stringify(state));
  }
  /** Read the status snapshot; null when absent. */
  async loadState(jobId) {
    try {
      const raw = await import_node_fs.promises.readFile(this.statePath(jobId), "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  // ----- capture shape meta (resume safety across extraction upgrades) -----
  /** Stamp which capture pipeline produced this job's block ids. */
  async writeCaptureMeta(jobId, meta) {
    await this.ensureDir(jobId);
    await this.atomicWrite((0, import_node_path.join)(this.getJobDir(jobId), CAPTURE_META_FILE), JSON.stringify(meta));
  }
  /** Read the capture meta; null for pre-meta jobs. */
  async readCaptureMeta(jobId) {
    try {
      const raw = await import_node_fs.promises.readFile((0, import_node_path.join)(this.getJobDir(jobId), CAPTURE_META_FILE), "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  /**
   * Move an old-shape translation.jsonl aside (atomically replacing any prior
   * .stale) so new-shape unit ids can never interleave with stale ones.
   */
  async archiveTranslations(jobId) {
    const dir = this.getJobDir(jobId);
    try {
      await import_node_fs.promises.rename((0, import_node_path.join)(dir, TRANSLATION_FILE), (0, import_node_path.join)(dir, TRANSLATION_FILE + ".stale"));
    } catch {
    }
  }
  // ----- delete -----
  /**
   * Remove the entire job dir (checkpoint + translation.jsonl + state.json).
   * Defense-in-depth: never delete outside jobsRoot even if the dir was built
   * from an unsafe id (the guard runs in getJobDir already).
   */
  async clear(jobId) {
    const root = (0, import_node_path.resolve)(this.jobsRoot);
    const target = (0, import_node_path.resolve)(this.getJobDir(jobId));
    if (target !== root && !target.startsWith(root + import_node_path.sep)) return;
    try {
      await import_node_fs.promises.rm(target, { recursive: true, force: true });
    } catch {
    }
  }
};

// electron/pdf/capture/flow.ts
var fs = __toESM(require("node:fs"));
var zlib = __toESM(require("node:zlib"));
var pdfjsNamespace = __toESM(require("pdfjs-dist/legacy/build/pdf.js"));
var import_pdf_lib = require("pdf-lib");
var pdfjsLib = pdfjsNamespace.default ?? pdfjsNamespace;
pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdf.worker.js";
var CAPTURE_VERSION = 2;
function isTextItem(item) {
  return typeof item === "object" && item !== null && typeof item.str === "string" && Array.isArray(item.transform);
}
var MONO_FONT_RE = /Courier|Consolas|Menlo|Monaco|monospace|Code\d*$/i;
var CODE_SYMBOL_RE = /[{};=[\]<>]|=>|::|\/\//g;
var LIST_NUMBERED_RE = /^\s*(?:\(\d+(?:\.\d+)*\)|\d+(?:\.\d+)*[.)]\s+|[a-zA-Z][.)]\s+)/;
var LIST_BULLET_RE = /^\s*[•●▪◦■▪◦*\-–—―·•]\s*/;
var BULLET_ONLY_RE = /^\s*[•●▪◦■▪◦*\-–—―·•]+\s*$/;
var PAGE_NUM_RE = /^\s*\d{1,4}\s*$/;
var ROMAN_NUM_RE = /^\s*[ivxlcdmIVXLCDM]{1,6}\s*$/;
var TOC_DOT_LEADER_RE = /\.{3,}\s*\d+\s*$/;
var TOC_GLUED_NUM_RE = /[A-Za-z)\]'"]\s*\d{1,3}\s*$/;
var TOC_SECTION_START_RE = /^\s*\d+(?:\.\d+){0,2}\s*[A-Z"']/;
var TOC_TITLE_RE = /^(?:brief\s+contents|contents|table\s+of\s+contents)\s*$/i;
var HEADER_BAND = 0.06;
var FOOTER_BAND = 0.06;
var LINE_GAP_RATIO = 1.6;
var FONT_TOLERANCE = 0.18;
var TABLE_COL_GAP_PT = 22;
var TABLE_MIN_COLS = 3;
var TABLE_MIN_ROWS = 2;
function looksLikeHeaderRow(cells) {
  if (cells.length < 2) return false;
  const first = cells[0];
  return first.length >= 2 && first.every((c) => c.trim().length > 0 && c.trim().length <= 24);
}
function clusterX(xs, clusterGap) {
  if (xs.length === 0) return [];
  const sorted = xs.slice().sort((a, b) => a - b);
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - clusters[clusters.length - 1][0] <= clusterGap) {
      clusters[clusters.length - 1].push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }
  return clusters.map((c) => c.reduce((a, b) => a + b, 0) / c.length);
}
function nearestAnchor(x, anchors, tol) {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < anchors.length; i++) {
    const d = Math.abs(x - anchors[i]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return bestDist <= tol ? best : -1;
}
function detectTables(lines) {
  const tables = [];
  const skip = /* @__PURE__ */ new Set();
  const byPage = /* @__PURE__ */ new Map();
  for (const l of lines) {
    if (!byPage.has(l.page)) byPage.set(l.page, []);
    byPage.get(l.page).push(l);
  }
  for (const [page, plines] of byPage) {
    const withSegs = plines.filter((l) => (l.segments?.length ?? 0) >= 1);
    if (withSegs.length < TABLE_MIN_ROWS) continue;
    const allX = [];
    for (const l of withSegs) for (const s of l.segments) allX.push(s.x);
    const anchors = clusterX(allX, 30).filter(
      (a) => allX.filter((x) => Math.abs(x - a) <= 14).length >= 3
    );
    if (anchors.length < TABLE_MIN_COLS) continue;
    const mapped = [];
    for (const l of withSegs) {
      const cols = /* @__PURE__ */ new Set();
      for (const s of l.segments) {
        const ai = nearestAnchor(s.x, anchors, 16);
        if (ai >= 0) cols.add(ai);
      }
      if (cols.size >= 1) mapped.push({ line: l, cols: [...cols] });
    }
    const hasFullRow = mapped.some((m) => m.cols.length >= TABLE_MIN_COLS);
    if (!hasFullRow) continue;
    mapped.sort((a, b) => b.line.y - a.line.y);
    const runs = [];
    let curRun = [];
    let prev = null;
    for (const m of mapped) {
      if (prev) {
        const gap = Math.abs(prev.line.y - m.line.y);
        if (gap > Math.max(prev.line.fontSize, m.line.fontSize) * 2.5) {
          runs.push(curRun);
          curRun = [];
        }
      }
      curRun.push(m);
      prev = m;
    }
    if (curRun.length) runs.push(curRun);
    for (const run of runs) {
      if (run.length < TABLE_MIN_ROWS) continue;
      if (!run.some((m) => m.cols.length >= TABLE_MIN_COLS)) continue;
      const ncols = anchors.length;
      const rows = [];
      let curCells = [];
      let prevLine = null;
      const flushRow = () => {
        const merged = new Array(ncols).fill("");
        for (const parts of curCells) {
          for (let c = 0; c < ncols; c++) {
            if (parts[c]) merged[c] += (merged[c] ? " " : "") + parts[c];
          }
        }
        rows.push(merged.map((s) => s.trim()));
        curCells = [];
      };
      for (const m of run) {
        if (prevLine) {
          const gap = Math.abs(prevLine.y - m.line.y);
          const lineH = Math.max(prevLine.fontSize, m.line.fontSize);
          if (gap > lineH * 1.6 && curCells.length > 0) {
            flushRow();
          }
        }
        const parts = new Array(ncols).fill("");
        for (const s of m.line.segments) {
          const ai = nearestAnchor(s.x, anchors, 16);
          if (ai >= 0) parts[ai] += (parts[ai] ? " " : "") + s.text.trim();
        }
        curCells.push(parts);
        prevLine = m.line;
      }
      flushRow();
      if (rows.length < TABLE_MIN_ROWS) continue;
      const clean = rows.filter((r) => r.some((c) => c.trim().length > 0));
      if (clean.length < TABLE_MIN_ROWS) continue;
      const keep = [];
      for (let c = 0; c < ncols; c++) {
        if (clean.some((r) => (r[c] ?? "").trim().length > 0)) keep.push(c);
      }
      const pruned = clean.map((r) => keep.map((c) => r[c] ?? ""));
      if (keep.length < 2 || pruned.length < TABLE_MIN_ROWS) continue;
      const gaps = [];
      const rawGaps = [];
      for (let i = 1; i < anchors.length; i++) rawGaps.push(anchors[i] - anchors[i - 1]);
      rawGaps.sort((a, b) => a - b);
      const medianGap = rawGaps.length ? Math.max(24, rawGaps[Math.floor(rawGaps.length / 2)]) : 60;
      for (let i = 0; i < keep.length; i++) {
        const w = i + 1 < keep.length ? anchors[keep[i + 1]] - anchors[keep[i]] : medianGap;
        gaps.push(Math.max(24, w));
      }
      const gw = gaps.reduce((a, b) => a + b, 0) || 1;
      const colWidths = gaps.map((g) => g / gw);
      tables.push({ cells: pruned, page, startTopY: run[0].line.y, anchors, colWidths });
      for (const m of run) skip.add(m.line);
    }
  }
  return { tables, skip };
}
function mergeLinesToParas(lines) {
  const paras = [];
  let cur = null;
  let prevBaseline = 0;
  let pendingBullet = false;
  for (const line of lines) {
    if (BULLET_ONLY_RE.test(line.text.trim())) {
      pendingBullet = true;
      continue;
    }
    const lineText = pendingBullet ? "\u2022 " + line.text : line.text;
    pendingBullet = false;
    if (!cur) {
      cur = {
        texts: [lineText],
        fontSize: line.fontSize,
        fontName: line.fontName,
        page: line.page,
        col: line.col,
        pageHeight: line.pageHeight,
        topY: line.y
      };
      prevBaseline = line.y;
      continue;
    }
    const gap = prevBaseline - line.y;
    const lineH = cur.fontSize;
    const fontRatio = Math.min(line.fontSize, cur.fontSize) / Math.max(line.fontSize, cur.fontSize);
    const sameFlow = line.page === cur.page && line.col === cur.col;
    const startsListItem = LIST_BULLET_RE.test(lineText) || LIST_NUMBERED_RE.test(lineText);
    const startsHeading = SECTION_NUM_HEADING_RE.test(lineText.trim());
    if (sameFlow && !startsListItem && !startsHeading && gap <= lineH * LINE_GAP_RATIO && fontRatio > 1 - FONT_TOLERANCE) {
      cur.texts.push(lineText);
      cur.fontSize = (cur.fontSize + line.fontSize) / 2;
    } else {
      paras.push({
        text: cur.texts.join(" ").replace(/\s+/g, " ").trim(),
        fontSize: cur.fontSize,
        fontName: cur.fontName,
        page: cur.page,
        pageHeight: cur.pageHeight,
        topY: cur.topY
      });
      cur = {
        texts: [lineText],
        fontSize: line.fontSize,
        fontName: line.fontName,
        page: line.page,
        col: line.col,
        pageHeight: line.pageHeight,
        topY: line.y
      };
    }
    prevBaseline = line.y;
  }
  if (cur) {
    paras.push({
      text: cur.texts.join(" ").replace(/\s+/g, " ").trim(),
      fontSize: cur.fontSize,
      fontName: cur.fontName,
      page: cur.page,
      pageHeight: cur.pageHeight,
      topY: cur.topY
    });
  }
  return paras;
}
function isInHeaderBand(line) {
  return line.y >= line.pageHeight * (1 - HEADER_BAND);
}
function isInFooterBand(line) {
  return line.y <= line.pageHeight * FOOTER_BAND;
}
function isTocEntryLine(text) {
  const t = text.trim();
  if (t.length === 0 || t.length > 140) return false;
  if (TOC_DOT_LEADER_RE.test(t)) return true;
  if (TOC_SECTION_START_RE.test(t)) return true;
  if (TOC_GLUED_NUM_RE.test(t)) return true;
  return false;
}
function isTocPage(lines) {
  const nonEmpty = lines.filter((l) => l.text.trim().length > 0);
  if (nonEmpty.length < 4) return false;
  let entryCount = 0;
  let hasTitle = false;
  for (const l of nonEmpty) {
    const t = l.text.trim();
    if (TOC_TITLE_RE.test(t)) hasTitle = true;
    else if (isTocEntryLine(t)) entryCount++;
  }
  if (hasTitle && entryCount >= 3) return true;
  return entryCount / nonEmpty.length > 0.3;
}
function estimateBodySize(paras) {
  const sizeBuckets = /* @__PURE__ */ new Map();
  for (const p of paras) {
    const bucket = Math.round(p.fontSize);
    sizeBuckets.set(bucket, (sizeBuckets.get(bucket) ?? 0) + p.text.length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of sizeBuckets) {
    if (weight > bestWeight) {
      bestWeight = weight;
      best = size;
    }
  }
  return best > 0 ? best : 11;
}
function headingLevel(fontSize, bodySize) {
  const ratio = fontSize / bodySize;
  if (ratio >= 1.6) return 1;
  if (ratio >= 1.35) return 2;
  if (ratio >= 1.2) return 3;
  if (ratio > 1.08) return 4;
  return 0;
}
var FORMULA_SYMBOL_RE = /[∑∫√∞≈≠≤≥±×÷∂∆∏∏∑∫]/g;
var SECTION_NUM_HEADING_RE = /^\d+(?:\.\d+)+\s*[A-Z]/;
function classifyPara(p, bodySize) {
  const text = p.text.trim();
  if (text.length === 0) return "body";
  const fSymCount = (text.match(FORMULA_SYMBOL_RE) || []).length;
  if (text.length > 5 && fSymCount >= 2 && fSymCount / text.length > 0.08) return "formula";
  const isMono = MONO_FONT_RE.test(p.fontName);
  const symCount = (text.match(CODE_SYMBOL_RE) || []).length;
  const isDenseCode = text.length > 30 && symCount >= 3 && symCount > text.length / 12;
  if (isMono || isDenseCode) return "code";
  if (LIST_NUMBERED_RE.test(text) || LIST_BULLET_RE.test(text)) return "list-item";
  if (SECTION_NUM_HEADING_RE.test(text) && text.length <= 90) return "heading";
  const level = headingLevel(p.fontSize, bodySize);
  if (level > 0) return "heading";
  return "body";
}
var PNG_CRC_TABLE = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1 ? 3988292384 : 0) ^ c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function pngCrc32(buf) {
  let c = 4294967295;
  for (let i = 0; i < buf.length; i++) c = PNG_CRC_TABLE[(c ^ buf[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, pngCrc32(out.subarray(4, 8 + data.length)));
  return out;
}
function rgbToPng(width, height, rgb2) {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb2.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw);
  const parts = [sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", new Uint8Array(idat)), pngChunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function flateImageToPng(contents, width, height, bitsPerComponent, colorSpace) {
  try {
    if (bitsPerComponent !== 8) return null;
    if (colorSpace !== "/DeviceRGB" && colorSpace !== "DeviceRGB") return null;
    const expected = width * height * 3;
    const raw = zlib.inflateSync(Buffer.from(contents));
    if (raw.length !== expected) return null;
    return rgbToPng(width, height, new Uint8Array(raw.buffer, raw.byteOffset, raw.length));
  } catch {
    return null;
  }
}
function extractImagesFromPage(pdfDoc, pageIndex) {
  const page = pdfDoc.getPage(pageIndex);
  const leaf = page.node;
  const results = [];
  const seen = /* @__PURE__ */ new Set();
  const walkResources = (res) => {
    if (!res) return;
    const xobj = res.lookupMaybe(import_pdf_lib.PDFName.XObject, import_pdf_lib.PDFDict);
    if (!xobj) return;
    for (const [key] of xobj.entries()) {
      const obj = xobj.lookup(key);
      if (!obj) continue;
      const dict = obj.dict;
      if (!dict) continue;
      const subtype = dict.lookupMaybe(import_pdf_lib.PDFName.of("Subtype"), import_pdf_lib.PDFName);
      const subtypeStr = subtype ? subtype.toString() : "";
      if (subtypeStr === "/Image") {
        const filter = dict.lookupMaybe(import_pdf_lib.PDFName.of("Filter"), import_pdf_lib.PDFName);
        const filterStr = filter ? filter.toString() : "";
        const w = dict.lookupMaybe(import_pdf_lib.PDFName.of("Width"), import_pdf_lib.PDFNumber);
        const h = dict.lookupMaybe(import_pdf_lib.PDFName.of("Height"), import_pdf_lib.PDFNumber);
        const pw = w ? w.asNumber() : 0;
        const ph = h ? h.asNumber() : 0;
        const refKey = String(obj.constructor.name) + ":" + pw + "x" + ph + ":" + obj.byteOffset;
        if (seen.has(refKey)) continue;
        seen.add(refKey);
        if (filterStr === "/DCTDecode" && obj instanceof import_pdf_lib.PDFRawStream) {
          results.push({
            bytes: obj.contents,
            format: "jpg",
            pixelWidth: pw,
            pixelHeight: ph
          });
        } else if (filterStr === "/FlateDecode" && obj instanceof import_pdf_lib.PDFRawStream) {
          const bpcObj = dict.lookupMaybe(import_pdf_lib.PDFName.of("BitsPerComponent"), import_pdf_lib.PDFNumber);
          const bpc = bpcObj ? bpcObj.asNumber() : 8;
          const csObj = dict.lookupMaybe(import_pdf_lib.PDFName.of("ColorSpace"), import_pdf_lib.PDFName);
          const csStr = csObj ? csObj.toString() : "";
          const png = flateImageToPng(obj.contents, pw, ph, bpc, csStr);
          if (png) {
            results.push({ bytes: png, format: "png", pixelWidth: pw, pixelHeight: ph });
          } else {
            console.log(`[capture/flow] skipped Flate image ${pw}x${ph} bpc=${bpc} cs=${csStr}`);
          }
        } else {
          console.log(`[capture/flow] skipped image filter=${filterStr} ${pw}x${ph}`);
        }
      } else if (subtypeStr === "/Form") {
        const innerRes = dict.lookupMaybe(import_pdf_lib.PDFName.Resources, import_pdf_lib.PDFDict);
        walkResources(innerRes);
      }
    }
  };
  const resources = leaf.Resources();
  walkResources(resources);
  return results;
}
var IDENTITY_CTM = [1, 0, 0, 1, 0, 0];
function multiplyCTM(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1
  ];
}
function arrayToCTM(arr) {
  return [arr[0] || 0, arr[1] || 0, arr[2] || 0, arr[3] || 0, arr[4] || 0, arr[5] || 0];
}
function trackImagePlacements(fnArray, argsArray, pageNumber) {
  const placements = [];
  let ctm = [...IDENTITY_CTM];
  const stack = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === 10) {
      stack.push([...ctm]);
    } else if (fn === 11) {
      if (stack.length > 0) ctm = stack.pop();
    } else if (fn === 12) {
      if (Array.isArray(args) && args.length >= 6) {
        ctm = multiplyCTM(ctm, arrayToCTM(args));
      }
    } else if (fn === 74) {
      stack.push([...ctm]);
      if (Array.isArray(args) && Array.isArray(args[0]) && args[0].length >= 6) {
        ctm = multiplyCTM(ctm, arrayToCTM(args[0]));
      }
    } else if (fn === 75) {
      if (stack.length > 0) ctm = stack.pop();
    } else if (fn === 85) {
      if (Array.isArray(args) && args.length >= 3) {
        const pixelW = args[1];
        const pixelH = args[2];
        const displayW = Math.abs(ctm[0]);
        const displayH = Math.abs(ctm[3]);
        const y = ctm[5];
        const centerY = y + displayH / 2;
        placements.push({
          page: pageNumber,
          centerY,
          displayW,
          displayH,
          pixelW,
          pixelH
        });
      }
    }
  }
  return placements;
}
function matchImagesToPlacements(extracted, placements) {
  const used = /* @__PURE__ */ new Set();
  const pairs = [];
  for (const p of placements) {
    let foundIdx = -1;
    for (let i = 0; i < extracted.length; i++) {
      if (used.has(i)) continue;
      if (extracted[i].pixelWidth === p.pixelW && extracted[i].pixelHeight === p.pixelH) {
        foundIdx = i;
        break;
      }
    }
    if (foundIdx >= 0) {
      used.add(foundIdx);
      pairs.push({ image: extracted[foundIdx], placement: p });
    }
  }
  return pairs;
}
function stripBleedingPageNumbers(text) {
  let t = text.trim();
  t = t.replace(/^[ivxlcdm]{2,6}\s+/, "");
  t = t.replace(/^\d{1,3}\s+/, "");
  t = t.replace(/\s+\d{1,3}\s*$/, "");
  return t.trim();
}
function normalizeHeadingNumber(text) {
  const m = /^(\d{1,2})(\d{1,2}\.\d+(?:\.\d+)?)(?=[A-Z])/.exec(text);
  if (m && m[2].startsWith(m[1])) {
    return m[2] + text.slice(m[0].length);
  }
  return text;
}
function isEmptyFurniture(text) {
  return !/[A-Za-z0-9]/.test(text);
}
function splitHeadingFromBody(text) {
  const m = /^(\d+(?:\.\d+)+\s*[A-Z][^.]*?)([.:]\s|$)/.exec(text);
  if (!m) return null;
  const headingPart = m[1].trim();
  if (headingPart.length > 80) return null;
  const rest = text.slice(m[0].length).trim();
  if (rest.length === 0) return null;
  const dotCount = (headingPart.match(/\./g) || []).length;
  const level = dotCount >= 3 ? 3 : 2;
  return { heading: headingPart, body: rest, level };
}
async function captureFlow(inputPath, options = {}) {
  const data = new Uint8Array(fs.readFileSync(inputPath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true
  });
  const pdf = await loadingTask.promise;
  const max = options.pageLimit && options.pageLimit > 0 ? Math.min(options.pageLimit, pdf.numPages) : pdf.numPages;
  const pdfDoc = await import_pdf_lib.PDFDocument.load(data, { ignoreEncryption: true });
  const allLines = [];
  const placementsByPage = /* @__PURE__ */ new Map();
  try {
    for (let pageNumber = 1; pageNumber <= max; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const pageHeight = viewport.height;
      const linesOnPage = groupItemsIntoLines(textContent.items, pageNumber, viewport.width, pageHeight);
      const filtered = linesOnPage.filter((l) => {
        const t = l.text.trim();
        if (PAGE_NUM_RE.test(t) || ROMAN_NUM_RE.test(t)) return false;
        if (isInHeaderBand(l) || isInFooterBand(l)) return false;
        return true;
      });
      if (isTocPage(filtered)) {
        await page.cleanup();
        continue;
      }
      allLines.push(...filtered);
      try {
        const opList = await page.getOperatorList();
        const placements = trackImagePlacements(opList.fnArray, opList.argsArray, pageNumber);
        if (placements.length > 0) {
          placementsByPage.set(pageNumber, placements);
        }
      } catch {
      }
      await page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  const extractedByPage = /* @__PURE__ */ new Map();
  for (let p = 0; p < max; p++) {
    try {
      const imgs = extractImagesFromPage(pdfDoc, p);
      if (imgs.length > 0) {
        extractedByPage.set(p + 1, imgs);
      }
    } catch {
    }
  }
  const matchedImages = [];
  let imageCount = 0;
  for (const [pageNum, placements] of placementsByPage) {
    const extracted = extractedByPage.get(pageNum) ?? [];
    const pairs = matchImagesToPlacements(extracted, placements);
    matchedImages.push(...pairs);
    imageCount += pairs.length;
  }
  console.log(`[capture/flow] extracted ${imageCount} images from ${max} pages`);
  const bodyLines = dropRepeatedEdgeText(allLines, max);
  const { tables, skip: tableLines } = detectTables(bodyLines);
  console.log(`[capture/flow] detected ${tables.length} tables`);
  const proseLines = bodyLines.filter((l) => !tableLines.has(l));
  const tableEntries = tables.map((t) => ({
    block: {
      type: "table",
      cells: t.cells,
      rows: t.cells.length,
      cols: t.cells[0]?.length ?? 0,
      hasHeader: looksLikeHeaderRow(t.cells),
      colWidths: t.colWidths,
      page: t.page
    },
    page: t.page,
    topY: t.startTopY
  }));
  const paras = mergeLinesToParas(proseLines);
  const bodySize = estimateBodySize(paras);
  const blockEntries = [];
  let pendingList = [];
  let pendingListPage = 0;
  let pendingListTopY = 0;
  let pendingCode = [];
  let pendingCodePage = 0;
  let pendingCodeTopY = 0;
  const flushList = () => {
    if (pendingList.length > 0) {
      blockEntries.push({
        block: { type: "list", items: pendingList, page: pendingListPage },
        page: pendingListPage,
        topY: pendingListTopY
      });
      pendingList = [];
    }
  };
  const flushCode = () => {
    if (pendingCode.length > 0) {
      blockEntries.push({
        block: { type: "code", code: pendingCode.join("\n"), page: pendingCodePage },
        page: pendingCodePage,
        topY: pendingCodeTopY
      });
      pendingCode = [];
    }
  };
  for (const para of paras) {
    const kind = classifyPara(para, bodySize);
    if (kind === "code") {
      flushList();
      pendingCode.push(para.text);
      pendingCodePage = para.page;
      pendingCodeTopY = para.topY;
    } else if (kind === "list-item") {
      flushCode();
      const stripped = stripBleedingPageNumbers(
        para.text.replace(LIST_NUMBERED_RE, "").replace(LIST_BULLET_RE, "")
      );
      if (stripped.length > 0) {
        pendingList.push(stripped);
        pendingListPage = para.page;
        pendingListTopY = para.topY;
      }
    } else if (kind === "formula") {
      flushList();
      flushCode();
      blockEntries.push({
        block: { type: "formula", text: para.text, page: para.page },
        page: para.page,
        topY: para.topY
      });
    } else {
      flushList();
      flushCode();
      if (kind === "heading") {
        const cleaned = stripBleedingPageNumbers(normalizeHeadingNumber(para.text));
        if (cleaned.length === 0 || isEmptyFurniture(cleaned)) continue;
        blockEntries.push({
          block: {
            type: "heading",
            level: headingLevel(para.fontSize, bodySize),
            text: cleaned,
            page: para.page
          },
          page: para.page,
          topY: para.topY
        });
      } else {
        const cleaned = stripBleedingPageNumbers(para.text);
        if (cleaned.length === 0 || isEmptyFurniture(cleaned)) continue;
        const split = splitHeadingFromBody(cleaned);
        if (split) {
          blockEntries.push({
            block: { type: "heading", level: split.level, text: split.heading, page: para.page },
            page: para.page,
            topY: para.topY
          });
          if (split.body.length > 0) {
            blockEntries.push({
              block: { type: "paragraph", text: split.body, page: para.page },
              page: para.page,
              topY: para.topY
            });
          }
        } else {
          blockEntries.push({
            block: { type: "paragraph", text: cleaned, page: para.page },
            page: para.page,
            topY: para.topY
          });
        }
      }
    }
  }
  flushList();
  flushCode();
  if (matchedImages.length > 0) {
    const sortedImages = matchedImages.slice().sort(
      (a, b) => a.placement.page - b.placement.page || b.placement.centerY - a.placement.centerY
    );
    for (const { image, placement } of sortedImages) {
      const imgBlock = {
        type: "image",
        page: placement.page,
        imageData: image.bytes,
        imageFormat: image.format,
        imagePixelWidth: image.pixelWidth,
        imagePixelHeight: image.pixelHeight
      };
      let insertIdx = blockEntries.length;
      for (let i = 0; i < blockEntries.length; i++) {
        const entry = blockEntries[i];
        if (entry.page === placement.page && entry.topY > placement.centerY) {
          insertIdx = i;
          break;
        }
        if (entry.page > placement.page) {
          insertIdx = i;
          break;
        }
      }
      blockEntries.splice(insertIdx, 0, { block: imgBlock, page: placement.page, topY: placement.centerY });
    }
  }
  for (const t of tableEntries) {
    let insertIdx = blockEntries.length;
    for (let i = 0; i < blockEntries.length; i++) {
      const entry = blockEntries[i];
      if (entry.page === t.page && entry.topY > t.topY) {
        insertIdx = i;
        break;
      }
      if (entry.page > t.page) {
        insertIdx = i;
        break;
      }
    }
    blockEntries.splice(insertIdx, 0, t);
  }
  function dropRepeatedEdgeText(lines, pageCount) {
    if (pageCount < 8) return lines;
    const norm2 = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();
    const pagesByText = /* @__PURE__ */ new Map();
    for (const l of lines) {
      const t = norm2(l.text);
      if (!t || t.length > 80) continue;
      const edge = l.y >= l.pageHeight * 0.9 || l.y <= l.pageHeight * 0.1;
      if (!edge) continue;
      if (!pagesByText.has(t)) pagesByText.set(t, /* @__PURE__ */ new Set());
      pagesByText.get(t).add(l.page);
    }
    const thr = Math.max(4, Math.floor(pageCount * 0.4));
    const drop = /* @__PURE__ */ new Set();
    for (const [t, pages] of pagesByText) if (pages.size >= thr) drop.add(t);
    if (drop.size === 0) return lines;
    console.log(`[capture/flow] dropped ${drop.size} repeated running head/foot texts`);
    return lines.filter((l) => !drop.has(norm2(l.text)));
  }
  function mergeSplitParagraphs(entries) {
    const noTerminal = (s) => /[a-z0-9,;:)\]}]$/i.test(s.trim()) && !/[.!?…]$/.test(s.trim());
    const continuation = (s) => /^[a-z0-9("'“(\[]/.test(s.trim());
    const out = [];
    for (const e of entries) {
      const prev = out[out.length - 1];
      const pt = prev?.block.type === "paragraph" ? prev.block.text ?? "" : null;
      const et = e.block.type === "paragraph" ? e.block.text ?? "" : null;
      if (prev && pt !== null && et !== null && prev.page === e.page && noTerminal(pt) && continuation(et) && pt.length + et.length < 4e3) {
        prev.block.text = `${pt.trim()} ${et.trim()}`;
        continue;
      }
      out.push(e);
    }
    return out;
  }
  const mergedEntries = mergeSplitParagraphs(blockEntries);
  const blocks = mergedEntries.map((e) => e.block);
  return { blocks, pageCount: max, imageCount };
}
function groupItemsIntoLines(items, pageNumber, pageWidth, pageHeight) {
  const fragments = [];
  for (const raw of items) {
    if (!isTextItem(raw)) continue;
    const str = raw.str;
    if (str.trim() === "") continue;
    const tm = raw.transform;
    const fontSize = Math.abs(tm[3] || 0);
    fragments.push({
      str,
      fontSize,
      fontName: raw.fontName || "",
      y: tm[5],
      x: tm[4]
    });
  }
  if (fragments.length === 0) return [];
  const gutter = findColumnGutter(fragments, pageWidth);
  if (gutter !== null) {
    const left = fragments.filter((f) => f.x < gutter);
    const right = fragments.filter((f) => f.x >= gutter);
    return [
      ...groupColumnIntoLines(left, pageNumber, pageWidth, pageHeight, 0),
      ...groupColumnIntoLines(right, pageNumber, pageWidth, pageHeight, 1)
    ];
  }
  return groupColumnIntoLines(fragments, pageNumber, pageWidth, pageHeight, 0);
}
function findColumnGutter(fragments, pageWidth) {
  if (fragments.length < 8) return null;
  const xs = fragments.map((f) => f.x).sort((a, b) => a - b);
  let bestGap = 0;
  let bestSplit = 0;
  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i] - xs[i - 1];
    if (gap > bestGap) {
      const mid = (xs[i] + xs[i - 1]) / 2;
      if (mid > pageWidth * 0.28 && mid < pageWidth * 0.72) {
        bestGap = gap;
        bestSplit = (xs[i] + xs[i - 1]) / 2;
      }
    }
  }
  if (bestGap < pageWidth * 0.15) return null;
  const tolerance = 6;
  let overlap = 0;
  for (const f of fragments) {
    const onLeft = f.x < bestSplit;
    if (!onLeft) continue;
    if (f.str.trim().length < 10) continue;
    const partner = fragments.find(
      (g) => g.x >= bestSplit && Math.abs(g.y - f.y) < tolerance && g.str.trim().length >= 10
    );
    if (partner) overlap++;
  }
  if (overlap < 3) return null;
  return bestSplit;
}
function groupColumnIntoLines(fragments, pageNumber, pageWidth, pageHeight, col) {
  fragments.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let cur = null;
  for (const f of fragments) {
    if (!cur) {
      cur = { items: [f], baseline: f.y, fontSize: f.fontSize };
    } else if (Math.abs(f.y - cur.baseline) < cur.fontSize * 0.5) {
      cur.items.push(f);
    } else {
      lines.push(finishLine(cur, pageNumber, pageWidth, pageHeight, col));
      cur = { items: [f], baseline: f.y, fontSize: f.fontSize };
    }
  }
  if (cur) lines.push(finishLine(cur, pageNumber, pageWidth, pageHeight, col));
  return lines;
}
function finishLine(cur, pageNumber, pageWidth, pageHeight, col) {
  const sorted = cur.items.slice().sort((a, b) => a.x - b.x);
  const text = sorted.map((i) => i.str).join("").trim();
  const fontSize = Math.max(...cur.items.map((i) => i.fontSize));
  const fontName = cur.items[0]?.fontName ?? "";
  const x = Math.min(...cur.items.map((i) => i.x));
  const segments = [];
  for (const f of sorted) {
    const last = segments[segments.length - 1];
    if (last && f.x - (last.x + last.text.length * fontSize * 0.5) > TABLE_COL_GAP_PT) {
      segments.push({ text: f.str, x: f.x });
    } else if (last) {
      last.text += f.str;
    } else {
      segments.push({ text: f.str, x: f.x });
    }
  }
  return { text, fontSize, fontName, y: cur.baseline, x, page: pageNumber, pageWidth, pageHeight, col, segments };
}

// electron/pdf/typeset/flow.ts
var fs2 = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var import_fontkit = __toESM(require("@pdf-lib/fontkit"));
var import_pdf_lib2 = require("pdf-lib");

// electron/pdf/typeset/measure.ts
function classifyChar(ch) {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 19968 && cp <= 40959 || // CJK unified ideographs
  cp >= 13312 && cp <= 19903 || // extension A
  cp >= 12288 && cp <= 12351 || // CJK symbols & punctuation
  cp >= 65280 && cp <= 65519 || // full-width forms
  cp >= 63744 && cp <= 64255) {
    return "cjk";
  }
  return "latin";
}
function atomize(text) {
  const atoms = [];
  const chars = Array.from(String(text ?? ""));
  let latin = "";
  const flushLatin = (space) => {
    if (latin.length > 0) {
      atoms.push({ script: "latin", text: latin, space });
      latin = "";
    } else if (space && atoms.length > 0) {
      atoms[atoms.length - 1].space = true;
    }
  };
  for (const ch of chars) {
    if (ch === " " || ch === "	") {
      flushLatin(true);
      continue;
    }
    if (classifyChar(ch) === "cjk") {
      flushLatin(false);
      atoms.push({ script: "cjk", text: ch, space: false });
    } else {
      latin += ch;
    }
  }
  flushLatin(false);
  return atoms;
}
function measureRun(script, text, fonts, size) {
  const font = script === "cjk" ? fonts.cjk : fonts.latin;
  try {
    return font.widthOfTextAtSize(text, size);
  } catch {
    return text.length * size * (script === "cjk" ? 1 : 0.5);
  }
}
function atomWidth(atom, fonts, size) {
  return measureRun(atom.script, atom.text, fonts, size);
}
function spaceWidth(fonts, size) {
  return measureRun("latin", " ", fonts, size);
}
function buildLine(atoms, fonts, size) {
  const runs = [];
  let total = 0;
  for (let idx = 0; idx < atoms.length; idx++) {
    const atom = atoms[idx];
    const leadingSpace = idx > 0 && atoms[idx - 1].space;
    if (leadingSpace) {
      const sw = spaceWidth(fonts, size);
      const last2 = runs[runs.length - 1];
      if (last2 && last2.script === "latin") {
        last2.text += " ";
        last2.width += sw;
      } else {
        runs.push({ script: "latin", text: " ", width: sw });
      }
      total += sw;
    }
    const w = atomWidth(atom, fonts, size);
    const last = runs[runs.length - 1];
    if (last && last.script === atom.script) {
      last.text += atom.text;
      last.width += w;
    } else {
      runs.push({ script: atom.script, text: atom.text, width: w });
    }
    total += w;
  }
  return { runs, width: total };
}
function wrapMixed(text, fonts, size, maxWidth) {
  const lines = [];
  const sw = spaceWidth(fonts, size);
  for (const para of String(text ?? "").split("\n")) {
    const atoms = atomize(para);
    if (atoms.length === 0) {
      lines.push({ runs: [], width: 0 });
      continue;
    }
    let cur = [];
    let curWidth = 0;
    const flushLine = () => {
      lines.push(buildLine(cur, fonts, size));
      cur = [];
      curWidth = 0;
    };
    for (const atom of atoms) {
      const w = atomWidth(atom, fonts, size);
      const gap = cur.length > 0 && cur[cur.length - 1].space ? sw : 0;
      if (cur.length > 0 && curWidth + gap + w > maxWidth) {
        flushLine();
        cur.push(atom);
        curWidth = w;
      } else {
        cur.push(atom);
        curWidth += gap + w;
      }
    }
    if (cur.length > 0) flushLine();
  }
  return lines;
}

// electron/pdf/typeset/flow.ts
var PAGE_W = 595;
var PAGE_H = 842;
var MARGIN = 50;
var CONTENT_LEFT = MARGIN;
var CONTENT_RIGHT = PAGE_W - MARGIN;
var CONTENT_TOP = PAGE_H - MARGIN;
var CONTENT_BOTTOM = MARGIN;
var CONTENT_W = CONTENT_RIGHT - CONTENT_LEFT;
var STYLES = {
  body: { size: 11, lineHeight: 16, before: 0, after: 6 },
  h1: { size: 18, lineHeight: 24, before: 16, after: 10 },
  h2: { size: 15, lineHeight: 20, before: 12, after: 8 },
  h3: { size: 13, lineHeight: 17, before: 10, after: 6 },
  h4: { size: 12, lineHeight: 16, before: 8, after: 6 },
  code: { size: 9.5, lineHeight: 13, before: 4, after: 6 }
};
var INK = (0, import_pdf_lib2.rgb)(0, 0, 0);
var CODE_BG = (0, import_pdf_lib2.rgb)(0.95, 0.95, 0.95);
var MUTED = (0, import_pdf_lib2.rgb)(0.55, 0.55, 0.55);
var IMAGE_SPACING_BEFORE = 8;
var IMAGE_SPACING_AFTER = 14;
function drawLine(page, line, x, baselineY, fonts, size, color = INK, heading = false) {
  let cx = x;
  const runFont = (run) => {
    if (run.script === "mono") return fonts.mono;
    return heading ? fonts.bold : fonts.regular;
  };
  for (const run of line.runs) {
    if (run.text.length === 0) continue;
    const text = run.text.replace(/[\u2022\u25AA\u25A0\u25A1\u25CF\u25E6\u2610\u2612\u25B8\u25B9\uE000-\uF8FF]/g, "");
    if (text.length === 0) continue;
    const f = runFont(run);
    try {
      page.drawText(text, {
        x: cx,
        y: baselineY,
        size,
        font: f,
        color
      });
    } catch {
    }
    try {
      cx += f.widthOfTextAtSize(text, size);
    } catch {
      cx += run.width;
    }
  }
}
function cleanText(text) {
  let t = text;
  t = t.replace(/^(?:Table|Fig(?:ure)?)\s*(\d+)\s*[.:]\s*/i, (_m, num) => `\u8868${num} `);
  t = t.replace(/([a-z])-\s+([a-z])/g, "$1$2");
  return t;
}
async function typesetFlow(blocks, outputPath, options = {}) {
  const doc = await import_pdf_lib2.PDFDocument.create();
  doc.registerFontkit(import_fontkit.default);
  const regularPath = options.fontPath ?? path.resolve(process.cwd(), "assets", "fonts", "MicrosoftYaHei-Regular-subset.ttf");
  const fontsDir = path.dirname(regularPath);
  const boldPath = path.join(fontsDir, "MicrosoftYaHei-Bold-subset.ttf");
  const monoPath = path.join(fontsDir, "Consolas-subset.ttf");
  const regular = await doc.embedFont(fs2.readFileSync(regularPath), { subset: false });
  const bold = await doc.embedFont(fs2.readFileSync(boldPath), { subset: false });
  const mono = await doc.embedFont(fs2.readFileSync(monoPath), { subset: false });
  const fonts = { regular, bold, mono };
  const bodyAdapter = { cjk: regular, latin: regular };
  const headingAdapter = { cjk: bold, latin: bold };
  const codeAdapter = { cjk: regular, latin: mono };
  const imageCache = /* @__PURE__ */ new WeakMap();
  const getEmbeddedImage = async (block) => {
    const data = block.imageData;
    if (!data || data.length === 0) return null;
    const cached = imageCache.get(data);
    if (cached) return cached;
    try {
      const img = block.imageFormat === "png" ? await doc.embedPng(data) : await doc.embedJpg(data);
      imageCache.set(data, img);
      return img;
    } catch (err) {
      console.warn(`[typeset/flow] failed to embed image: ${err.message}`);
      return null;
    }
  };
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let baselineY = CONTENT_TOP - STYLES.body.size;
  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    baselineY = CONTENT_TOP - STYLES.body.size;
  };
  const drawPageNumber = () => {
    const num = doc.getPageCount();
    page.drawText(String(num), {
      x: PAGE_W / 2 - 10,
      y: CONTENT_BOTTOM - 20,
      size: 9,
      font: fonts.regular,
      color: MUTED
    });
  };
  for (const block of blocks) {
    if (block.type === "image") {
      const img = await getEmbeddedImage(block);
      if (!img) continue;
      const pxW = block.imagePixelWidth ?? img.width;
      const pxH = block.imagePixelHeight ?? img.height;
      const scale = Math.min(1, CONTENT_W / pxW);
      const drawW = pxW * scale;
      const drawH = pxH * scale;
      const totalHeight2 = IMAGE_SPACING_BEFORE + drawH + IMAGE_SPACING_AFTER;
      if (baselineY - totalHeight2 < CONTENT_BOTTOM) {
        drawPageNumber();
        newPage();
      }
      const imgX = CONTENT_LEFT + (CONTENT_W - drawW) / 2;
      const imgY = baselineY - IMAGE_SPACING_BEFORE - drawH;
      page.drawImage(img, {
        x: imgX,
        y: imgY,
        width: drawW,
        height: drawH
      });
      baselineY -= totalHeight2;
      continue;
    }
    let style = STYLES.body;
    let text = "";
    let isCode = false;
    let isList = false;
    let isHeading = false;
    if (block.type === "heading") {
      const lv = block.level ?? 4;
      style = lv === 1 ? STYLES.h1 : lv === 2 ? STYLES.h2 : lv === 3 ? STYLES.h3 : STYLES.h4;
      text = cleanText(block.text ?? "");
      isHeading = true;
    } else if (block.type === "code") {
      style = STYLES.code;
      text = block.code ?? "";
      isCode = true;
    } else if (block.type === "list") {
      style = STYLES.body;
      isList = true;
    } else {
      style = STYLES.body;
      text = cleanText(block.text ?? "");
    }
    if (isList) {
      const items = block.items ?? [];
      const bulletW = 8;
      const listIndent = 20;
      const listLeft = CONTENT_LEFT + listIndent;
      const listW = CONTENT_W - listIndent;
      let totalHeight2 = style.before;
      const wrappedItems = [];
      for (const item of items) {
        const cleanItem = cleanText(item.replace(/^[\s\u2022\u25CF\u25AA\u25E6\u25A0\u25A1\u2610\u2612\u25B8\u25B9\u25BA\u25BB\uE000-\uF8FF*\-–—―·•]+/, ""));
        const wrapped2 = wrapMixed(cleanItem, bodyAdapter, style.size, listW - bulletW);
        wrappedItems.push(wrapped2);
        totalHeight2 += wrapped2.length * style.lineHeight;
      }
      totalHeight2 += style.after;
      if (baselineY - totalHeight2 < CONTENT_BOTTOM) {
        drawPageNumber();
        newPage();
      }
      baselineY -= style.before;
      for (let i = 0; i < wrappedItems.length; i++) {
        const lines = wrappedItems[i];
        const bulletY = baselineY + style.size * 0.35;
        page.drawCircle({
          x: CONTENT_LEFT + 6,
          y: bulletY,
          size: 2,
          color: INK
        });
        for (const line of lines) {
          drawLine(page, line, listLeft, baselineY, fonts, style.size);
          baselineY -= style.lineHeight;
        }
      }
      baselineY -= style.after;
      continue;
    }
    if (block.type === "table") {
      const cells = block.cells ?? [];
      const rows = cells.length;
      const cols = block.cols ?? (cells[0]?.length ?? 0);
      if (rows > 0 && cols > 0) {
        const padX = 6;
        const cellFontSize = STYLES.body.size;
        const MIN_COL_W = 48;
        const anchorW = block.colWidths && block.colWidths.length === cols ? block.colWidths.slice() : new Array(cols).fill(1 / cols);
        const weights = new Array(cols).fill(0);
        {
          const colMax = new Array(cols).fill(1);
          for (const row of cells)
            for (let c = 0; c < cols; c++) colMax[c] = Math.max(colMax[c], (row[c] ?? "").trim().length);
          const csum = colMax.reduce((a, b) => a + b, 0);
          for (let c = 0; c < cols; c++) {
            weights[c] = 0.45 * anchorW[c] + 0.55 * (colMax[c] / csum);
          }
          const wsum = weights.reduce((a, b) => a + b, 0) || 1;
          for (let c = 0; c < cols; c++) weights[c] /= wsum;
          let lifted = 0;
          let rest = 0;
          for (let c = 0; c < cols; c++) {
            const wPt = weights[c] * CONTENT_W;
            if (wPt < MIN_COL_W) {
              lifted += MIN_COL_W - wPt;
              weights[c] = MIN_COL_W / CONTENT_W;
            } else {
              rest += wPt;
            }
          }
          if (lifted > 0 && rest > lifted) {
            const scale = (rest - lifted) / rest;
            for (let c = 0; c < cols; c++) {
              const wPt = weights[c] * CONTENT_W;
              if (wPt > MIN_COL_W) weights[c] = wPt * scale / CONTENT_W;
            }
          }
        }
        const colEdges = [CONTENT_LEFT];
        for (let c = 0; c < cols; c++) colEdges.push(colEdges[c] + weights[c] * CONTENT_W);
        const colWs = [];
        for (let c = 0; c < cols; c++) colWs.push(Math.max(20, colEdges[c + 1] - colEdges[c] - padX * 2));
        const wrappedCells = cells.map(
          (row) => row.map((cell, c) => wrapMixed(cleanText(cell ?? ""), bodyAdapter, cellFontSize, colWs[c]))
        );
        const rowHeights = wrappedCells.map((row) => {
          const lines = Math.max(1, ...row.map((w) => w.length));
          return lines * STYLES.body.lineHeight + 6;
        });
        baselineY -= STYLES.body.before;
        let segTop = null;
        let segBottom = 0;
        const closeSeg = () => {
          if (segTop === null) return;
          page.drawRectangle({
            x: CONTENT_LEFT,
            y: segBottom,
            width: CONTENT_W,
            height: segTop - segBottom,
            borderColor: (0, import_pdf_lib2.rgb)(0.7, 0.7, 0.7),
            borderWidth: 0.6
          });
          for (let c = 1; c < cols; c++) {
            page.drawLine({
              start: { x: colEdges[c], y: segBottom },
              end: { x: colEdges[c], y: segTop },
              thickness: 0.4,
              color: (0, import_pdf_lib2.rgb)(0.8, 0.8, 0.8)
            });
          }
          segTop = null;
        };
        const drawRow = (r) => {
          const rh = rowHeights[r];
          if (segTop === null) segTop = baselineY;
          const rowTop = baselineY;
          const rowBottom = baselineY - rh;
          if (block.hasHeader && r === 0) {
            page.drawRectangle({
              x: CONTENT_LEFT,
              y: rowBottom,
              width: CONTENT_W,
              height: rh,
              color: CODE_BG
            });
          }
          for (let c = 0; c < cols; c++) {
            const cellX = colEdges[c] + padX;
            let cy = rowTop - STYLES.body.lineHeight + 2;
            for (const line of wrappedCells[r][c]) {
              drawLine(page, line, cellX, cy, fonts, cellFontSize);
              cy -= STYLES.body.lineHeight;
            }
          }
          page.drawLine({
            start: { x: CONTENT_LEFT, y: rowTop },
            end: { x: CONTENT_LEFT + CONTENT_W, y: rowTop },
            thickness: 0.4,
            color: (0, import_pdf_lib2.rgb)(0.8, 0.8, 0.8)
          });
          baselineY = rowBottom;
          segBottom = rowBottom;
        };
        for (let r = 0; r < rows; r++) {
          if (segTop !== null && baselineY - rowHeights[r] < CONTENT_BOTTOM) {
            closeSeg();
            drawPageNumber();
            newPage();
            if (block.hasHeader) drawRow(0);
          }
          drawRow(r);
        }
        closeSeg();
        baselineY -= STYLES.body.after;
      }
      continue;
    }
    if (text.trim().length === 0) continue;
    if (isCode) {
      const codeIndent = 10;
      const codeLeft = CONTENT_LEFT + codeIndent;
      const codeW = CONTENT_W - codeIndent;
      const rawLines = text.split("\n");
      const wrappedLines = [];
      for (const rl of rawLines) {
        const wl = wrapMixed(rl, codeAdapter, style.size, codeW);
        wrappedLines.push(...wl);
      }
      const totalHeight2 = style.before + wrappedLines.length * style.lineHeight + style.after;
      if (baselineY - totalHeight2 < CONTENT_BOTTOM) {
        drawPageNumber();
        newPage();
      }
      const rectY = baselineY - wrappedLines.length * style.lineHeight - style.after + 2;
      const rectH = wrappedLines.length * style.lineHeight + style.before + style.after;
      page.drawRectangle({
        x: CONTENT_LEFT + 2,
        y: rectY,
        width: CONTENT_W - 4,
        height: rectH,
        color: CODE_BG
      });
      baselineY -= style.before;
      for (const line of wrappedLines) {
        drawLine(page, line, codeLeft, baselineY, fonts, style.size, (0, import_pdf_lib2.rgb)(0.15, 0.15, 0.15));
        baselineY -= style.lineHeight;
      }
      baselineY -= style.after;
      continue;
    }
    const wrapAdapter = isHeading ? headingAdapter : bodyAdapter;
    const wrapped = wrapMixed(text, wrapAdapter, style.size, CONTENT_W);
    const totalHeight = style.before + wrapped.length * style.lineHeight + style.after;
    if (baselineY - totalHeight < CONTENT_BOTTOM) {
      drawPageNumber();
      newPage();
    }
    baselineY -= style.before;
    for (const line of wrapped) {
      drawLine(page, line, CONTENT_LEFT, baselineY, fonts, style.size, INK, isHeading);
      baselineY -= style.lineHeight;
    }
    baselineY -= style.after;
  }
  drawPageNumber();
  const outBytes = await doc.save();
  fs2.writeFileSync(outputPath, outBytes);
  return {
    outputPath,
    pageCount: doc.getPageCount(),
    fileSize: outBytes.byteLength
  };
}

// electron/pdf/typeset/htmlFlow.ts
var import_common = __toESM(require("highlight.js/lib/common"));
var CHAPTER_RE = /^(第\s*\d+\s*章|章\s|Chapter\s*\d+|Appendix\b)/i;
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
var HLJS_GUARD_CHARS = 2e4;
var HLJS_SUBSET = [
  "typescript",
  "javascript",
  "python",
  "bash",
  "shell",
  "json",
  "yaml",
  "sql",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "rust",
  "xml",
  "markdown",
  "diff",
  "dockerfile",
  "ini",
  "properties"
];
var HLJS_LABEL_MIN_RELEVANCE = 5;
function highlightedCode(code) {
  try {
    const r = import_common.default.highlightAuto(code.slice(0, HLJS_GUARD_CHARS), HLJS_SUBSET);
    return { html: r.value, lang: r.language && r.relevance >= HLJS_LABEL_MIN_RELEVANCE ? r.language : "" };
  } catch {
    return { html: esc(code), lang: "" };
  }
}
function dataUri(block) {
  if (!block.imageData || block.imageData.length === 0) return null;
  const mime = block.imageFormat === "png" ? "image/png" : "image/jpeg";
  const base64 = Buffer.from(block.imageData.buffer, block.imageData.byteOffset, block.imageData.byteLength).toString("base64");
  return `data:${mime};base64,${base64}`;
}
function buildTable(block) {
  const cells = block.cells ?? [];
  const cols = block.cols ?? (cells[0]?.length ?? 0);
  if (cells.length === 0 || cols === 0) return "";
  const widths = block.colWidths ?? [];
  const colgroup = widths.length === cols ? `<colgroup>${widths.map((w) => `<col style="width:${(w * 100).toFixed(1)}%">`).join("")}</colgroup>` : "";
  const rows = cells.map((row, r) => {
    const tag = r === 0 && block.hasHeader ? "th" : "td";
    const cellsHtml = Array.from({ length: cols }, (_, c) => `<${tag}>${esc(row[c] ?? "")}</${tag}>`).join("");
    return `<tr>${cellsHtml}</tr>`;
  }).join("");
  return `<table class="structured-table">${colgroup}<tbody>${rows}</tbody></table>`;
}
function blocksToHtml(blocks, opts = {}) {
  const lh = opts.lineHeight ?? 1.6;
  const fb = opts.fallbackKeys;
  const cls = (key, base = "") => {
    const c = base ? [base] : [];
    if (fb?.has(key)) c.push("source-fallback");
    return c.length ? ` class="${c.join(" ")}"` : "";
  };
  const parts = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    switch (b.type) {
      case "heading": {
        const lv = Math.min(4, Math.max(1, b.level ?? 4));
        const chapter = CHAPTER_RE.test((b.text ?? "").trim());
        parts.push(`<h${lv}${cls(`b${bi}`, chapter ? "chapter-heading" : "")}>${esc(b.text ?? "")}</h${lv}>`);
        break;
      }
      case "paragraph":
        if ((b.text ?? "").trim()) parts.push(`<p${cls(`b${bi}`)}>${esc(b.text)}</p>`);
        break;
      case "list":
        if ((b.items ?? []).length > 0) {
          parts.push(`<ul>${(b.items ?? []).map((x, j) => `<li${cls(`b${bi}-${j}`)}>${esc(x)}</li>`).join("")}</ul>`);
        }
        break;
      case "code":
        if ((b.code ?? "").trim()) {
          const { html, lang } = highlightedCode(b.code);
          const shown = b.code.length > HLJS_GUARD_CHARS ? esc(b.code) : html;
          parts.push(`<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ""}><code class="hljs">${shown}</code></pre>`);
        }
        break;
      case "formula":
        if ((b.text ?? "").trim()) parts.push(`<pre class="formula">${esc(b.text)}</pre>`);
        break;
      case "table":
        parts.push(buildTable(b));
        break;
      case "image": {
        const uri = dataUri(b);
        if (!uri) break;
        const pxW = b.imagePixelWidth ?? 0;
        const pxH = b.imagePixelHeight ?? 0;
        parts.push(`<figure><img src="${uri}"${pxW && pxH ? ` width="${pxW}" height="${pxH}"` : ""}></figure>`);
        break;
      }
    }
  }
  const css = `
@page { size: A4; margin: 20mm 18mm 20mm 18mm; }
html { font-family: "Microsoft YaHei", "Microsoft YaHei UI", "Segoe UI", sans-serif; }
body { margin:0; font-size: 11pt; line-height: ${lh}; color:#111; }
h1 { font-size: 18pt; line-height:1.35; margin: 16pt 0 9pt; break-after: avoid; }
h2 { font-size: 15pt; line-height:1.35; margin: 13pt 0 7pt; break-after: avoid; }
h3 { font-size: 13pt; line-height:1.35; margin: 11pt 0 6pt; break-after: avoid; }
h4 { font-size: 12pt; line-height:1.35; margin: 9pt 0 5pt; break-after: avoid; }
.chapter-heading { break-before: page; margin-top: 0; }
p { text-align: justify; orphans: 2; widows: 2; margin: 0 0 6pt; }
ul { margin: 0 0 8pt 6pt; padding-left: 16pt; }
li { margin-bottom: 3pt; break-inside: avoid; text-align: justify; }
.structured-table { width:100%; border-collapse: collapse; font-size: 9.5pt; margin: 8pt 0 12pt; break-inside: auto; }
.structured-table th, .structured-table td { border: 1px solid #9ca3af; padding: 5px 7px; vertical-align: top; overflow-wrap: anywhere; text-align: left; }
.structured-table tr:first-child th { font-weight: 600; background: #f1f4f8; }
.structured-table tr { break-inside: avoid; }
.code { position: relative; font-family: Consolas, "Cascadia Mono", monospace; font-size: 9pt; background: #f6f8fa; border: 1px solid #e3e6ea; border-radius: 6px; padding: 9pt 10pt 8pt; overflow-wrap: anywhere; margin: 8pt 0; white-space: pre-wrap; break-inside: auto; }
.code code.hljs { background: transparent; padding: 0; font-family: inherit; font-size: inherit; }
.code[data-lang] { padding-top: 16pt; }
.code[data-lang]::before { content: attr(data-lang); position: absolute; top: 3pt; right: 8pt; font-size: 7pt; color: #8a929c; text-transform: uppercase; letter-spacing: .04em; font-family: "Segoe UI", sans-serif; }
/* highlight.js token palette (github-light-ish) \u2014 inlined so print keeps colors */
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag { color:#cf222e; }
.hljs-string,.hljs-regexp,.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string { color:#0a3069; }
.hljs-number,.hljs-symbol,.hljs-bullet { color:#0550ae; }
.hljs-comment,.hljs-quote { color:#6e7781; font-style: italic; }
.hljs-function .hljs-title,.hljs-title.function_,.hljs-section { color:#8250df; }
.hljs-title.class_,.hljs-class .hljs-title,.hljs-type,.hljs-built_in,.hljs-title { color:#953800; }
.hljs-variable,.hljs-template-variable,.hljs-identifier,.hljs-attr,.hljs-attribute .hljs-attr { color:#0550ae; }
.hljs-meta,.hljs-punctuation { color:#24292f; }
.hljs-tag { color:#116329; }
.hljs-name { color:#116329; }
.hljs-deletion { color:#cf222e; background:#ffebe9; }
.hljs-addition { color:#116329; background:#dafbe1; }
.hljs-emphasis { font-style: italic; } .hljs-strong { font-weight: 600; }
.formula { font-family: Consolas, monospace; font-size: 9.5pt; margin: 8pt 0; break-inside: avoid; white-space: pre-wrap; }
figure { margin: 10pt auto; text-align:center; break-inside: avoid; }
figure img { max-width: 100%; max-height: 190mm; object-fit: contain; }
.source-fallback { border-left: 3px solid #e8934c; padding-left: 8pt; }
.source-fallback::after { content: " \u3014\u539F\u6587\u4FDD\u7559\u3015"; color:#b26a2e; font-size: 8.5pt; }
`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>translated</title><style>${css}</style></head><body>
${parts.join("\n")}
</body></html>`;
}

// electron/pdf/typeset/chromiumPrint.ts
var import_node_fs2 = require("node:fs");
var import_node_os = require("node:os");
var import_node_path2 = require("node:path");
var PRINT_TIMEOUT_MS = 9e4;
async function printHtmlToPdf(html, outPath) {
  const electronVer = process.versions.electron;
  if (!electronVer) throw new Error("chromiumPrint: not running inside Electron");
  const { BrowserWindow } = require("electron");
  const file = (0, import_node_path2.join)((0, import_node_os.tmpdir)(), `entransfer-compose-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  await import_node_fs2.promises.writeFile(file, html, "utf8");
  let win = null;
  try {
    win = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { sandbox: true, backgroundThrottling: false } });
    await win.loadFile(file);
    await new Promise((r) => setTimeout(r, 500));
    const data = await withTimeout(
      win.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: "<div></div>",
        footerTemplate: '<div style="width:100%;text-align:center;font-size:8px;color:#8a8a8a;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
      }),
      PRINT_TIMEOUT_MS,
      "printToPDF timeout"
    );
    if (!data || data.length < 1024) throw new Error(`printToPDF produced ${data?.length ?? 0} bytes`);
    const head = data.subarray(0, 5).toString("latin1");
    const tail = data.subarray(-1024).toString("latin1");
    if (head !== "%PDF-" || !tail.includes("%%EOF")) throw new Error("printToPDF produced invalid PDF");
    await import_node_fs2.promises.mkdir((0, import_node_path2.join)(outPath, ".."), { recursive: true });
    await import_node_fs2.promises.writeFile(outPath, data);
  } finally {
    win?.destroy();
    await import_node_fs2.promises.rm(file, { force: true }).catch(() => void 0);
  }
}
function withTimeout(p, ms, msg) {
  return new Promise((resolve3, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve3(v);
    }, (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

// electron/pdf/validate.ts
var CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
var SENTINEL_RE = /§[A-Z]§/g;
var NUMBER_RE = /\d+(?:[.,]\d+)*/g;
var LATIN_WORD_RE = /[A-Za-z][A-Za-z'’-]{3,}/g;
function matches(text, re) {
  return text.match(new RegExp(re.source, re.flags)) ?? [];
}
function fail(...reasons) {
  return { ok: false, reasons };
}
function validateModelOutput(masked, raw) {
  const reasons = [];
  if (raw.trim().length === 0) return fail("empty");
  const want = matches(masked, SENTINEL_RE);
  if (want.length > 0) {
    const counts = /* @__PURE__ */ new Map();
    for (const t of matches(raw, SENTINEL_RE)) counts.set(t, (counts.get(t) ?? 0) + 1);
    const missing = [];
    for (const t of want) {
      const c = (counts.get(t) ?? 0) - 1;
      if (c < 0) missing.push(t);
      else counts.set(t, c);
    }
    if (missing.length > 0) reasons.push(`sentinel-lost:${missing.join("")}`);
  }
  return reasons.length ? fail(...reasons) : { ok: true, reasons: [] };
}
function validateRestored(source, restored) {
  const reasons = [];
  const src = source.trim();
  const out = restored.trim();
  if (out.length === 0) return fail("empty");
  if (SENTINEL_RE.test(out)) reasons.push("sentinel-leak");
  SENTINEL_RE.lastIndex = 0;
  const translatable = matches(src, LATIN_WORD_RE).length >= 4 || src.length > 60;
  if (translatable && (out === src || src.length > 40 && norm(out) === norm(src))) reasons.push("echo");
  if (!CJK_RE.test(out) && out.length > 100 && matches(out, LATIN_WORD_RE).length >= 3) {
    reasons.push("untranslated-latin");
  }
  const srcNums = matches(src, NUMBER_RE);
  if (srcNums.length > 0) {
    const outNums = new Set(matches(out, NUMBER_RE).flatMap((n) => [n, n.replace(/[.,]/g, "")]));
    const dropped = srcNums.filter((n) => !outNums.has(n) && !outNums.has(n.replace(/[.,]/g, "")));
    const magnitudeRewrite = CJK_RE.test(out) && /万|亿|千|[KMBT]\b|百分/.test(out);
    const tolerance = !CJK_RE.test(out) ? 0 : magnitudeRewrite ? srcNums.length : 1;
    if (dropped.length > tolerance) reasons.push(`number-dropped:${dropped.slice(0, 4).join(",")}`);
  }
  if (src.length > 0) {
    const ratio = out.length / src.length;
    if (ratio < 0.12 || ratio > 2.2) reasons.push(`length-ratio:${ratio.toFixed(2)}`);
  }
  if (/<\/?think|<system|assistant:|```|"schema_version"/i.test(out)) reasons.push("marker-leak");
  return reasons.length ? fail(...reasons) : { ok: true, reasons: [] };
}
function norm(s) {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// electron/models/translation-cache.ts
var import_node_crypto = require("node:crypto");
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
var TranslationCache = class {
  root;
  pending = /* @__PURE__ */ new Map();
  constructor(root) {
    this.root = root;
  }
  static hashKey(k) {
    return (0, import_node_crypto.createHash)("sha256").update(`${k.modelId}\0${k.promptVersion}\0${k.temperature}\0${k.source}\0${k.masked}`, "utf8").digest("hex");
  }
  pathFor(hash) {
    return (0, import_node_path3.join)(this.root, hash.slice(0, 2), hash + ".json");
  }
  async get(hash) {
    try {
      const w = this.pending.get(hash);
      if (w) await w;
      const raw = await import_node_fs3.promises.readFile(this.pathFor(hash), "utf8");
      const e = JSON.parse(raw);
      if (typeof e.translated !== "string" || e.translated.length === 0) return null;
      return e;
    } catch {
      return null;
    }
  }
  async put(hash, translated, tokens) {
    const entry = { key: hash, translated, tokens, createdAt: Date.now() };
    const p = (async () => {
      try {
        const file = this.pathFor(hash);
        await import_node_fs3.promises.mkdir((0, import_node_path3.dirname)(file), { recursive: true });
        const tmp = file + ".tmp";
        await import_node_fs3.promises.writeFile(tmp, JSON.stringify(entry), "utf8");
        await import_node_fs3.promises.rename(tmp, file);
      } catch (err) {
        console.warn("[cache] put failed:", err.message);
      } finally {
        this.pending.delete(hash);
      }
    })();
    this.pending.set(hash, p);
    await p;
  }
  /** Total cached entries (for reporting). */
  async size() {
    let n = 0;
    try {
      const shards = await import_node_fs3.promises.readdir(this.root);
      for (const s of shards) {
        const files = await import_node_fs3.promises.readdir((0, import_node_path3.join)(this.root, s));
        n += files.filter((f) => f.endsWith(".json")).length;
      }
    } catch {
    }
    return n;
  }
};

// electron/pdf/capture/placeholders.ts
var SENTINEL = "\xA7";
var LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
var PATTERNS = [
  /\$[^$\n]+\$/,
  // inline formula $ ... $
  /(?:https?:\/\/|www\.)\S+/,
  // URL
  /\([A-Z][A-Za-z.'’-]*(?:,?\s*\d{4}[a-z]?(?:,?\s*pp?\.?\s*\d+(?:[-–]\d+)?)?)\)/,
  // (Author, 1999, p. 3)
  /(?:Figure|Fig\.|Plate|Table|Scheme)\s+\d+(?:\.\d+)?/,
  // Figure 6.1
  /pp?\.\s*\d+(?:\s*[-–]\d+)?/,
  // p. 12 / pp. 3–5
  /\[[^\]\n]*\]/
  // editorial bracket [1] / [sic]
];
function freezeProtected(text) {
  const placeholders = /* @__PURE__ */ new Map();
  let out = text;
  let index = 0;
  for (let pass = 0; pass < text.length && index < LETTERS.length; pass++) {
    let best = null;
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      const m = re.exec(out);
      if (m && m[0].length > 0 && (!best || m.index < best.start)) {
        best = { start: m.index, end: m.index + m[0].length, value: m[0] };
      }
    }
    if (!best) break;
    const token = `${SENTINEL}${LETTERS[index]}${SENTINEL}`;
    placeholders.set(token, best.value);
    out = out.slice(0, best.start) + token + out.slice(best.end);
    index++;
  }
  return { text: out, placeholders };
}
function restorePlaceholders(text, placeholders) {
  if (placeholders.size === 0) return text;
  return text.replace(/§[A-Z]§/g, (token) => placeholders.get(token) ?? token);
}

// electron/pdf/capture/glossary.ts
var GLOSSARY = {
  EM: "Engineering Manager (EM)",
  EMs: "Engineering Managers (EMs)",
  IC: "Individual Contributor (IC)",
  ICs: "Individual Contributors (ICs)",
  VP: "Vice President (VP)",
  OKR: "Objectives and Key Results (OKR)",
  OKRs: "Objectives and Key Results (OKRs)",
  KPI: "Key Performance Indicator (KPI)",
  KPIs: "Key Performance Indicators (KPIs)",
  ROI: "Return on Investment (ROI)",
  SRE: "Site Reliability Engineer (SRE)",
  SREs: "Site Reliability Engineers (SREs)",
  PR: "Pull Request (PR)",
  PRs: "Pull Requests (PRs)",
  CI: "Continuous Integration (CI)",
  CD: "Continuous Deployment (CD)"
};
var pattern = new RegExp(
  `\\b(${Object.keys(GLOSSARY).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "g"
);
function expandAbbreviations(text) {
  return text.replace(pattern, (match) => GLOSSARY[match] ?? match);
}

// electron/pipeline.ts
function clamp100(n) {
  return Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
}
function resolveFontPath() {
  const appRoot = import_electron.app?.getAppPath?.() ?? process.cwd();
  const candidates = [
    import_node_path4.default.join(appRoot, "assets", "fonts", "MicrosoftYaHei-Regular-subset.ttf"),
    import_node_path4.default.join(appRoot, "assets", "fonts", "NotoSansSC-Subset.ttf")
  ];
  for (const p of candidates) if ((0, import_node_fs5.existsSync)(p)) return p;
  return candidates[0];
}
function buildTasks(blocks) {
  const tasks = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "code" || b.type === "image" || b.type === "table" || b.type === "formula") continue;
    const page = b.page ?? 1;
    if (b.type === "list") {
      const items = b.items ?? [];
      for (let j = 0; j < items.length; j++) {
        if (items[j].trim().length > 0) {
          tasks.push({ id: `b${i}-${j}`, sourceText: items[j], blockIndex: i, listIndex: j, page });
        }
      }
    } else {
      const text = b.text ?? "";
      if (text.trim().length > 0) {
        tasks.push({ id: `b${i}`, sourceText: text, blockIndex: i, page });
      }
    }
  }
  return tasks;
}
function writeBack(blocks, task, translated) {
  const block = blocks[task.blockIndex];
  if (!block) return;
  if (task.listIndex !== void 0) {
    if (block.items) {
      block.items[task.listIndex] = translated;
    }
  } else if (task.cellRow !== void 0 && task.cellCol !== void 0) {
    if (block.cells) {
      block.cells[task.cellRow][task.cellCol] = translated;
    }
  } else {
    block.text = translated;
  }
}
function createPipeline(modelManager, jobsDir, options = {}) {
  const checkpoint = new CheckpointStore(jobsDir);
  const cache = new TranslationCache(import_node_path4.default.join(jobsDir, "..", "translations"));
  const cacheStats = { cacheHits: 0 };
  const pageLimit = options.pageLimit && options.pageLimit > 0 ? options.pageLimit : void 0;
  return {
    async run(job, onProgress, signal) {
      console.log("[pipeline] captureFlow starting...");
      const t0 = Date.now();
      const { blocks, pageCount, imageCount } = await captureFlow(job.inputPath, pageLimit ? { pageLimit } : {});
      job.totalPages = pageCount;
      job.currentPage = 0;
      console.log(`[pipeline] extracted ${blocks.length} blocks (${imageCount} images) from ${pageCount} pages in ${((Date.now() - t0) / 1e3).toFixed(1)}s`);
      onProgress(0, 5);
      await checkpoint.save(job.id, {
        phase: "extracting",
        completedPages: 0,
        progress: 5,
        translatedUnits: 0,
        totalUnits: 0
      });
      if (signal.aborted) return;
      const tasks = buildTasks(blocks);
      const total = tasks.length;
      console.log(`[pipeline] ${total} translation tasks`);
      await checkpoint.save(job.id, {
        phase: "extracting",
        completedPages: 0,
        progress: 5,
        translatedUnits: 0,
        totalUnits: total
      });
      job.status = "translating";
      const priorMeta = await checkpoint.readCaptureMeta(job.id);
      await checkpoint.writeCaptureMeta(job.id, { captureVersion: CAPTURE_VERSION });
      const shapeOk = priorMeta?.captureVersion === CAPTURE_VERSION;
      let recovered = await checkpoint.loadTranslations(job.id);
      if (!shapeOk && recovered.size > 0) {
        console.log(`[pipeline] capture v${priorMeta?.captureVersion ?? "?"} -> v${CAPTURE_VERSION}: ignoring ${recovered.size} stale unit checkpoints (translation cache still applies)`);
        await checkpoint.archiveTranslations(job.id);
        recovered = /* @__PURE__ */ new Map();
      }
      let translatedCount = recovered.size;
      let currentPage = 0;
      for (const task of tasks) {
        const recoveredText = recovered.get(task.id);
        if (recoveredText !== void 0) {
          writeBack(blocks, task, recoveredText);
          if (task.page > currentPage) currentPage = task.page;
        }
      }
      let engine;
      try {
        engine = await modelManager.getEngine();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not\s*download|not-downloaded/i.test(msg)) {
          throw new Error("\u8BF7\u5148\u5728\u6A21\u578B\u7BA1\u7406\u9875\u9762\u4E0B\u8F7D\u7FFB\u8BD1\u6A21\u578B");
        }
        throw err;
      }
      const BATCH_SIZE = 4;
      const SHORT_MAX_CHARS = 250;
      const numberJoin = (ts) => ts.map((t, i) => `${i + 1}. ${t}`).join("\n");
      const numberSplit = (out, n) => {
        const map = /* @__PURE__ */ new Map();
        let last = null;
        for (const line of out.split("\n")) {
          const m = /^\s*(\d+)\s*[.、)．]\s*(.*)$/.exec(line);
          if (m) {
            const idx = Number(m[1]);
            if (idx >= 1 && idx <= n && !map.has(idx)) {
              map.set(idx, [m[2].trim()]);
              last = idx;
            } else if (last !== null && m[2].trim()) {
              map.get(last).push(m[2].trim());
            } else {
              last = null;
            }
          } else if (last !== null && line.trim()) {
            map.get(last).push(line.trim());
          }
        }
        if (map.size !== n) return null;
        return Array.from({ length: n }, (_, i) => map.get(i + 1).join(" ").trim());
      };
      let batchHits = 0;
      let batchFalls = 0;
      const fallbacks = [];
      const noteFallback = (t, r) => {
        if (!r.ok) fallbacks.push({ unit: t.id, page: t.page, reasons: r.reasons });
      };
      const checkBreaker = () => {
        if (translatedCount >= 200 && fallbacks.length / translatedCount > 0.3) {
          throw new Error(`\u7FFB\u8BD1\u8D28\u91CF\u7194\u65AD\uFF1A\u5DF2\u5904\u7406 ${translatedCount} \u5355\u5143\uFF0C\u56DE\u9000 ${fallbacks.length}\uFF08>30%\uFF09\uFF0C\u4E2D\u6B62\u4EFB\u52A1`);
        }
      };
      const translateUnit = async (text) => {
        try {
          return await translateText(engine, text, signal, cache, cacheStats);
        } catch (err) {
          if (signal.aborted) throw err;
          console.warn(`[pipeline] engine failure (${err.message}); reloading engine (CPU failover if hardware-sick) and retrying unit`);
          engine = await modelManager.getEngine();
          return await translateText(engine, text, signal, cache, cacheStats);
        }
      };
      const saveProgress = async () => {
        await checkpoint.save(job.id, {
          phase: "translating",
          completedPages: currentPage,
          progress: clamp100(5 + translatedCount / Math.max(1, total) * 85),
          translatedUnits: translatedCount,
          totalUnits: total
        });
      };
      let taskIdx = 0;
      while (taskIdx < tasks.length) {
        const task = tasks[taskIdx];
        if (signal.aborted) {
          await saveProgress();
          return;
        }
        if (recovered.has(task.id)) {
          taskIdx++;
          continue;
        }
        const BATCH_MIN_CHARS = 60;
        const batchable = (t) => t.sourceText.length >= BATCH_MIN_CHARS && t.sourceText.length <= SHORT_MAX_CHARS;
        const batch = [task];
        let bi = taskIdx + 1;
        while (batch.length < BATCH_SIZE && bi < tasks.length && !recovered.has(tasks[bi].id) && tasks[bi].page === task.page && batchable(tasks[bi]) && batchable(task)) {
          batch.push(tasks[bi]);
          bi++;
        }
        if (batch.length >= 2) {
          const joinedSource = numberJoin(batch.map((t) => t.sourceText));
          let res;
          try {
            res = await translateUnit(joinedSource);
          } catch (err) {
            if (signal.aborted) {
              await saveProgress();
              return;
            }
            throw err;
          }
          const parts = res.ok ? numberSplit(res.text, batch.length) : null;
          if (parts === null) {
            batchFalls++;
            for (const t of batch) {
              if (signal.aborted) {
                await saveProgress();
                return;
              }
              const one = await translateUnit(t.sourceText);
              noteFallback(t, one);
              writeBack(blocks, t, one.text);
              await checkpoint.appendTranslation(job.id, t.id, one.text);
              translatedCount++;
              if (t.page > currentPage) {
                currentPage = t.page;
                job.currentPage = currentPage;
              }
              onProgress(currentPage, clamp100(5 + translatedCount / Math.max(1, total) * 85));
              checkBreaker();
            }
          } else {
            batchHits++;
            for (let k = 0; k < batch.length; k++) {
              writeBack(blocks, batch[k], parts[k].trim());
              await checkpoint.appendTranslation(job.id, batch[k].id, parts[k].trim());
              translatedCount++;
              if (batch[k].page > currentPage) {
                currentPage = batch[k].page;
                job.currentPage = currentPage;
              }
            }
            onProgress(currentPage, clamp100(5 + translatedCount / Math.max(1, total) * 85));
            checkBreaker();
          }
          taskIdx = bi;
        } else {
          let res;
          try {
            res = await translateUnit(task.sourceText);
          } catch (err) {
            if (signal.aborted) {
              await saveProgress();
              return;
            }
            throw err;
          }
          noteFallback(task, res);
          writeBack(blocks, task, res.text);
          await checkpoint.appendTranslation(job.id, task.id, res.text);
          translatedCount++;
          if (task.page > currentPage) {
            currentPage = task.page;
            job.currentPage = currentPage;
          }
          onProgress(currentPage, clamp100(5 + translatedCount / Math.max(1, total) * 85));
          checkBreaker();
          taskIdx++;
        }
      }
      console.log(`[pipeline] prose batches: ${batchHits} ok / ${batchFalls} fell back to single; validation fallbacks: ${fallbacks.length}; cache hits: ${cacheStats.cacheHits}/${total}`);
      if (fallbacks.length > 0) {
        try {
          await import_node_fs4.promises.writeFile(
            import_node_path4.default.join(checkpoint.getJobDir(job.id), "quality-report.jsonl"),
            fallbacks.map((f) => JSON.stringify(f)).join("\n") + "\n",
            "utf8"
          );
        } catch (err) {
          console.warn("[pipeline] quality report write failed:", err.message);
        }
      }
      job.status = "typesetting";
      onProgress(job.totalPages, 92);
      const t1 = Date.now();
      const fallbackKeys = new Set(fallbacks.map((f) => f.unit));
      try {
        console.log("[pipeline] chromium compose+print starting...");
        await printHtmlToPdf(blocksToHtml(blocks, { fallbackKeys }), job.outputPath);
        console.log(`[pipeline] chromium typeset done in ${((Date.now() - t1) / 1e3).toFixed(1)}s`);
      } catch (err) {
        console.warn(`[pipeline] chromium typeset failed (${err.message}); falling back to pdf-lib`);
        await typesetFlow(blocks, job.outputPath, { fontPath: resolveFontPath() });
        console.log(`[pipeline] pdf-lib typeset done in ${((Date.now() - t1) / 1e3).toFixed(1)}s`);
      }
      onProgress(job.totalPages, 98);
      job.status = "exporting";
      await checkpoint.save(job.id, {
        phase: "exporting",
        completedPages: job.totalPages,
        progress: 98,
        translatedUnits: translatedCount,
        totalUnits: total
      });
      let stat;
      try {
        stat = await import_node_fs4.promises.stat(job.outputPath);
      } catch (err) {
        throw new Error(`\u8F93\u51FA PDF \u672A\u751F\u6210\uFF1A${err.message}`);
      }
      if (stat.size <= 0) throw new Error("\u8F93\u51FA PDF \u4E3A\u7A7A\u6587\u4EF6\uFF080 \u5B57\u8282\uFF09");
      onProgress(job.totalPages, 100);
    }
  };
}
var PROMPT_VERSION = "p1-numbered";
async function translateText(engine, source, signal, cache, stats) {
  const expanded = expandAbbreviations(source);
  const { text: masked, placeholders } = freezeProtected(expanded);
  const key = { modelId: engine.id ?? "llama", promptVersion: PROMPT_VERSION, temperature: 0.1, source, masked };
  const hash = TranslationCache.hashKey(key);
  const hit = await cache.get(hash);
  if (hit && validateRestored(source, hit.translated).ok) {
    stats.cacheHits++;
    return { text: hit.translated, ok: true, reasons: [] };
  }
  let lastReasons = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await engine.translate(masked, { signal });
    const raw = res.text;
    const vm = validateModelOutput(masked, raw);
    const restored = restorePlaceholders(raw, placeholders).trim();
    const vr = validateRestored(source, restored);
    if (vm.ok && vr.ok) {
      void cache.put(hash, restored, 0);
      return { text: restored, ok: true, reasons: [] };
    }
    lastReasons = [...vm.reasons, ...vr.reasons];
  }
  return { text: source, ok: false, reasons: lastReasons };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createPipeline
});
