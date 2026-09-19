/**
 * electron/pdf/typeset/htmlFlow.ts — blocks → self-contained HTML document.
 *
 * The Chromium composition path (E2 verdict: better robustness — no
 * manual pagination bugs are possible, real <table> layout, justified CJK,
 * orphans/widows, and automatic font subsetting: 60pp 24MB -> 7.6MB).
 * Images are inlined as data: URIs so the document is portable and the
 * print step needs no temp assets.
 *
 * Pure string building — unit-testable without Electron. The printing half
 * lives in chromiumPrint.ts.
 */
import type { ContentBlock } from '../capture/flow'
import hljs from 'highlight.js/lib/common'

export interface HtmlOptions {
  /** Unit ids whose translation failed validation and kept the source text. */
  fallbackKeys?: Set<string>
  /** line-height override (product default 1.6, tighter than Qt's 1.75). */
  lineHeight?: number
}

const CHAPTER_RE = /^(第\s*\d+\s*章|章\s|Chapter\s*\d+|Appendix\b)/i

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** IDE-style syntax highlighting for verbatim code blocks (never translated). */
const HLJS_GUARD_CHARS = 20_000
// Auto-detection over ALL registered languages misfires on short code excerpts
// (SQL snippets scored as vbnet in testing). Technical-book code lives in a
// small language universe — constrain BOTH detection and the chip to it.
const HLJS_SUBSET = [
  'typescript', 'javascript', 'python', 'bash', 'shell', 'json', 'yaml', 'sql',
  'go', 'java', 'c', 'cpp', 'csharp', 'rust', 'xml', 'markdown', 'diff', 'dockerfile', 'ini', 'properties'
]
// Chips require a relevance floor; colors apply regardless (wrong-but-pretty
// highlighting is harmless, a WRONG LANGUAGE LABEL is what erodes trust).
const HLJS_LABEL_MIN_RELEVANCE = 5
function highlightedCode(code: string): { html: string; lang: string } {
  try {
    const r = hljs.highlightAuto(code.slice(0, HLJS_GUARD_CHARS), HLJS_SUBSET)
    return { html: r.value, lang: (r.language && r.relevance >= HLJS_LABEL_MIN_RELEVANCE) ? r.language : '' }
  } catch {
    return { html: esc(code), lang: '' }
  }
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

function dataUri(block: ContentBlock): string | null {
  if (!block.imageData || block.imageData.length === 0) return null
  const mime = IMAGE_MIME[(block.imageFormat ?? 'jpeg').toLowerCase()] ?? 'image/jpeg'
  const base64 = Buffer.from(block.imageData.buffer, block.imageData.byteOffset, block.imageData.byteLength).toString('base64')
  return `data:${mime};base64,${base64}`
}

function buildTable(block: ContentBlock): string {
  const cells = block.cells ?? []
  const cols = block.cols ?? (cells[0]?.length ?? 0)
  if (cells.length === 0 || cols === 0) return ''
  const widths = block.colWidths ?? []
  const colgroup = widths.length === cols
    ? `<colgroup>${widths.map((w) => `<col style="width:${(w * 100).toFixed(1)}%">`).join('')}</colgroup>`
    : ''
  const rows = cells.map((row, r) => {
    const tag = r === 0 && block.hasHeader ? 'th' : 'td'
    const cellsHtml = Array.from({ length: cols }, (_, c) => `<${tag}>${esc(row[c] ?? '')}</${tag}>`).join('')
    return `<tr>${cellsHtml}</tr>`
  }).join('')
  return `<table class="structured-table">${colgroup}<tbody>${rows}</tbody></table>`
}

export function blocksToHtml(blocks: ContentBlock[], opts: HtmlOptions = {}): string {
  const lh = opts.lineHeight ?? 1.6
  const fb = opts.fallbackKeys
  const cls = (key: string, base = ''): string => {
    const c = base ? [base] : []
    if (fb?.has(key)) c.push('source-fallback')
    return c.length ? ` class="${c.join(' ')}"` : ''
  }
  const parts: string[] = []
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi]
    switch (b.type) {
      case 'heading': {
        const lv = Math.min(4, Math.max(1, b.level ?? 4))
        const chapter = CHAPTER_RE.test((b.text ?? '').trim())
        parts.push(`<h${lv}${cls(`b${bi}`, chapter ? 'chapter-heading' : '')}>${esc(b.text ?? '')}</h${lv}>`)
        break
      }
      case 'paragraph':
        if ((b.text ?? '').trim()) parts.push(`<p${cls(`b${bi}`)}>${esc(b.text as string)}</p>`)
        break
      case 'list':
        if ((b.items ?? []).length > 0) {
          parts.push(`<ul>${(b.items ?? []).map((x, j) => `<li${cls(`b${bi}-${j}`)}>${esc(x)}</li>`).join('')}</ul>`)
        }
        break
      case 'code':
        if ((b.code ?? '').trim()) {
          // full code is printed; highlighting runs on a bounded prefix for speed
          const { html, lang } = highlightedCode(b.code as string)
          const shown = (b.code as string).length > HLJS_GUARD_CHARS ? esc(b.code as string) : html
          parts.push(`<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code class="hljs">${shown}</code></pre>`)
        }
        break
      case 'formula':
        if ((b.text ?? '').trim()) parts.push(`<pre class="formula">${esc(b.text as string)}</pre>`)
        break
      case 'table':
        parts.push(buildTable(b))
        break
      case 'image': {
        const uri = dataUri(b)
        if (!uri) break
        const pxW = b.imagePixelWidth ?? 0
        const pxH = b.imagePixelHeight ?? 0
        parts.push(`<figure><img src="${uri}"${pxW && pxH ? ` width="${pxW}" height="${pxH}"` : ''}></figure>`)
        break
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
/* highlight.js token palette (github-light-ish) — inlined so print keeps colors */
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
.source-fallback::after { content: " 〔原文保留〕"; color:#b26a2e; font-size: 8.5pt; }
`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>translated</title><style>${css}</style></head><body>\n${parts.join('\n')}\n</body></html>`
}
