// translate.js
// POC: Test Hy-MT2-1.8B-Instruct Q4_K_M on CPU via node-llama-cpp
// Measures translation quality, speed (tokens/s), and memory usage.

import { getLlama, LlamaChatSession } from "node-llama-cpp";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Configuration ──────────────────────────────────────────────────────────
const MODEL_PATH = path.join("models", "Hy-MT2-1.8B.Q4_K_M.gguf");
const CONTEXT_SIZE = 4096;
const CPU_THREADS = Math.min(8, os.cpus().length);
const OUTPUT_FILE = "translation-results.json";

// ── Test passages (100-300 words each, technical documentation style) ─────
const TEST_PASSAGES = [
  {
    id: 1,
    source:
      "Garbage collection is a form of automatic memory management. The garbage collector attempts to reclaim memory that was allocated by the program but is no longer referenced; such memory is called garbage. In modern garbage-collected systems, the collector maintains a bitmap of used memory pages and periodically scans the heap to identify objects that are no longer reachable from the root set. This process, known as mark-and-sweep, divides the collection cycle into two phases. During the mark phase, the collector traverses all live objects starting from known roots such as global variables and stack frames. In the sweep phase, memory occupied by unreachable objects is reclaimed and returned to the allocator. The main advantage of this approach is that it eliminates manual memory management errors such as dangling pointers and double-free vulnerabilities.",
  },
  {
    id: 2,
    source:
      "Relational databases enforce ACID properties to ensure transaction reliability. Atomicity guarantees that a transaction either completes entirely or not at all. Consistency ensures that a transaction brings the database from one valid state to another. Isolation prevents concurrent transactions from interfering with each other, and durability guarantees that committed transactions persist even after a system crash. In practice, database administrators often tune isolation levels to balance consistency and throughput. The SERIALIZABLE level provides the strongest guarantees but may result in higher lock contention and reduced concurrency. Conversely, the READ COMMITTED level allows higher throughput at the cost of non-repeatable reads within a transaction. Most production systems default to READ COMMITTED, which represents a reasonable trade-off between correctness and performance.",
  },
  {
    id: 3,
    source:
      "To configure the reverse proxy, update the Nginx configuration file located at /etc/nginx/nginx.conf. Add the following block inside the http context:\n\n```\nupstream backend {\n    server 127.0.0.1:8080;\n    keepalive 64;\n}\n\nserver {\n    listen 443 ssl;\n    server_name api.example.com;\n    location / {\n        proxy_pass http://backend;\n        proxy_set_header Connection \"\";\n    }\n}\n```\n\nAfter modifying the configuration, run `nginx -t` to validate the syntax, then execute `systemctl reload nginx` to apply the changes without dropping existing connections. Ensure that the SSL certificate at /etc/ssl/certs/api.example.com.crt is valid and has not expired.",
  },
  {
    id: 4,
    source:
      "The TCP three-way handshake establishes a reliable connection between two hosts. The client initiates the process by sending a SYN packet with an initial sequence number. The server responds with a SYN-ACK packet, acknowledging the client's sequence number and proposing its own. Finally, the client sends an ACK packet to acknowledge the server's sequence number. At this point, both sides have confirmed that their send and receive buffers are operational. This handshake prevents stale connection requests from being interpreted as new connections, which could lead to data corruption. Network engineers should monitor SYN flood attacks, where an attacker sends numerous SYN packets without completing the handshake, exhausting the server's connection queue.",
  },
  {
    id: 5,
    source:
      "In a microservices architecture, each service owns its own database and communicates with other services through well-defined APIs. This approach improves modularity and allows teams to deploy services independently. However, it introduces challenges around data consistency across service boundaries. The Saga pattern addresses this by defining a sequence of local transactions, each updating a single service's database. If a later step fails, the Saga executes compensating transactions to roll back the changes made by earlier steps. Event-driven architectures often implement Sagas using a choreography style, where each service publishes events that trigger subsequent services. Alternatively, an orchestrator centrally controls the execution flow. Teams must carefully design idempotent operations to handle duplicate messages and partial failures gracefully.",
  },
];

// ── Prompt template ────────────────────────────────────────────────────────
function buildPrompt(text) {
  return `将以下英文技术文档翻译为简体中文。
要求：
1. 保留代码块、公式、URL 不翻译
2. 专业术语准确
3. 只输出译文，不要添加解释或原文

原文：
${text}

译文：`;
}

