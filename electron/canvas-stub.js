// canvas-stub.js — empty stub for pdfjs-dist's optional `canvas` dependency.
// pdfjs-dist only needs canvas for pixel rendering; EnTransfer only uses
// pdfjs for text extraction, so a stub is sufficient and avoids the native
// canvas build dependency.
module.exports = {}
