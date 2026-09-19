// test-validate.ts — E3 POC: measure the validator's FALSE-POSITIVE rate on
// known-good translations (80 paragraphs accepted by eye from the GPU Q4 run)
// and its DETECTION rate on known-bad (the IQ2 collapse output) plus synthetic
// corruptions (echo / number drop / sentinel loss / marker leak / length blowup).
import fs from 'node:fs'
import path from 'node:path'
import { validateModelOutput, validateRestored } from '../../electron/pdf/validate'

const ROOT = process.cwd()
const POC = path.join(ROOT, 'poc', 'speed-v3')

function loadPairs(file: string): Array<{ src: string; out: string }> {
  const raw = fs.readFileSync(path.join(POC, file), 'utf8')
  const out: Array<{ src: string; out: string }> = []
  for (const chunk of raw.split(/^### \d+$/m).slice(1)) {
    const src = /^SRC: (.*)$/m.exec(chunk)?.[1] ?? ''
    const zh = /^ZH : (.*)$/m.exec(chunk)?.[1] ?? ''
    if (src && zh) out.push({ src, out: zh })
  }
  return out
}

function main() {
  const good = loadPairs('out-gpu-seq1-spec0-Qwen3-1.7B-Q4_K_M.txt')
  let fp = 0
  const fpDetail: string[] = []
  for (const p of good) {
    const r = validateRestored(p.src, p.out)
    if (!r.ok) { fp++; fpDetail.push(`${r.reasons.join('|')} :: ${p.src.slice(0, 40)}…`) }
  }
  console.log(`FALSE-POSITIVE on 80 good (Q4): ${fp}/${good.length}`)
  for (const line of fpDetail.slice(0, 10)) console.log('  FP:', line)

  const bad = loadPairs('out-gpu-seq1-spec0-Qwen3-1.7B-UD-IQ2_XXS.txt')
  let det = 0
  let badN = 0
  for (const p of bad) {
    if (/^[A-Za-z0-9 ,.:;'’()\-\/\n]+$/.test(p.out) && p.out.length > 25) { // clearly-Latin output = must-flag population
      badN++
      if (!validateRestored(p.src, p.out).ok) det++
    }
  }
  console.log(`DETECTION on clearly-bad IQ2 subset: ${det}/${badN}`)

  // Synthetic corruptions on good pairs.
  let syn = 0, synOk = 0
  const synth = (s: string, o: string): string | null => {
    if (o === s) return 'echo'
    const nums = o.match(/\d+(?:[.,]\d+)*/g)
    if (nums && nums.length > 0) return o.replace(/\d+(?:[.,]\d+)*/g, '')
    return o + ' </think> tail'
  }
  for (const p of good.slice(0, 60)) {
    syn++
    if (!validateRestored(p.src, synth(p.src, p.out) ?? '').ok) synOk++
  }
  console.log(`DETECTION on synthetic corruptions: ${synOk}/${syn}`)

  // Sentinel phase: exact + dropped/dup.
  const m = 'Deploy §A§ before §B§ config'
  console.log('sentinel exact pass:', validateModelOutput(m, '在 §A§ 之前部署 §B§ 配置').ok)
  console.log('sentinel dropped caught:', !validateModelOutput(m, '在 §A§ 之前部署配置').ok)
  console.log('sentinel dup pass (dup allowed):', validateModelOutput(m, '§A§ §A§ 之前 §B§').ok)

  // Direct unit cases for phase 2.
  const g = good[10]
  console.log('echo caught:', !validateRestored(g.src, g.src).ok)
  console.log('marker-leak caught:', !validateRestored(g.src, g.out + ' </think>').ok)
  console.log('leak-sentinel caught:', !validateRestored(g.src, g.out + ' §Z§').ok)
  console.log('long-latin caught:', !validateRestored(g.src, 'The quick brown fox jumps over the lazy dog while the engineer reviews the pull request pipeline').ok)
  console.log('short-term kept ok:', validateRestored('Kubernetes', 'Kubernetes').ok);console.log('num-to-words ok:', validateRestored('In chapter 12, we explored the responsibilities of an engineering manager and emphasized the importance of managing teams effectively across the organization.', '在第12章中，我们探讨了工程经理的职责，并强调了在整个组织中有效管理团队的重要性。').ok);console.log('num-dropped still caught:', !validateRestored('The cluster holds 4,096 items across 128 nodes with latency 37ms typical of production workloads.', '这些集群包含大量条目分布于众多节点，延迟较低。').ok)
}
main()