// ── Helper: measure memory ─────────────────────────────────────────────────
function memMB() {
  const m = process.memoryUsage();
  return {
    rssMB: +(m.rss / 1024 / 1024).toFixed(1),
    heapUsedMB: +(m.heapUsed / 1024 / 1024).toFixed(1),
    externalMB: +(m.external / 1024 / 1024).toFixed(1),
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=".repeat(70));
  console.log("Hy-MT2-1.8B CPU Translation POC");
  console.log("=".repeat(70));
  console.log(`Model: ${MODEL_PATH}`);
  console.log(`Context size: ${CONTEXT_SIZE}, Threads: ${CPU_THREADS}`);
  console.log(`OS CPUs: ${os.cpus().length} logical cores`);
  console.log("");

  // Verify model file
  if (!fs.existsSync(MODEL_PATH)) {
    console.error(`Model not found: ${MODEL_PATH}`);
    process.exit(1);
  }
  const stat = fs.statSync(MODEL_PATH);
  console.log(`Model file size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  console.log("");

  // Load llama
  console.log("[1/4] Loading llama...");
  const llama = await getLlama();
  console.log(`  llama.cpp build type: ${llama.buildType}`);
  console.log(`  CPU math cores: ${llama.cpuMathCores}, max threads: ${llama.maxThreads}`);

  // Load model
  console.log("[2/4] Loading model (may take 30-60s)...");
  const memBefore = memMB();
  const tLoadStart = Date.now();
  const model = await llama.loadModel({
    modelPath: MODEL_PATH,
    gpuLayers: 0, // CPU-only
    threads: CPU_THREADS,
  });
  const tLoadMs = Date.now() - tLoadStart;
  const memAfterLoad = memMB();
  console.log(`  Model loaded in ${(tLoadMs / 1000).toFixed(1)}s`);
  console.log(`  Memory after load: RSS=${memAfterLoad.rssMB}MB`);
  console.log("");

  // Create context
  console.log("[3/4] Creating context...");
  const context = await model.createContext({
    contextSize: CONTEXT_SIZE,
  });
  const sequence = context.getSequence();
  const memAfterCtx = memMB();
  console.log(`  Context created. Memory: RSS=${memAfterCtx.rssMB}MB`);
  console.log("");

  // Translate each passage
  console.log("[4/4] Running translation tests...");
  console.log("");

  const results = [];
  for (const passage of TEST_PASSAGES) {
    const prompt = buildPrompt(passage.source);
    console.log(`--- Passage ${passage.id} ---`);
    console.log(`  Source chars: ${passage.source.length}`);

    const session = new LlamaChatSession({
      chatWrapper: model.chatWrapper,
      contextSequence: sequence,
    });

    const memBeforeTr = memMB();
    const t0 = Date.now();

    let responseText;
    let meta;
    try {
      const result = await session.promptWithMeta(prompt, {
        maxTokens: 2048,
        temperature: 0.3,
        topP: 0.9,
        topK: 40,
      });
      responseText = result.responseText;
      meta = result;
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
      responseText = `[ERROR: ${e.message}]`;
      meta = null;
    }

    const elapsedMs = Date.now() - t0;
    const memAfterTr = memMB();

    // Count tokens via tokenizer (promptWithMeta v3.20.0 doesn't return token counts)
    const promptTokenIds = model.tokenize(prompt, true);
    const completionTokenIds = model.tokenize(responseText, false);
    const promptTokens = promptTokenIds.length;
    const completionTokens = completionTokenIds.length;
    const tokensPerSec = completionTokens ? +(completionTokens / (elapsedMs / 1000)).toFixed(2) : null;

    console.log(`  Translation: ${responseText.slice(0, 120)}...`);
    console.log(`  Time: ${(elapsedMs / 1000).toFixed(1)}s, Output chars: ${responseText.length}`);
    console.log(`  Tokens: prompt=${promptTokens}, completion=${completionTokens}`);
    console.log(`  Speed: ${tokensPerSec} tok/s`);
    console.log(`  Memory: RSS ${memBeforeTr.rssMB}MB -> ${memAfterTr.rssMB}MB`);
    console.log("");

    results.push({
      id: passage.id,
      source: passage.source,
      translation: responseText,
      sourceChars: passage.source.length,
      translationChars: responseText.length,
      elapsedMs,
      promptTokens,
      completionTokens,
      tokensPerSec,
      memoryBefore: memBeforeTr,
      memoryAfter: memAfterTr,
    });

    session.dispose();
  }

  // Compute summary
  const completionToks = results.filter((r) => r.completionTokens).map((r) => r.completionTokens);
  const elapsedTimes = results.map((r) => r.elapsedMs);
  const speeds = results.filter((r) => r.tokensPerSec).map((r) => r.tokensPerSec);

  const summary = {
    model: "Hy-MT2-1.8B-Q4_K_M",
    modelPath: MODEL_PATH,
    modelFileSizeMB: +(stat.size / 1024 / 1024).toFixed(1),
    contextSize: CONTEXT_SIZE,
    threads: CPU_THREADS,
    cpu: os.cpus()[0]?.model || "unknown",
    totalCores: os.cpus().length,
    loadTimeMs: tLoadMs,
    avgTokensPerSec: speeds.length ? +(speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(2) : null,
    minTokensPerSec: speeds.length ? Math.min(...speeds) : null,
    maxTokensPerSec: speeds.length ? Math.max(...speeds) : null,
    avgElapsedSec: +(elapsedTimes.reduce((a, b) => a + b, 0) / elapsedTimes.length / 1000).toFixed(2),
    totalCompletionTokens: completionToks.reduce((a, b) => a + b, 0),
    peakRssMB: Math.max(...results.map((r) => r.memoryAfter.rssMB)),
    memoryAfterLoadMB: memAfterLoad.rssMB,
    timestamp: new Date().toISOString(),
  };

  const output = { summary, results };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");
  console.log("=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  console.log(`Results saved to ${OUTPUT_FILE}`);

  // Cleanup
  model.dispose();
  llama.dispose();
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
