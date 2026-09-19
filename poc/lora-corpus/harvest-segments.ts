// harvest-segments.ts — turn a PDF into an ordered list of prose SEGMENTS
// (paragraphs), self-contained on pdfjs (no native C1), so it runs for both
// English books and their Chinese translations.
//
//   node poc/lora-corpus/harvest-segments.cjs "<pdf>" <out.json> [pageFrom] [pageTo]
//
// out.json = { pages, segments: [{ page, text }] }
// Heuristics:
//   - reconstruct visual lines from item y-coordinates, ordered by y desc / x asc
//   - merge consecutive lines into a paragraph; break when the vertical gap
//     between baselines is clearly larger than the body line pitch, or when a
//     line is short and left-floaty (paragraph end) followed by a fresh full line
//   - drop running headers/footers, bare page numbers, dot-leader TOC lines,
//     figure/table captions and code-ish lines
//   - CJK: collapse the single spaces pdfjs injects between Han characters
import fs from 'node:fs'
import path from 'node:path'

// Han + Kangxi radicals (some ZH ebooks encode 人/大/高 as U+2F00 block!) +
// CJK punctuation + fullwidth forms. Latin/digits intentionally excluded so we
// keep the conventional space around tokens like "OpenTelemetry".
const CJKRANGE = '\u2e80-\u2eff\u2f00-\u2fdf\u3000-\u303f\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef'
const CJK = new RegExp(`[${CJKRANGE}]`)
// remove a space when it sits between two CJK-ish chars (repeat to consume runs)
function despaceCJK(s: string): string {
  const re = new RegExp(`([${CJKRANGE}])[ \\t]+([${CJKRANGE}])`, 'g')
  let out = s
  for (let i = 0; i < 12 && re.test(out); i++) out = out.replace(re, '$1$2')
  return out
}

function isNumbery(line: string): boolean {
  const t = line.trim()
  return (
    t.length === 0 ||
    /^[\d\s.\-–—IVXivxlcdm]{1,10}$/i.test(t) || // page numbers, roman numerals
    /^\d{1,3}$/.test(t) ||
    /\.{5,}/.test(t) || // dot leaders (TOC)
    /^(第?\s*\d+\s*页|page\s*\d+|\d+\s*\/\s*\d+)$/i.test(t)
  )
}

function isCaption(line: string): boolean {
  const t = line.trim()
  return (
    /^(图|表|Figure|Table|Listing|Exhibit)\s*[\d.\-]/i.test(t) ||
    /^(版权信息|作者简介|译者|目录|Contents|Table of Contents|Acknowledg|Foreword|Preface|关于|序言|前言)$/i.test(t)
  )
}

// Z-Library / torrent-watermark spam that appears in front+back matter
function isSpam(line: string): boolean {
  const t = line.trim()
  return (
    /z-?\s?library|singlelogin|go-to-zlibrary|libgen|annas-?archive/i.test(t) ||
    /downloaded from|gateway to knowledge|Accessible for everyone/i.test(t) ||
    /欢迎加\S*云原生社区|扫码|关注公众号|加微信|加QQ群|勘误表|读者服务/i.test(t) ||
    /^[\w.-]+\.(se|ru|io|org)\s/i.test(t)
  )
}

// Running header/footer / TOC-with-glued-pagenum furniture (same shape rules the
// production capture uses). Without this the LoRA corpus is polluted with lines
// like "4 | Chapter 1: …" and "How X Works | 89" that mis-align against prose.
function isFurniture(line: string): boolean {
  const t = line.trim()
  return (
    /^\d{1,4}\s*[|｜]\s*\S/.test(t) ||      // "4 | Chapter 1: …"
    /\S\s*[|｜]\s*\d{1,4}$/.test(t) ||      // "How X Works | 89"
    /^\d{1,4}$/.test(t) ||                  // lone page number
    /^[ivxlcdm]{1,6}$/i.test(t)
  )
}

