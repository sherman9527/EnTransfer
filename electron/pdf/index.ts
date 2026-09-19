/**
 * electron/pdf/index.ts — public surface of the PDF module.
 *
 * The production path is flow-based (fresh A4 layout):
 *   captureFlow : PDF on disk → structured content blocks.
 *   typesetFlow : blocks → Chinese re-typeset output PDF.
 *
 * The legacy same-page replacement path (capturePdf / typesetPdf) and its
 * coordinate types were removed; placeholders (freeze/restore) and the glossary
 * stay because the live pipeline uses them during translation.
 */

export { freezeProtected, restorePlaceholders } from './capture/placeholders'
export type { PlaceholderMap } from './capture/placeholders'

export { expandAbbreviations } from './capture/glossary'

// Flow-based (fresh A4 layout) — the pipeline uses these.
export { captureFlow } from './capture/flow'
export type { ContentBlock, ContentBlockType, FlowCaptureResult, CaptureFlowOptions } from './capture/flow'
export { typesetFlow } from './typeset/flow'
export type { TypesetFlowOptions } from './typeset/flow'
