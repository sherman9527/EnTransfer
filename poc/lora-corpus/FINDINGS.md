# LoRA Corpus — good-book survey (2026-09-19)

Source: `../../good book` (51 PDFs, 12 subject folders). Goal: build parallel
EN→ZH (EN, ZH) pairs to fine-tune the shipped Qwen3-1.7B for domain polysemy
(team→球队, manager→教练) that few-shot cannot cleanly fix.

Every claim below was verified by actually extracting text (probe-text.cjs),
NOT by trusting filenames — two "obvious" pairs turned out unusable.

## Confirmed GOLD pairs (both sides have a real text layer + genuine translation)

| EN book | ZH book | ZH pages | ZH text quality |
|---|---|---|---|
| system/OReilly.Learning.OpenTelemetry.2024.3.pdf | system/OpenTelemetry 可观测性的未来 …pdf | 133 | 8704 items, avg 1 char/item (CJK, needs de-spacing) |
| system/System Design Interview An Insider's Guide (Alex Xu).pdf | system/搞定系统设计：面试敲开大厂的门 (Alex Xu).pdf | 294 | 8230 items, avg 7 chars — clean |

## REJECTED "pairs" (my earlier notes were wrong — caught by testing)

- **react/Learning React ↔ REACT学习手册（第二版）** — ZH side is a SCANNED image PDF:
  textItems = 0. No text layer → needs OCR, not a gold pair. DEAD.
- **spark/High Performance Spark ↔ 高性能Spark（影印版）** — 影印版 = Chinese publisher's
  reprint of the ENGLISH original (also 0 text items, image scan). English↔English anyway. DEAD.

## Other near-matches considered, NOT pairs

- C#/架构整洁之道 (Robert Martin, Clean Architecture ZH) — EN twin absent; the EN file
  present is *Clean Architecture with .NET* (different book). Skip.
- The remaining Chinese titles (C# textbooks, 深入React技术栈, 代码随想录, …) are
  original Chinese works, not translations of an EN book here → not parallel pairs.

## English-only books (harvest raw EN prose → eval set + later back-translation/rejection-sampling)

~24 text PDFs: Data Mesh, Delta Lake ×2, API Design Patterns, GraphQL ×4, JavaScript
Everywhere, Functional Design, Think Like a Manager, ASP.NET Core ×3, Code like a Pro,
Clean Architecture with .NET, Learning Spark, Stream Processing w/ Spark, Big Book of
Data Engineering, Ultimate Data Engineering, Beginning Apache Spark, Learning OpenTelemetry(EN),
both System Design Interview vols, Learning React(EN), React in Depth, React Up Running.
(All have text layers — Data-Mesh style EN books extract ~avg 6-8 char items.)

## Next

- build-pairs: content-anchored segment aligner for the 2 confirmed pairs → gold SFT JSONL.
- extract-en: reuse captureFlow (via esbuild bundle, native C1 external) to harvest EN prose.

## Alignment reality check (2026-09-19, after 6+ iterations)

Harvest side is GOOD: `harvest-segments.ts` cleanly yields ordered paragraphs for
both EN and ZH (CJK de-spaced incl. Kangxi radicals; cMap + standard-font URLs
required or ZH pages silently drop text). Reusable for the EN eval corpus too.

Align side is NOT production-grade. `build-pairs.ts` (rare-token IDF edges →
weighted non-crossing monotone chain, + code/index/table filters) reaches only
~40-60% precision on OpenTelemetry. Root cause: single shared rare tokens
("resource", "service.version") also occur in adjacent-but-unrelated paragraphs
and in ZH *table rows* echoing an identifier, so a purely lexical aligner can't
separate them. Recall also low (~25 clean pairs from 651·302).

Conclusion: to get genuinely gold SFT pairs we need a **bilingual sentence
embedding** aligner (e.g. LaBSE / a CTranslate2 XLMR) or vecmap-style, not
heuristic tokens. `otel.pairs.jsonl` is kept only as an experimental seed.

GATING DECISION: before investing further in Qwen3-LoRA data, first benchmark
purpose-built NMT (Helsinki opus-mt-en-zh 600M + CTranslate2, NLLB-200-3.3B)
against Qwen3-1.7B. If a dedicated translator wins on quality AND speed, LoRA on
Qwen3 is the wrong target. See docs/MODEL-AB-2026-09.md.

## Embedder alignment experiments (2026-09-19) — ceiling reached

Tried to beat the ~50% token-aligner with semantic alignment on the OpenTelemetry
gold pair. Configs tested, each measured by eyeballing 8+ random aligned pairs:

| method | granularity | min | pairs | precision |
|---|---|---|---|---|
| token IDF + monotone chain | paragraph | 2.0 | ~38 | ~50% |
| MiniLM multilingual + DP | paragraph | 0.55 | 64 | ~50% |
| LaBSE + DP | paragraph | 0.60 | 43 | ~45% |
| LaBSE + DP | sentence | 0.68 | 2 | ~100% (too few) |
| LaBSE + DP | sentence | 0.55 | 23 | ~35% |

Root cause is NOT embedder quality (LaBSE sanity: true=0.94 false=0.28) — it is the
**~2.5:1 granularity mismatch**: the ZH translation merges/splits paragraphs
differently, so no clean 1:1 exists; the monotone DP then returns partial matches
(e.g. EN "connect in Figure 4-1" ↔ ZH "数据被连接到一个图中" — coincidental 连接).

Conclusion: embedder+DP heuristics cannot reach gold (~90%+) on these two
differently-typeset books. Real gold data needs a dedicated bitext miner
(vecmap/Orion with a cross-encoder re-scoring pass) or human curation.

## #24 pipeline status — scaffolding DONE, data is the bottleneck

Built and committed:
- `harvest-segments.ts` — EN/ZH paragraph harvester (CJK de-space, furniture+spam
  filter, cMap). GOOD, reusable.
- `align_embed.py` — embedder (LaBSE/MiniLM) monotone aligner → SFT JSONL. Works,
  but precision ceiling ~50% (above).
- `train_lora.py` — QLoRA SFT of Qwen3-1.7B (4-bit, paged AdamW, 6GB-ready).
  READY TO RUN on gold JSONL; not yet run (no gold data).
- `eval_gate.sh` — A/B base vs LoRA GGUF on the real engine's quality-cases; adopts
  only on strict improvement (AGENTS.md gate).

BLOCKER: not enough gold-precision parallel data. AND these 2 tech books don't
target the motivating polysemy (team→球队 is management-domain, absent here).
Recommendation: either (a) invest in vecmap-style bitext mining + cross-encoder
verify, or (b) source parallel books in the TARGET domain, before training.
