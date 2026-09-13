// download-model.mjs
// Download a GGUF model from hf-mirror with resume support (HTTP Range header).
// Usage: node download-model.mjs <url> <outputPath>
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const url = process.argv[2];
const outputPath = process.argv[3];

if (!url || !outputPath) {
  console.error("Usage: node download-model.mjs <url> <outputPath>");
  process.exit(1);
}

function fetchHeaders(u) {
  return new Promise((resolve, reject) => {
    const req = https.request(u, { method: "HEAD" }, (res) => {
      resolve(res.headers);
    });
    req.on("error", reject);
    req.end();
  });
}

function downloadChunk(u, startByte, expectedSize) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { Range: `bytes=${startByte}-` } };
    const req = https.request(u, opts, (res) => {
      // 200 = server ignored range (whole file), 206 = partial content
      const status = res.statusCode;
      if (status === 200) {
        // restart from 0
        startByte = 0;
      } else if (status !== 206) {
        res.resume();
        reject(new Error(`Unexpected status ${status}`));
        return;
      }
      const tmpPath = outputPath + ".part";
      const stream = fs.createWriteStream(tmpPath, { flags: startByte > 0 ? "a" : "w" });
      let received = startByte;
      const total = expectedSize || parseInt(res.headers["content-length"] || "0", 10) + startByte;
      const t0 = Date.now();
      let lastLog = t0;
      res.on("data", (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastLog > 2000) {
          const elapsed = (now - t0) / 1000;
          const speed = ((received - startByte) / 1024 / 1024) / Math.max(elapsed, 0.1);
          const pct = total ? ((received / total) * 100).toFixed(1) : "?";
          process.stdout.write(
            `\r  ${(received / 1024 / 1024).toFixed(1)}MB / ${total ? (total / 1024 / 1024).toFixed(1) + "MB" : "?"} (${pct}%) @ ${speed.toFixed(2)} MB/s   `
          );
          lastLog = now;
        }
      });
      res.pipe(stream);
      stream.on("finish", () => {
        stream.close(() => {
          process.stdout.write("\n");
          resolve();
        });
      });
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  // If .part exists, resume; if final exists, skip.
  const tmpPath = outputPath + ".part";
  let startByte = 0;
  if (fs.existsSync(tmpPath)) {
    startByte = fs.statSync(tmpPath).size;
    console.log(`Resuming from ${(startByte / 1024 / 1024).toFixed(1)} MB`);
  } else if (fs.existsSync(outputPath)) {
    console.log(`Already exists: ${outputPath}, size=${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)} MB`);
    return;
  }

  const headers = await fetchHeaders(url);
  const totalSize = parseInt(headers["content-length"] || "0", 10);
  console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);

  await downloadChunk(url, startByte, totalSize);

  // rename .part -> final
  fs.renameSync(tmpPath, outputPath);
  const finalSize = fs.statSync(outputPath).size;
  console.log(`Done. Final size: ${(finalSize / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error("\nDownload failed:", e.message);
  process.exit(1);
});
