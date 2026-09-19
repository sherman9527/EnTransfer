// canvas-stub.js — empty stub for pdfjs-dist's optional `canvas` dependency.
// pdfjs-dist only needs canvas for pixel rendering; EnTransfer's shipped path
// uses pdfjs for TEXT extraction only, so a stub avoids the native canvas build
// dependency. NOTE: if the C1 layout pass (page-renderer) is ever wired +
// packaged, this must re-export @napi-rs/canvas instead — some pages make pdfjs
// allocate scratch canvases (patterns/soft-masks/XObjects) via require('canvas')
// during render, which an empty stub breaks. See docs/PDFZH-COMPARE.md C1 + task #21.
module.exports = {}
