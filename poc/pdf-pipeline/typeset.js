/**
 * typeset.js — Chinese re-typesetting pipeline
 *
 * 1. Load original PDF with pdf-lib
 * 2. Embed Noto Sans SC TTF via fontkit
 * 3. For first 5 pages:
 *    a. Decode content stream, scan BT...ET objects
 *    b. Remove text objects in body/title regions (keep code regions)
 *    c. Draw mock Chinese at original paragraph positions
 *    d. Mixed CJK/Latin rendering + adaptive font size
 * 4. Save output-mock-zh.pdf
 */

const path = require('path');
const fs = require('fs');
const { PDFDocument, StandardFonts, rgb, decodePDFRawStream, PDFName } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const PDF_PATH = path.resolve(__dirname, '..', '..', 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf');
const EXTRACTED_PATH = path.join(__dirname, 'extracted.json');
const FONT_PATH = path.join(__dirname, 'fonts', 'NotoSansSC-VF.ttf');
const OUT_PATH = path.join(__dirname, 'output-mock-zh.pdf');
const MAX_PAGES = 5;

// Mock Chinese text (repeated filler)
const MOCK_PARAGRAPH = '这是一段测试中文译文。软件工程经理需要协调团队、推动项目进展，并在技术决策和人员管理之间取得平衡。本章将讨论如何高效地进行交接文档编写。';

// ============================================================================
// Content stream scanner (ported from xiaoshulang sanitize.ts)
// ============================================================================

const isWhitespace = c => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelimiter = c =>
  c === 40 || c === 41 || c === 60 || c === 62 || c === 91 ||
  c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function scanTextObjects(content) {
  const spans = [];
  const n = content.length;
  let ctmX = 0, ctmY = 0, ctmIdentityLinear = true;
  const ctmStack = [];
  let operands = [];
  let inText = false, textStart = -1;
  let tmX = 0, tmY = 0, tmTranslationKnown = false, tmLinearIdentity = true;
  let textShowCount = 0;
  let i = 0;
  const fail = reason => ({ ok: false, reason, spans });

  while (i < n) {
    const c = content.charCodeAt(i);
    if (isWhitespace(c)) { i++; continue; }
    if (c === 37) { while (i < n && content.charCodeAt(i) !== 10 && content.charCodeAt(i) !== 13) i++; continue; }
    if (c === 40) {
      let depth = 1; i++;
      while (i < n && depth > 0) {
        const d = content.charCodeAt(i);
        if (d === 92) { i += 2; continue; }
        if (d === 40) depth++; else if (d === 41) depth--;
        i++;
      }
      if (depth !== 0) return fail('unterminated-literal-string');
      continue;
    }
    if (c === 60) {
      if (i + 1 < n && content.charCodeAt(i + 1) === 62) { i += 2; continue; }
      i++;
      while (i < n && content.charCodeAt(i) !== 62) i++;
      if (i >= n) return fail('unterminated-hex-string');
      i++; continue;
    }
    if (c === 62) {
      if (i + 1 < n && content.charCodeAt(i + 1) === 62) { i += 2; continue; }
      i++; continue;
    }
    if (c === 91 || c === 93 || c === 123 || c === 125) { i++; continue; }

    let j = i;
    while (j < n) { const d = content.charCodeAt(j); if (isWhitespace(d) || isDelimiter(d)) break; j++; }
    const token = content.slice(i, j);
    i = j;
    if (token.length === 0) { i++; continue; }
    if (NUMBER_RE.test(token)) { operands.push(Number(token)); continue; }

    const approx = (a, b) => Math.abs(a - b) < 1e-3;
    switch (token) {
      case 'q': ctmStack.push([ctmX, ctmY, ctmIdentityLinear]); operands = []; break;
      case 'Q': { const t = ctmStack.pop(); if (t) { ctmX = t[0]; ctmY = t[1]; ctmIdentityLinear = t[2]; } operands = []; break; }
      case 'cm': {
        if (operands.length >= 6) {
          const [a, b, cc, d, e, f] = operands.slice(-6);
          ctmX += e; ctmY += f;
          if (!(approx(a, 1) && approx(b, 0) && approx(cc, 0) && approx(d, 1))) ctmIdentityLinear = false;
        }
        operands = []; break;
      }
      case 'BT':
        if (inText) return fail('nested-BT');
        inText = true; textStart = i - token.length;
        tmX = 0; tmY = 0; tmTranslationKnown = false; tmLinearIdentity = true; textShowCount = 0;
        operands = []; break;
      case 'Tm':
        if (operands.length >= 6) {
          const [a, b, cc, d, e, f] = operands.slice(-6);
          tmX = e; tmY = f; tmTranslationKnown = true;
          tmLinearIdentity = approx(a, 1) && approx(b, 0) && approx(cc, 0) && approx(d, 1);
        }
        operands = []; break;
      case 'Td': case 'TD':
        if (operands.length >= 2) { tmX += operands[operands.length-2]; tmY += operands[operands.length-1]; tmTranslationKnown = true; }
        operands = []; break;
      case 'ET': {
        if (!inText) return fail('ET-without-BT');
        let anchor = null;
        if (textShowCount === 1 && tmTranslationKnown && ctmIdentityLinear && tmLinearIdentity) {
          anchor = [ctmX + tmX, ctmY + tmY];
        }
        spans.push({ start: textStart, end: i, anchor, showCount: textShowCount });
        inText = false; operands = []; break;
      }
      case 'Tj': case 'TJ':
        if (inText) textShowCount++;
        operands = []; break;
      case "'": case '"':
        if (inText) { textShowCount++; tmTranslationKnown = false; }
        operands = []; break;
      case 'BI': {
        let k = i;
        let idAt = -1;
        while (k < n - 1) {
          if (content[k] === 'I' && content[k+1] === 'D') {
            const prevOk = k === 0 || isWhitespace(content.charCodeAt(k-1)) || isDelimiter(content.charCodeAt(k-1));
            if (prevOk) { idAt = k; break; }
          }
          k++;
        }
        if (idAt < 0) return fail('inline-image-unresolved');
        k = idAt + 2;
        if (k < n && isWhitespace(content.charCodeAt(k))) k++;
        while (k < n - 1) {
          if (content[k] === 'E' && content[k+1] === 'I' &&
              (k === 0 || isWhitespace(content.charCodeAt(k-1))) &&
              (k+2 >= n || isWhitespace(content.charCodeAt(k+2)) || isDelimiter(content.charCodeAt(k+2)))) {
            i = k + 2; break;
          }
          k++;
        }
        operands = []; break;
      }
      default: operands = []; break;
    }
  }
  if (inText) return fail('unterminated-text-object');
  return { ok: true, spans };
}

function bytesToLatin1(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let k = 0; k < bytes.length; k += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(k, k + CHUNK)));
  }
  return s;
}

