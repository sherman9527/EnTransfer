/**
 * verify.js — Verify output PDF:
 * 1. Re-extract text from output-mock-zh.pdf
 * 2. Check for residual English text (double-layer detection)
 * 3. Verify Chinese text is extractable (not garbled)
 * 4. Compare file sizes
 */

const path = require('path');
const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const OUT_PATH = path.join(__dirname, 'output-mock-zh.pdf');
const ORIG_PATH = path.resolve(__dirname, '..', '..', 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf');
const MAX_PAGES = 5;

// Common English words to detect residual text
const ENGLISH_WORD_RE = /\b(the|and|for|with|this|that|from|your|have|will|but|not|you|all|can|had|her|was|one|our|out|day|get|has|him|his|how|man|new|now|old|see|two|way|who|did|its|let|put|say|she|too|use|think|like|software|engineering|manager|team|project|code|system|work|chapter|book)\b/i;

async function extractTexts(pdfPath, label) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const pages = [];
  for (let n = 1; n <= Math.min(MAX_PAGES, pdf.numPages); n++) {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    const texts = tc.items.map(i => i.str).filter(s => s.trim().length > 0);
    pages.push({ page: n, texts });
    await page.cleanup();
  }
  await pdf.destroy();
  return pages;
}

function hasChinese(str) {
  return /[\u4e00-\u9fff]/.test(str);
}
function hasEnglish(str) {
  return /[a-zA-Z]{3,}/.test(str);
}

async function main() {
  console.log('=== Verifying output PDF ===\n');

  // File size comparison
  const inSize = fs.statSync(ORIG_PATH).size;
  const outSize = fs.statSync(OUT_PATH).size;
  console.log(`Original: ${(inSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Output:   ${(outSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Ratio:    ${(outSize / inSize).toFixed(2)}x ${outSize > inSize * 3 ? '⚠ EXCEEDS 3x LIMIT' : '✅ OK'}`);

  // Extract text from output
  console.log('\n--- Extracting text from OUTPUT PDF ---');
  const outPages = await extractTexts(OUT_PATH, 'output');

  let totalEnItems = 0, totalCnItems = 0, totalOtherItems = 0;
  for (const p of outPages) {
    console.log(`\nPage ${p.page}: ${p.texts.length} text items`);
    let enCount = 0, cnCount = 0, otherCount = 0;
    const samples = [];
    for (const t of p.texts) {
      const isCn = hasChinese(t);
      const isEn = hasEnglish(t);
      if (isCn) cnCount++;
      else if (isEn) enCount++;
      else otherCount++;
      if (samples.length < 5) samples.push(t.substring(0, 60));
    }
    totalEnItems += enCount; totalCnItems += cnCount; totalOtherItems += otherCount;
    console.log(`  Chinese items: ${cnCount}, English items: ${enCount}, Other: ${otherCount}`);
    for (const s of samples) console.log(`    "${s}"`);
  }

  console.log('\n--- Summary ---');
  console.log(`Total Chinese text items: ${totalCnItems}`);
  console.log(`Total English text items: ${totalEnItems}`);
  console.log(`Other (numbers/symbols): ${totalOtherItems}`);

  // Double-layer detection: English text items that look like they're from the original
  if (totalEnItems > 0) {
    console.log(`\n⚠ WARNING: Found ${totalEnItems} English text items in output.`);
    console.log('  This may indicate residual old text layer (double-text).');
    // Show some examples
    const allEn = [];
    for (const p of outPages) {
      for (const t of p.texts) {
        if (hasEnglish(t) && !hasChinese(t)) allEn.push(`p${p.page}: "${t.substring(0,80)}"`);
      }
    }
    console.log('  English items found:');
    for (const s of allEn.slice(0, 10)) console.log(`    ${s}`);
  } else {
    console.log('\n✅ No English text detected - old text layer appears clean.');
  }

  // Chinese garble check
  if (totalCnItems > 0) {
    console.log(`✅ Chinese text is extractable (${totalCnItems} items found).`);
    // Check for replacement chars (garbled)
    let garbled = 0;
    for (const p of outPages) {
      for (const t of p.texts) {
        if (/[�□□]/.test(t)) garbled++;
      }
    }
    if (garbled > 0) console.log(`⚠ ${garbled} items contain replacement characters (possible garble).`);
    else console.log('✅ No garbled characters detected.');
  } else {
    console.log('⚠ No Chinese text found in output!');
  }

  console.log('\n=== Verification Complete ===');
}

main().catch(err => { console.error('Verify failed:', err); process.exit(1); });
