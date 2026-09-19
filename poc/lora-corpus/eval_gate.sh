#!/usr/bin/env bash
# eval_gate.sh — the LoRA adoption GATE. A/B the fine-tuned GGUF against the
# shipped base on the app's REAL engine (node-llama-cpp/Vulkan) using the
# existing curated quality-cases harness (the same 26-case suite that gates the
# base model). Adopt the adapter ONLY if it strictly improves and never regresses
# (AGENTS.md: 有提升才导入).
#
#   bash poc/lora-corpus/eval_gate.sh <base.gguf> <lora.gguf>
#
# Prereq: lora.gguf = base merged with the train_lora.py adapter, then
# quantized to Q4_K_M via llama.cpp gguf-convert/quantize (see train_lora.py note).
set -euo pipefail
BASE="${1:?usage: eval_gate.sh <base.gguf> <lora.gguf>}"
LORA="${2:?usage: eval_gate.sh <base.gguf> <lora.gguf>}"

echo "=== BASE ($BASE) ==="
QC_MODEL="$BASE" node poc/eval-2026/quality-cases.ts | tee .scratch/eval-base.txt
echo "=== LORA ($LORA) ==="
QC_MODEL="$LORA" node poc/eval-2026/quality-cases.ts | tee .scratch/eval-lora.txt

# extract "N/M" pass counts (quality-cases prints a final tally)
b=$(grep -oE '[0-9]+/[0-9]+' .scratch/eval-base.txt | tail -1)
l=$(grep -oE '[0-9]+/[0-9]+' .scratch/eval-lora.txt | tail -1)
echo
echo "base=$b  lora=$l"
bp=${b%/*}; bl=${b#*/}; lp=${l%/*}; ll=${l#*/}
if [ "$lp" -gt "$bp" ] && [ "$ll" -eq "$bl" ]; then
  echo "GATE: PASS — lora strictly better, no regression. Consider adopting."
elif [ "$lp" -lt "$bp" ]; then
  echo "GATE: FAIL — lora regressed a base-passing case. Do NOT adopt."
else
  echo "GATE: NEUTRAL — no improvement. Do NOT adopt (avoid added complexity/risk)."
fi
