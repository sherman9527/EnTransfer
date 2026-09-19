// canvas-stub.js — pdfjs-dist's Node canvas backend.
//
// pdfjs-dist does `require('canvas')` for pixel rendering AND for scratch
// canvases (patterns, soft masks, form XObjects) via NodeCanvasFactory. The C1
// layout pass renders pages (page-renderer), so this must be a real canvas —
// @napi-rs/canvas, API-compatible with `canvas` for pdfjs's needs, no extra
// native dep beyond what the layout pass already ships. electron.vite aliases
// `canvas` -> this file, so pdfjs's require('canvas') resolves here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
module.exports = require('@napi-rs/canvas')
