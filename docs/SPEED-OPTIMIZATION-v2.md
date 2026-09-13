# Speed Optimization v2 — Microsoft YaHei Epoch

> Date: 2026-09-13
> Hardware: i5-12600KF (6P+4E/16 thr), GTX 1060 6GB Vulkan, 32GB RAM
> Model: Qwen3-1.7B Q4_K_M, disableReasoning=true

## Baseline

| Config | 50-page time | tok/s (GPU) | Notes |
|--------|-------------|-------------|-------|
| threads=12, ctx=1024 (old) | ~213s | ~70 | Previous benchmark |
| threads=12, ctx=2048 | ~222s | ~70 | Baseline for this round |

## Tests

### 1. Thread count tuning

| Threads | 50-page time | Result |
|---------|-------------|--------|
| 12 | ~222s | Baseline (sweet spot) |
| 14 | ~245s | +10% slower (E-core contention) |
| 16 | — | Not tested (expected worse) |

**Conclusion**: threads=12 remains optimal. Adding E-cores (threads 13-16) hurts due to
synchronization overhead in Vulkan mode. CPU threads mainly affect prefill, which is
already fast with GPU offloading.

### 2. Context size

| Context | 50-page time | Notes |
|---------|-------------|-------|
| 1024 | ~213s (old) | Was previous default |
| 2048 | ~222s | Current default, identical decode speed |

**Conclusion**: ctx=2048 gives headroom for batching without measurable decode penalty.
KV cache memory increase is ~65MB, well within 6GB VRAM.

### 3. Prefix caching (system prompt KV reuse)

Already implemented via `sequence.adaptStateToTokens(systemTokens, false)` in
`resetToSystemPrefix()`. This skips re-prefilling the system prompt on every request.
Verified working: first request after warmup shows ~300ms first-token latency;
subsequent requests show ~80-120ms (system prompt KV cached).

### 4. Batch translation (merge short paragraphs)

Implemented in `pipeline.ts`: consecutive short paragraphs (<250 chars) on the same
page are merged with `\n---\n` delimiter, translated in one request, then split.

| Config | 50-page time | Batch hits/falls |
|--------|-------------|-----------------|
| No batch | ~222s | — |
| batch_size=3, <250 chars | ~227s | 16 successful, 13 fell back |

**Conclusion**: Batching did not yield net improvement. ~45% of batches fail to
preserve the `\n---\n` delimiter in model output, causing fallback to individual
translation (which costs extra time). When it works, it saves prefill but the
joined text generates proportionally more tokens — net wash at 70 tok/s.

The code is kept as it helps for very short items (headings, list items) where
delimiter preservation is more reliable.

### 5. System prompt deduplication

Tested removing the system prompt from `buildPrompt()` (it was duplicated: once
as session systemPrompt, again embedded in the user message text).

**Result**: No speed improvement, and quality risk — the model relies on the
explicit instruction in the user message. Reverted.

### 6. Quantization

Q3_K_M / IQ3 not available for Qwen3-1.7B on ModelScope. Skipped.

## Final Configuration

```
threads: 12
contextSize: 2048
device: gpu (Vulkan)
batch translation: enabled (batch_size=3, <250 chars)
prefix caching: enabled
temperature: 0.1, topK: 20, topP: 0.9
```

## Speed Summary

| Metric | Value |
|--------|-------|
| 50-page E2E time | ~230-240s (varies ±10s run-to-run) |
| Translation tasks | 205 |
| Avg per task | ~1.1s |
| GPU decode speed | ~70 tok/s |
| Typeset time | ~4s |
| Extract time | ~4s |

The GPU decode speed is the hard bottleneck. Further speedup would require:
- A smaller/faster model (Q3 quantization)
- GPU upgrade (more VRAM bandwidth)
- Speculative decoding
