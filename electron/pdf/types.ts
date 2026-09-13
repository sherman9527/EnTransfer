/**
 * electron/pdf/types.ts — shared structural types for the PDF capture → translate
 * → typeset pipeline.
 *
 * Coordinate convention: every bbox uses the PDF bottom-left origin
 * ([x0, y0, x1, y1] in points). pdfjs-dist (viewport) and pdf-lib (page) both
 * use this origin, so extracted geometry maps 1:1 onto the typeset canvas with
 * no y-flip.
 */

/** Axis-aligned bounding box: [x0, y0, x1, y1], bottom-left origin. */
export type BBox = [number, number, number, number]

/** Role a text span plays in the document. */
export type SpanRole =
  | 'title'
  | 'body'
  | 'caption'
  | 'code'
  | 'formula'
  | 'furniture'
  | 'table'

/**
 * One atomic text fragment extracted from the content stream. A line/paragraph
 * is assembled from several of these during segmentation.
 */
export interface TextSpan {
  /** 1-based page number. */
  page: number
  /** The raw text of this fragment. */
  text: string
  /** [x0, y0, x1, y1] in points, bottom-left origin. */
  bbox: BBox
  /** Detected font size in points. */
  fontSize: number
  /** Source font name (as reported by the PDF font dictionary). */
  fontName: string
  /** Optional weight hint when the font encodes one. */
  fontWeight?: string
  /** Classified role (refined by reading-order + segmentation). */
  role: SpanRole
  /** Whether this fragment ends a visual line in the source. */
  hasEOL: boolean
}

/**
 * A unit that must be translated. Only title / body / caption qualify; code,
 * formula, table and furniture are passed through verbatim.
 */
export interface TranslationUnit {
  /** Stable id, e.g. `p3-u12`. */
  id: string
  /** 1-based page number this unit lives on. */
  page: number
  /** Only these three roles are translated. */
  role: 'title' | 'body' | 'caption'
  /** The original (source-language) text. */
  sourceText: string
  /** The translated text, filled in by the translation stage. */
  translatedText?: string
  /** Union bbox of the paragraph, bottom-left origin. */
  bbox: BBox
  /** Original font size in points (used as the adaptive-fit start size). */
  fontSize: number
  /** Source font name. */
  fontName: string
  /** Horizontal alignment detected from the source layout (default left). */
  align?: 'left' | 'center' | 'right'
}

/** Everything extracted for a single page. */
export interface PageExtraction {
  /** 1-based page number. */
  pageNumber: number
  /** Page width in points. */
  width: number
  /** Page height in points. */
  height: number
  /** All text fragments in reading order. */
  spans: TextSpan[]
  /** Only the units that need translation (title / body / caption). */
  units: TranslationUnit[]
  /** Image placement boxes (preserved verbatim; never translated). */
  imageBboxes: BBox[]
  /** Code-block boxes (preserved verbatim; old text NOT cleared). */
  codeBboxes: BBox[]
}

/** Outcome of producing the re-typeset output PDF. */
export interface TypesetResult {
  /** Absolute path of the written output PDF. */
  outputPath: string
  /** Number of pages in the output. */
  pageCount: number
 /** Output file size in bytes. */
  fileSize: number
  /** 1-based pages where Chinese still overflowed the original box at the floor. */
  overflowPages: number[]
  /** True when an old-text object survived sanitization on any page. */
  residualTextFound: boolean
}
