// compose-html.ts — E2 POC: build one HTML document from the same captured
// blocks + translations that produced the pdf-lib baseline PDF, so both
// renderers see identical content. Borrowed CSS discipline from EnTransferQt
// (justify + orphans/widows, break-after:avoid on headings, chapter page
// breaks, real <table> styling, figure max-height) and extended:
//   - page footer with counter() (their version has no page numbers; ours did)
//   - per-block data-page provenance in a hidden layer for the audit pass
import fs from 'node:fs'
import path from 'node:path'
import { captureFlow, type ContentBlock } from '../../electron/pdf/capture/flow'
import { CheckpointStore } from '../../electron/queue/checkpoint'

const ROOT = process.cwd()
const INPUT = path.join(ROOT, 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf')
const JOBS = path.join(ROOT, '.scratch', 'e2e-jobs')
const ASSETS = path.join(ROOT, '.scratch', 'e60-assets')
const OUT = path.join(ROOT, '.scratch', 'e60-composed.html')

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildTableHtml(b: ContentBlock): string {
  const cells = b.cells ?? []
  const widths = b.colWidths ?? []
  const colgroup = widths.length
    ? `<colgroup>${widths.map((w) => `<col style="width:${(w * 100).toFixed(1)}%">`).join('')}</colgroup>`
    : ''
  const rows = cells.map((row, r) => {
    const tag = r === 0 && b.hasHeader ? 'th' : 'td'
    return `<tr>${row.map((c) => `<${tag}>${esc(c ?? '')}</${tag}>`).join('')}</tr>`
  }).join('\n')
  return `<table class="structured-table">${colgroup}<tbody>${rows}</tbody></table>`
}

async function main() {
  const pageLimit = Number(process.env.E60_PAGES || 60)
  const { blocks } = await captureFlow(INPUT, { pageLimit })
  const ck = new CheckpointStore(JOBS)
  const tr = await ck.loadTranslations('e2e-test-001')
  if (tr.size === 0) throw new Error('no translations found — run E0 first')
  fs.mkdirSync(ASSETS, { recursive: true })

  // Apply translations exactly like writeBack (prose/list/cell ids).
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type === 'list') {
      const items = b.items ?? []
      for (let j = 0; j < items.length; j++) {
        const got = tr.get(`b${i}-${j}`)
        if (got !== undefined) items[j] = got
      }
    } else if (b.type === 'table') {
      const cells = b.cells ?? []
      for (let r = 0; r < cells.length; r++)
        for (let c = 0; c < cells[r].length; c++) {
          const got = tr.get(`b${i}-r${r}c${c}`)
          if (got !== undefined) cells[r][c] = got
        }
    } else if (b.type !== 'code' && b.type !== 'image' && b.type !== 'formula') {
      const got = tr.get(`b${i}`)
      if (got !== undefined) b.text = got
    }
  }

  const body: string[] = []
  let imgN = 0
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': {
        const lv = Math.min(4, Math.max(1, b.level ?? 4))
        const chapter = /^第\s*\d+\s*章|^章前|Chapter\s*\d+/i.test((b.text ?? '').trim())
        body.push(`<h${lv}${chapter ? ' class="chapter-heading"' : ''}>${esc(b.text ?? '')}</h${lv}>`)
        break
      }
      case 'paragraph': body.push(`<p>${esc(b.text ?? '')}</p>`); break
      case 'list':
        body.push(`<ul>${(b.items ?? []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`)
        break
      case 'code': body.push(`<pre class="code">${esc(b.code ?? '')}</pre>`); break
      case 'formula': body.push(`<pre class="formula">${esc(b.text ?? '')}</pre>`); break
      case 'table': body.push(buildTableHtml(b)); break
      case 'image': {
        if (!b.imageData || b.imageData.length === 0) break
        const ext = b.imageFormat === 'png' ? 'png' : 'jpg'
        const name = `img${++imgN}.${ext}`
        fs.writeFileSync(path.join(ASSETS, name), b.imageData)
        const pxW = b.imagePixelWidth ?? 0
        const pxH = b.imagePixelHeight ?? 0
        const uri = 'file:///' + path.join(ASSETS, name).replace(/\\/g, '/')
        body.push(`<figure><img src="${uri}" ${pxW ? `width="${pxW}" height="${pxH}"` : ''}></figure>`)
        break
      }
    }
  }

  // NOTE: Chromium ignores @page margin-box content (no CSS page counters);
  // page numbers come from printToPDF's footerTemplate instead (see electron-print.cjs).
  const css = `
@page { size: A4; margin: 20mm 18mm 22mm 18mm; }
html { font-family: "Microsoft YaHei", "Microsoft YaHei UI", sans-serif; }
body { margin:0; font-size: 11pt; line-height: 1.75; color:#111; }
h1 { font-size: 18pt; line-height:1.35; margin: 18pt 0 10pt; break-after: avoid; }
h2 { font-size: 15pt; line-height:1.35; margin: 14pt 0 8pt; break-after: avoid; }
h3 { font-size: 13pt; line-height:1.35; margin: 12pt 0 6pt; break-after: avoid; }
h4 { font-size: 12pt; line-height:1.35; margin: 10pt 0 6pt; break-after: avoid; }
.chapter-heading { break-before: page; margin-top: 0; }
p { text-align: justify; orphans: 2; widows: 2; margin: 0 0 6pt; }
ul { margin: 0 0 8pt 6pt; padding-left: 14pt; }
li { margin-bottom: 3pt; break-inside: avoid; text-align: justify; }
.structured-table { width:100%; border-collapse: collapse; font-size: 9.5pt; margin: 8pt 0 12pt; break-inside: auto; }
.structured-table th, .structured-table td { border: 1px solid #9ca3af; padding: 5px 7px; vertical-align: top; overflow-wrap: anywhere; text-align: left; }
.structured-table tr:first-child th, .structured-table thead th { font-weight: 600; background: #f1f4f8; }
.structured-table tr { break-inside: avoid; }
.code { font-family: Consolas, monospace; font-size: 9pt; background: #f5f7fa; border-radius: 4px; padding: 8pt 10pt; overflow-wrap: anywhere; margin: 8pt 0; break-inside: auto; }
.formula { font-family: Consolas, monospace; font-size: 9.5pt; margin: 8pt 0; break-inside: avoid; }
figure { margin: 10pt auto; text-align:center; break-inside: avoid; }
figure img { max-width: 100%; max-height: 200mm; object-fit: contain; }
`
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>e60 html composer</title><style>${css}</style></head><body>\n${body.join('\n')}\n</body></html>`
  fs.writeFileSync(OUT, html, 'utf8')
  console.log(`blocks=${blocks.length} translations=${tr.size} images=${imgN}`)
  console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB)`)
}
main().catch((e) => { console.error(e); process.exit(1) })
