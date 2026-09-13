/**
 * render.js — Render first 2 pages of output PDF to PNG for visual inspection
 */
const path = require('path');
const fs = require('fs');
const { createCanvas } = require('canvas');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const PDF_PATH = path.join(__dirname, 'output-mock-zh.pdf');

async function main() {
  const data = new Uint8Array(fs.readFileSync(PDF_PATH));
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;

  for (let n = 1; n <= 2; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport }).promise;
    const outFile = path.join(__dirname, `page-${n}.png`);
    fs.writeFileSync(outFile, canvas.toBuffer('image/png'));
    console.log(`Rendered page ${n} → ${outFile} (${(fs.statSync(outFile).size/1024).toFixed(0)} KB)`);
    await page.cleanup();
  }
  await pdf.destroy();
}
main().catch(e => { console.error(e); process.exit(1); });
