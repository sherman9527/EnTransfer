/**
 * tests/cpu-info-test.ts — verify CPU detection & smart thread selection.
 *
 * Part A detects the CPU on the CURRENT machine and prints the result.
 *   For the dev box (i5-12600KF, 6P+4E, 16 logical) it must report:
 *     isHybrid=true, performanceCores=6, defaultThreads=12.
 *
 * Part B feeds synthetic (model, logical, physical, arch) tuples into the pure
 * builder so the heuristics are checked without touching the OS.
 *
 * Run (repo root):
 *   node_modules\.bin\esbuild tests/cpu-info-test.ts --bundle --platform=node \
 *     --format=cjs --outfile=.scratch/cpu-info-test.cjs
 *   node .scratch/cpu-info-test.cjs
 */
import {
  buildCpuInfo,
  detectCpu,
  describeCpu,
  getDefaultThreads,
  shortCpuName
} from '../electron/models/cpu-info.ts'

let failures = 0
function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.error(`  FAIL  ${label}`)
  }
}

function main(): void {
  console.log('=== EnTransfer CPU info test ===\n')

  // ---------------------------------------------------------------- Part A
  console.log('--- Part A: live detection on this machine ---')
  const cpu = detectCpu()
  console.log(`  model        : ${cpu.model}`)
  console.log(`  arch         : ${cpu.architecture}`)
  console.log(`  physical     : ${cpu.physicalCores} (${cpu.physicalSource})`)
  console.log(`  logical      : ${cpu.logicalCores}`)
  console.log(`  isHybrid     : ${cpu.isHybrid}`)
  console.log(`  performance  : ${cpu.performanceCores} P-cores`)
  console.log(`  short name   : ${shortCpuName(cpu.model)}`)
  console.log(`  description  : ${describeCpu(cpu)}`)
  console.log(`  recommended  : ${getDefaultThreads(cpu)} threads\n`)

  // The dev box is an i5-12600KF (6P+4E, 16 logical).
  check(cpu.isHybrid, 'this machine detected as hybrid (P+E)')
  check(cpu.performanceCores === 6, `P-cores == 6 (got ${cpu.performanceCores})`)
  check(getDefaultThreads(cpu) === 12, `default threads == 12 (got ${getDefaultThreads(cpu)})`)
  check(cpu.logicalCores === 16, `logical == 16 (got ${cpu.logicalCores})`)
  check(/i5-12600KF/i.test(shortCpuName(cpu.model)), `short name mentions i5-12600KF (got "${shortCpuName(cpu.model)}")`)
  console.log('')

  // ---------------------------------------------------------------- Part B
  console.log('--- Part B: synthetic heuristic checks ---')

  // i5-12600KF: 10 physical (6P+4E), 16 logical → hybrid, 6P, 12 threads.
  const t1 = buildCpuInfo('12th Gen Intel(R) Core(TM) i5-12600KF', 16, 10, 'x64', 'wmi')
  check(t1.isHybrid, '[i5-12600KF] hybrid')
  check(t1.performanceCores === 6, `[i5-12600KF] 6P (got ${t1.performanceCores})`)
  check(getDefaultThreads(t1) === 12, `[i5-12600KF] 12 threads (got ${getDefaultThreads(t1)})`)

  // i7-12700K: 16 physical (8P+8E), 20 logical → hybrid, 8P, 16 threads.
  const t2 = buildCpuInfo('12th Gen Intel(R) Core(TM) i7-12700K', 20, 16, 'x64', 'wmi')
  check(t2.isHybrid, '[i7-12700K] hybrid')
  check(t2.performanceCores === 8, `[i7-12700K] 8P (got ${t2.performanceCores})`)
  check(getDefaultThreads(t2) === 16, `[i7-12700K] 16 threads (got ${getDefaultThreads(t2)})`)

  // Non-hybrid 12th-gen part: i5-12400 = 6P, no E-cores, 6 physical / 12 logical (ratio 2.0).
  // Must NOT be flagged hybrid; default = physical = 6 (skip HT).
  const t3 = buildCpuInfo('12th Gen Intel(R) Core(TM) i5-12400', 12, 6, 'x64', 'wmi')
  check(!t3.isHybrid, '[i5-12400] NOT hybrid (no E-cores)')
  check(getDefaultThreads(t3) === 6, `[i5-12400] 6 threads (got ${getDefaultThreads(t3)})`)

  // Older pure-HT chip: i7-8700K = 6 physical / 12 logical, ratio exactly 2.
  const t4 = buildCpuInfo('Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz', 12, 6, 'x64', 'wmi')
  check(!t4.isHybrid, '[i7-8700K] NOT hybrid')
  check(getDefaultThreads(t4) === 6, `[i7-8700K] 6 threads (skip HT; got ${getDefaultThreads(t4)})`)

  // No-HT chip (e.g. budget): 6 physical / 6 logical. Default = 6.
  const t5 = buildCpuInfo('AMD Ryzen 5 5500 6-Core', 6, 6, 'x64', 'wmi')
  check(!t5.isHybrid, '[Ryzen 5500] NOT hybrid')
  check(getDefaultThreads(t5) === 6, `[Ryzen 5500] 6 threads (got ${getDefaultThreads(t5)})`)

  // WMI unavailable → physical estimated as logical/2. A 12th-gen SKU with
  // 16 logical is assumed hybrid via the generation fallback, P=6 → 12 threads.
  const t6 = buildCpuInfo('12th Gen Intel(R) Core(TM) i5-12600KF', 16, 8, 'x64', 'estimate')
  check(t6.isHybrid, '[i5-12600KF, WMI failed] assumed hybrid via gen fallback')
  check(t6.performanceCores === 6, `[estimate] P still resolved from SKU = 6 (got ${t6.performanceCores})`)
  check(getDefaultThreads(t6) === 12, `[estimate] 12 threads (got ${getDefaultThreads(t6)})`)

  // Unknown architecture fallback: max(2, logical-1).
  const t7 = buildCpuInfo('Some ARM chip', 8, 8, 'unknown', 'wmi')
  check(getDefaultThreads(t7) === 7, `[unknown arch] max(2,8-1)=7 (got ${getDefaultThreads(t7)})`)

  // Floor of 2 on a 2-thread machine.
  const t8 = buildCpuInfo('Dual core', 2, 2, 'x64', 'wmi')
  check(getDefaultThreads(t8) === 2, `[dual core] floor 2 (got ${getDefaultThreads(t8)})`)
  console.log('')

  // ---------------------------------------------------------------- Summary
  if (failures > 0) {
    console.error(`=== FAILED: ${failures} check(s) failed ===`)
    process.exit(1)
  }
  console.log('=== ALL CHECKS PASSED ===')
}

main()
