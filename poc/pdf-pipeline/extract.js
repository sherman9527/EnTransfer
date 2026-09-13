/**
 * extract.js — PDF structure extraction via pdfjs-dist
 *
 * Extracts text items with geometry from the first 5 pages,
 * sorts into reading order, merges into paragraphs, and classifies
 * elements as title / code-block / body. Output → extracted.json
 */

const path = require('path');
const fs = require('fs');

// Use the legacy build for Node.js compatibility (no DOM dependency)
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const PDF_PATH = path.resolve(__dirname, '..', '..', 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf');
const OUT_PATH = path.join(__dirname, 'extracted.json');
const MAX_PAGES = 5;

// --- Tunable thresholds ---
const LINE_SPACING_RATIO = 1.5;   // merge lines if gap <= 1.5 * lineHeight
const FONT_SIZE_TOLERANCE = 0.18; // merge if font-size change < 18%
const TITLE_MIN_SIZE = 15;         // pt
const TITLE_MAX_CHARS = 40;
const CODE_FONT_PATTERNS = [/Courier/i, /Consolas/i, /Menlo/i, /Monaco/i, /monospace/i, /Code\d*$/i];
const CODE_SYMBOL_RE = /[{};=()[\]<>]|=>|::|\/\//g;

async function extract() {
  console.log('Loading PDF:', PDF_PATH);
  const data = new Uint8Array(fs.readFileSync(PDF_PATH));

  const loadingTask = pdfjsLib.getDocument({
    data,
    // Node.js: disable worker, use fake worker
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  console.log('PDF loaded. Total pages:', pdf.numPages);

  const result = {
    source: path.basename(PDF_PATH),
    totalPages: pdf.numPages,
    processedPages: Math.min(MAX_PAGES, pdf.numPages),
    pages: [],
  };

  for (let pageNum = 1; pageNum <= Math.min(MAX_PAGES, pdf.numPages); pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();

    // Extract items with geometry
    const items = textContent.items.map(item => {
      // transform = [sx, 0, 0, sy, tx, ty] in pdfjs
      // sy is the font size (text vertical scale)
      const tm = item.transform;
      return {
        str: item.str,
        x: tm[4],
        y: tm[5],
        width: item.width || 0,
        height: item.height || 0,
        fontSize: Math.abs(tm[3]),
        fontName: item.fontName || '',
        hasEOL: item.hasEOL || false,
      };
    });

    // Sort: y descending (top first), then x ascending (left to right)
    items.sort((a, b) => {
      if (Math.abs(b.y - a.y) > 1) return b.y - a.y; // y desc
      return a.x - b.x; // x asc
    });

    // Group into lines: items on the same visual line (similar y)
    const lines = [];
    let curLine = null;
    for (const it of items) {
      if (it.str.trim() === '' && !it.hasEOL) continue;
      if (!curLine) {
        curLine = { y: it.y, items: [it], fontSize: it.fontSize, fontName: it.fontName };
      } else if (Math.abs(it.y - curLine.y) < curLine.fontSize * 0.5) {
        curLine.items.push(it);
      } else {
        lines.push(curLine);
        curLine = { y: it.y, items: [it], fontSize: it.fontSize, fontName: it.fontName };
      }
    }
    if (curLine) lines.push(curLine);

    // Sort items within each line by x
    for (const ln of lines) {
      ln.items.sort((a, b) => a.x - b.x);
      ln.text = ln.items.map(i => i.str).join('');
      // bbox
      ln.x0 = Math.min(...ln.items.map(i => i.x));
      ln.x1 = Math.max(...ln.items.map(i => i.x + i.width));
      ln.y0 = Math.min(...ln.items.map(i => i.y - i.height));
      ln.y1 = Math.max(...ln.items.map(i => i.y));
    }

    // Merge lines into paragraphs
    const paragraphs = [];
    let curPara = null;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const lineH = ln.fontSize;
      if (!curPara) {
        curPara = { lines: [ln], fontSize: ln.fontSize, fontName: ln.fontName,
                    x0: ln.x0, x1: ln.x1, y0: ln.y0, y1: ln.y1 };
      } else {
        const prevLn = curPara.lines[curPara.lines.length - 1];
        const gap = prevLn.y - ln.y1; // vertical gap between lines
        const fontRatio = Math.min(ln.fontSize, curPara.fontSize) / Math.max(ln.fontSize, curPara.fontSize);
        if (gap <= lineH * LINE_SPACING_RATIO && fontRatio > (1 - FONT_SIZE_TOLERANCE)) {
          // merge
          curPara.lines.push(ln);
          curPara.y0 = Math.min(curPara.y0, ln.y0);
          curPara.x0 = Math.min(curPara.x0, ln.x0);
          curPara.x1 = Math.max(curPara.x1, ln.x1);
          // keep dominant font size
          if (ln.fontSize > curPara.fontSize) curPara.fontSize = ln.fontSize;
        } else {
          paragraphs.push(curPara);
          curPara = { lines: [ln], fontSize: ln.fontSize, fontName: ln.fontName,
                      x0: ln.x0, x1: ln.x1, y0: ln.y0, y1: ln.y1 };
        }
      }
    }
    if (curPara) paragraphs.push(curPara);

    // Build paragraph text and classify
    for (const p of paragraphs) {
      p.text = p.lines.map(l => l.text).join(' ').trim();
      // Classification
      const fontIsMono = CODE_FONT_PATTERNS.some(re => re.test(p.fontName));
      const codeSymCount = (p.text.match(CODE_SYMBOL_RE) || []).length;
      const isLong = p.text.length > 40 && codeSymCount > p.text.length / 20;

      if (p.fontSize >= TITLE_MIN_SIZE && p.text.length <= TITLE_MAX_CHARS && p.text.length > 0) {
        p.type = 'title';
      } else if (fontIsMono || isLong) {
        p.type = 'code';
      } else {
        p.type = 'body';
      }
      // Clean up: don't store full lines detail in output (too verbose)
      delete p.lines;
    }

    const stats = {
      page: pageNum,
      width: viewport.width,
      height: viewport.height,
      paragraphCount: paragraphs.length,
      titleCount: paragraphs.filter(p => p.type === 'title').length,
      codeCount: paragraphs.filter(p => p.type === 'code').length,
      bodyCount: paragraphs.filter(p => p.type === 'body').length,
    };
    result.pages.push({ ...stats, paragraphs });

    console.log(`Page ${pageNum}: ${paragraphs.length} paragraphs (${stats.titleCount} titles, ${stats.codeCount} code, ${stats.bodyCount} body)`);
    // Print sample titles
    const titles = paragraphs.filter(p => p.type === 'title');
    for (const t of titles.slice(0, 3)) console.log(`  [title] "${t.text.substring(0, 60)}"`);

    await page.cleanup();
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2), 'utf8');
  console.log('\nExtraction complete →', OUT_PATH);
  console.log(`File size: ${(fs.statSync(OUT_PATH).size / 1024).toFixed(1)} KB`);
}

extract().catch(err => { console.error('Extraction failed:', err); process.exit(1); });