// ============================================================================
// Mixed CJK/Latin text measurement & wrapping (ported from measure.ts)
// ============================================================================

function classifyChar(ch) {
  const cp = ch.codePointAt(0) || 0;
  if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef) ||
      (cp >= 0xf900 && cp <= 0xfaff)) return 'cjk';
  return 'latin';
}

function atomize(text) {
  const atoms = [];
  const chars = Array.from(String(text || ''));
  let latin = '';
  const flushLatin = (space) => {
    if (latin.length > 0) { atoms.push({ script: 'latin', text: latin, space }); latin = ''; }
    else if (space && atoms.length > 0) { atoms[atoms.length - 1].space = true; }
  };
  for (const ch of chars) {
    if (ch === ' ' || ch === '\t') { flushLatin(true); continue; }
    if (classifyChar(ch) === 'cjk') { flushLatin(false); atoms.push({ script: 'cjk', text: ch, space: false }); }
    else { latin += ch; }
  }
  flushLatin(false);
  return atoms;
}

// ============================================================================
// Main typesetting
// ============================================================================

async function typeset() {
  console.log('Loading PDF with pdf-lib...');
  const pdfBytes = fs.readFileSync(PDF_PATH);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  pdfDoc.registerFontkit(fontkit);

  // Embed Chinese font
  console.log('Embedding Noto Sans SC TTF...');
  const cjkFontBytes = fs.readFileSync(FONT_PATH);
  const cjkFont = await pdfDoc.embedFont(cjkFontBytes, { subset: true });
  const latinFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  console.log('Fonts embedded.');

  // Load extraction results
  const extracted = JSON.parse(fs.readFileSync(EXTRACTED_PATH, 'utf8'));
  const pages = pdfDoc.getPages();

  const stats = { removedSpans: 0, keptSpans: 0, drawnParagraphs: 0, overflowCount: 0 };

  for (let pageIdx = 0; pageIdx < Math.min(MAX_PAGES, pages.length); pageIdx++) {
    const page = pages[pageIdx];
    const pageNo = pageIdx + 1;
    const pageData = extracted.pages.find(p => p.page === pageNo);
    if (!pageData) { console.log(`Page ${pageNo}: no extraction data, skipping`); continue; }

    const { width, height } = page.getSize();
    console.log(`\n--- Page ${pageNo} (${width.toFixed(0)}x${height.toFixed(0)}) ---`);

    // --- Step A: Decode content stream ---
    const ctx = page.node.context;
    const contentsObj = page.node.Contents();
    let streams = [];
    if (contentsObj) {
      if (contentsObj.constructor.name === 'PDFArray' || Array.isArray(contentsObj.items)) {
        for (let k = 0; k < contentsObj.size(); k++) streams.push(contentsObj.lookup(k));
      } else {
        streams.push(contentsObj);
      }
    }

    let decodedContent = '';
    for (const s of streams) {
      try {
        const decoded = decodePDFRawStream(s).decode();
        decodedContent += bytesToLatin1(decoded) + '\n';
      } catch(e) {
        console.log(`  Stream decode warning: ${e.message}`);
      }
    }

    // --- Step B: Scan text objects ---
    const scan = scanTextObjects(decodedContent);
    if (!scan.ok) {
      console.log(`  WARN: content scan failed (${scan.reason}), keeping original content`);
    } else {
      console.log(`  Found ${scan.spans.length} text objects`);

      // Determine code region bboxes (from extracted paragraphs classified as 'code')
      const codeRects = pageData.paragraphs
        .filter(p => p.type === 'code')
        .map(p => [p.x0, p.y0, p.x1, p.y1]);

      // Decide which spans to remove: remove all spans whose anchor is NOT in a code rect
      const pointInRect = (x, y, r, tol=3) =>
        x >= Math.min(r[0], r[2]) - tol && x <= Math.max(r[0], r[2]) + tol &&
        y >= Math.min(r[1], r[3]) - tol && y <= Math.max(r[1], r[3]) + tol;

      const drop = [];
      for (const span of scan.spans) {
        if (span.anchor === null) {
          // Unknown anchor: remove it (fail closed for body/title removal;
          // in POC we remove unknowns to ensure clean layer)
          drop.push(span);
          continue;
        }
        const [ax, ay] = span.anchor;
        const inCode = codeRects.some(r => pointInRect(ax, ay, r));
        if (!inCode) drop.push(span);
        else stats.keptSpans++;
      }
      stats.removedSpans += drop.length;
      console.log(`  Removing ${drop.length} text objects, keeping ${scan.spans.length - drop.length} (code regions)`);

      // Rebuild content without dropped spans
      if (drop.length > 0) {
        let out = '';
        let cursor = 0;
        for (const span of drop) {
          out += decodedContent.slice(cursor, span.start);
          cursor = span.end;
        }
        out += decodedContent.slice(cursor);

        // Replace content stream
        const newStream = ctx.flateStream(out);
        const newRef = ctx.register(newStream);
        page.node.set(PDFName.of('Contents'), newRef);
        decodedContent = out;
      }
    }

    // --- Step C: Draw mock Chinese at body/title positions ---
    for (const para of pageData.paragraphs) {
      if (para.type === 'code') continue; // keep code original

      const bboxW = para.x1 - para.x0;
      const bboxH = para.y1 - para.y0;
      if (bboxW < 5 || bboxH < 3) continue;

      // Mock Chinese text: use the original English text replaced with mock
      let mockText = MOCK_PARAGRAPH;
      if (para.type === 'title') {
        mockText = '【标题】' + para.text.substring(0, 20);
      }

      // Adaptive font size: try from original size down to 6pt
      const startSize = Math.min(para.fontSize, 16);
      const floorSize = 6;
      let bestSize = floorSize;
      let bestLines = [];

      for (let size = Math.floor(startSize); size >= floorSize; size--) {
        // Measure: wrap text to bbox width using cjk font metrics
        const atoms = atomize(mockText);
        const lines = [];
        let curLine = '';
        let curW = 0;
        const lineH = size * 1.35;
        const maxW = bboxW;
        const maxH = bboxH + size * 0.5; // allow a little overflow tolerance

        for (const atom of atoms) {
          const font = atom.script === 'cjk' ? cjkFont : latinFont;
          const w = atom.script === 'cjk' ? atom.text.length * size : font.widthOfTextAtSize(atom.text, size);
          const gap = (curLine.length > 0 && atom.script === 'latin') ? latinFont.widthOfTextAtSize(' ', size) : 0;
          if (curW + gap + w > maxW && curLine.length > 0) {
            lines.push(curLine);
            curLine = atom.text;
            curW = w;
          } else {
            curLine += (gap > 0 && curLine.length > 0 ? ' ' : '') + atom.text;
            curW += gap + w;
          }
        }
        if (curLine) lines.push(curLine);

        const totalH = lines.length * lineH;
        if (totalH <= maxH) {
          bestSize = size;
          bestLines = lines;
          break;
        }
        if (size === floorSize) {
          bestLines = lines;
          stats.overflowCount++;
        }
      }

      // Draw lines starting from top of bbox
      const lineH = bestSize * 1.35;
      let drawY = para.y1 - bestSize * 0.8; // baseline near top
      for (const lineText of bestLines) {
        // Split into CJK and Latin runs and draw separately
        drawMixedLine(page, lineText, para.x0, drawY, bestSize, cjkFont, latinFont);
        drawY -= lineH;
      }
      stats.drawnParagraphs++;
    }
  }

  // Save
  console.log('\nSaving output PDF...');
  const outBytes = await pdfDoc.save();
  fs.writeFileSync(OUT_PATH, outBytes);
  const inSize = fs.statSync(PDF_PATH).size;
  const outSize = fs.statSync(OUT_PATH).size;
  console.log(`\n=== Typesetting Complete ===`);
  console.log(`Removed text objects: ${stats.removedSpans}`);
  console.log(`Kept (code region): ${stats.keptSpans}`);
  console.log(`Drawn paragraphs: ${stats.drawnParagraphs}`);
  console.log(`Overflow at floor: ${stats.overflowCount}`);
  console.log(`Input:  ${(inSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Output: ${(outSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Ratio:  ${(outSize / inSize).toFixed(2)}x`);
}

function drawMixedLine(page, text, x, y, size, cjkFont, latinFont) {
  const atoms = atomize(text);
  let cx = x;
  for (const atom of atoms) {
    const font = atom.script === 'cjk' ? cjkFont : latinFont;
    const w = font.widthOfTextAtSize(atom.text, size);
    try {
      page.drawText(atom.text, { x: cx, y: y, size, font, color: rgb(0, 0, 0) });
    } catch(e) {
      // Glyph not in font — skip
    }
    cx += w;
  }
}

typeset().catch(err => { console.error('Typeset failed:', err); process.exit(1); });
