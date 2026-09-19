// pdfjs-helper.ts — dynamic import of the legacy pdfjs build (same as capture).
export async function loadLlamaPdfjs(): Promise<any> {
  const ns = await import('pdfjs-dist/legacy/build/pdf.js')
  const mod = (ns as any).default ?? ns
  mod.GlobalWorkerOptions.workerSrc = './pdf.worker.js'
  return mod
}