async function run(): Promise<void> {
  const ns = await import('pdfjs-dist/legacy/build/pdf.js')
  const mod: any = (ns as any).default ?? ns
  const arg = process.argv[2]!
  const outArg = process.argv[3]!
  const pdfPath = path.isAbsolute(arg) ? arg : path.join(path.resolve(process.cwd(), '..', '..', 'good book'), arg)
  // pdfjs needs the bundled cMaps + standard fonts to decode CJK / built-in
  // fonts, or whole pages silently yield no text. poc always runs from the
  // project root, so resolve the assets relative to cwd (require.resolve of a
  // package subpath breaks under esbuild's externals).
  const pkgDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist')
  const pdf = await mod.getDocument({
    data: new Uint8Array(fs.readFileSync(pdfPath)),
    isEvalSupported: false,
    cMapUrl: path.join(pkgDir, 'cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: path.join(pkgDir, 'standard_fonts') + '/'
  }).promise
  const from = Number(process.argv[4] ?? 1)
  const to = Number(process.argv[5] ?? pdf.numPages)

  const segments: { page: number; text: string }[] = []
  for (let pageNo = from; pageNo <= Math.min(to, pdf.numPages); pageNo++) {
    const tc = await (await pdf.getPage(pageNo)).getTextContent()
    // bucket items into visual lines by rounded y
    const rows = new Map<number, { x: number; y: number; s: string }[]>()
    for (const it of tc.items) {
      const s = (it as any).str
      if (!s) continue
      const y = Math.round(it.transform[5])
      const x = it.transform[4]
      const b = rows.get(y) ?? []
      b.push({ x, y, s })
      rows.set(y, b)
    }
    const ys = [...rows.keys()].sort((a, b) => b - a)
    // build line records with pitch info
    const lines: { y: number; text: string; w: number }[] = []
    for (const y of ys) {
      const parts = rows.get(y)!.sort((a, b) => a.x - b.x)
      const text = parts.map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim()
      const left = parts[0].x
      const right = parts[parts.length - 1].x + 60
      lines.push({ y, text, w: right - left })
    }
    // paragraph merge
    let para: string[] = []
    let prevY = 0
    let prevW = 0
    const flush = (): void => {
      if (!para.length) return
      let joined = para.join(' ')
      joined = despaceCJK(joined).replace(/\s+/g, ' ').trim()
      const cjk = [...joined].some((c) => CJK.test(c))
      const min = cjk ? 14 : 40
      if (joined.length >= min && !isNumbery(joined) && !isCaption(joined) && !isSpam(joined) && !isFurniture(joined)) {
        segments.push({ page: pageNo, text: joined })
      }
      para = []
    }
    // median body pitch (mode-ish of gaps)
    const gaps: number[] = []
    for (let i = 1; i < lines.length; i++) {
      const g = lines[i - 1].y - lines[i].y
      if (g > 4 && g < 40) gaps.push(g)
    }
    gaps.sort((a, b) => a - b)
    const pitch = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 14
    for (const ln of lines) {
      const gap = prevY - ln.y
      const bigGap = prevY !== 0 && gap > pitch * 1.9
      const prevShortEnd = prevW > 0 && prevW < ln.w * 0.72 // prev line didn't fill → para break
      if (para.length && (bigGap || prevShortEnd)) flush()
      para.push(ln.text)
      prevY = ln.y
      prevW = ln.w
    }
    flush()
  }
  fs.mkdirSync(path.dirname(outArg), { recursive: true })
  fs.writeFileSync(outArg, JSON.stringify({ file: path.basename(pdfPath), pages: pdf.numPages, segments }, null, 2))
  console.log(`${path.basename(pdfPath)}: pages=${pdf.numPages} scanned=${from}-${to} segments=${segments.length}`)
}
run().catch((e) => { console.error('ERR', e?.message ?? e); process.exit(1) })
