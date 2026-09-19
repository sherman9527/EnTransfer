# Gap Analysis — Delta Lake EN source vs our ZH output (2026-09-19)

User: "总觉得还是差点意思，还有调优空间吗？全面分析一下 gap 在哪里。"
Source: `good book/deltatable/Delta Lake Up And Running …pdf` (267p, EN)
Output: `…/data/output/…zh.pdf` (152p, ZH, generated today 17:25)

Method: extracted both PDFs (harvest-segments), rendered pages to PNG and
inspected visually, then quantified each defect — separating REAL bugs from
(a) correct-by-design behaviour and (b) my own detector false-positives.
Nothing below is claimed without a page/image example.

## Headline

The **translation itself is fluent and professional** — the base model is not the
weak point. The "差点意思" is overwhelmingly **capture/typesetting fidelity + a
few model-level consistency issues**, ranked by reader impact:

| # | Defect | Impact | Model-agnostic? | Evidence |
|---|--------|--------|-----------------|----------|
| 1 | Word-breaking / space corruption | HIGH | ✅ capture | "Generat ed Column s", "support sgenera ted", "TheData Warehouse", "TheComplete" |
| 2 | Running header/footer leaked into body | HIGH | ✅ capture | "数据仓库\|5", "6\|第一章：数据架构的演变", "8\|第一章…" every page |
| 3 | Terminology inconsistency | MED-HIGH | ⚠ model/glossary | "lakehouse" → 湖仓(33) / 湖house(17) / 数据湖house(12) / lakehouse(9) / 湖岸(4) |
| 4 | Prose callouts/sidebars/footnotes left untranslated (〔原文保留〕 over-applied) | MED | ✅ classifier | p5 orange block "Next, the data warehouse needs to transform…" |
| 5 | Bullet/list items merged onto one line | LOW-MED | ✅ capture | "• …历史洞察，• 允许用户分析…" |

## 1. Word-breaking / space corruption (worst offender)

Real, visible in the rendered PDF, and it mangles **technical terms**:
- p32: "Generat ed Column s Delta Lake support sgenera ted column s, which are a special"
- p6:  "《TheData Warehouse Toolkit:TheComplete Guide to Dimensional Modeling》"
  (source: "The Data Warehouse Toolkit: The Complete Guide…")

Root cause: pdfjs emits glyph runs that O'Reilly's fonts split **mid-word**
(italic/bold run boundaries). Our line assembly joins runs with no space
(TheData) yet inserts a space at other run boundaries (Generat ed). Both
symptoms = the run-merge heuristic uses the wrong gap threshold / ignores
per-run font changes. This corrupts the INPUT to the translator too, so it
hurts quality even before generation.

Fix (capture stage, model-agnostic): when merging adjacent items on a line,
insert a space iff the horizontal gap > ~0.25×avg-char-width; never split a
word across a font-change run (detect by item fontName change mid-word).
This is the single highest-leverage fix.

## 2. Running header/footer leakage

Source running heads are "<num> | <Section>" (bottom-left "iv | Table of
Contents") and "<Chapter#> | <Chapter Title>". Our capture treats these margin
lines as body text → they get translated and/or left as stray untranslated
lines mid-page ("数据仓库|5", "6|第一章…").

Fix (capture, model-agnostic): detect lines recurring at a fixed top/bottom y
band across ≥60% of pages, or matching the "<num>|<title>" / "|<num>" shape, and
DROP them before translation. (We already have per-page line y-coords.)

## 3. Terminology inconsistency

"lakehouse" alone has 6 renderings. Same for other recurring terms. This is a
MODEL-level issue (the small model doesn't hold a term constant across a 150-page
book because it translates paragraph-by-paragraph with no memory).

Fix options (ranked):
- (cheap, model-agnostic) Post-pass term normaliser: a canonical dict
  {lakehouse→湖仓, data warehouse→数据仓库, …} applied to output, replacing known
  variants. Low risk, big perceived-consistency win.
- (medium) Inject a locked-terms glossary into the prompt ("lakehouse 一律译作
  湖仓"). NOTE: user said no *user*-editable glossary UI, but an internal
  consistency list is a different thing and clearly warranted.
- (heavy) LoRA on parallel data (the poc/lora-corpus work) — but gated on the
  NMT base-model decision (see MODEL-AB doc).

## 4. Prose callouts left untranslated

The "〔原文保留〕" tag is over-applied: it correctly marks code/tables, but also
caught prose sidebars/notes and footnotes (p5 "Next, the data warehouse needs to
transform…" is ordinary prose in a callout box). Fix: tighten the keep-original
classifier so only code/tables/URLs are kept; prose callouts must translate.

## Correct-by-design (NOT bugs — verified)

- Code blocks, `%sql` cells, ASCII tables, console output, `part-…parquet` lines
  left verbatim — per the "tables/code/images 不翻译" constraint. My crude
  "27.9% untranslated" was dominated by these; real *prose* leakage is a small
  subset (#4).

## Completeness

433 ZH vs 1585 EN segments is explained by (correct) exclusion of code/tables/
TOC + header noise, not mass body-paragraph loss. Spot-checked pages 5–9 show
continuous, complete prose. No evidence of dropped paragraphs, but a full
per-chapter coverage diff is a cheap follow-up if wanted.

## Recommended order (all model-agnostic except #3)

1. Fix word-breaking/space merge in capture (highest reader impact).
2. Strip running headers/footers in capture.
3. Post-pass term normaliser (consistency).
4. Tighten keep-original classifier (translate prose callouts).
5. Fix list/bullet line grouping.

Each is testable against this same Delta Lake PDF (before/after render + the
segment stats above), so we adopt only on measured improvement.
