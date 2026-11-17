import { chromium, firefox, webkit } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import assert from "node:assert/strict";

const server = spawn(process.execPath, ["scripts/serve.mjs", "artifacts/browser-site"], {
  stdio: ["ignore", "pipe", "inherit"],
});

await new Promise((resolve, reject) => {
  server.stdout.once("data", resolve);
  server.once("error", reject);
  server.once("exit", (code) => reject(new Error(`Server exited: ${code}`)));
});
const results = {};
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await launcher.launch();
    const cases = [];
    try {
      for (let round = 0; round < 3; round++) {
        for (const idle of round % 2 ? [5000, 0] : [0, 5000]) {
          const page = await browser.newPage();
          let wasmRequests = 0;
          page.on("request", (request) => {
            if (/tsrs[^/]*\.wasm$/.test(request.url())) wasmRequests++;
          });
          await page.goto(`http://127.0.0.1:4331/features/?project=react&typeIdle=${idle}`);
          await page.waitForFunction(() => document.body.dataset.phase === "ready");

          const measured = await page.evaluate(async () => {
            const times = [];
            const failures = [];
            for (let i = 0; i < 6; i++) {
              const start = performance.now();
              const result = await window.session.check("types");
              times.push(performance.now() - start);
              failures.push(result.diagnostics);
            }

            const workers = window.ownedWorkers.filter(
              (worker) => worker.name === "reploom-typecheck",
            );

            return {
              timesMs: times,
              failures,
              workerCount: workers.length,
              liveWorkers: workers.filter((worker) => !worker.retired).length,
              wasmPeakBytes: workers.flatMap((worker) =>
                worker.replies.map((reply) => reply.memoryBytes),
              ),
            };
          });

          assert.deepEqual(
            measured.failures,
            Array.from({ length: 6 }, () => []),
          );
          delete measured.failures;
          assert.equal(measured.workerCount, idle ? 1 : 6);
          if (idle && round === 0) {
            await page.waitForFunction(
              () =>
                window.ownedWorkers
                  .filter((worker) => worker.name === "reploom-typecheck")
                  .every((worker) => worker.retired),
              undefined,
              { timeout: 10000 },
            );
            measured.idleRetirementObserved = true;
          }
          cases.push({ round, idleMs: idle, wasmRequests, ...measured });
          await page.close();
        }
      }
      const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      results[engine] = {
        version: browser.version(),
        cases,
        medianRepeatedMs: Object.fromEntries(
          [0, 5000].map((idle) => [
            idle,
            median(cases.filter((c) => c.idleMs === idle).flatMap((c) => c.timesMs.slice(1))),
          ]),
        ),
      };
      console.log(engine, results[engine].medianRepeatedMs);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.kill("SIGTERM");
}

const manifest = JSON.parse(
  await readFile("artifacts/browser-site/features/assets/manifest.json", "utf8"),
);

const configuration = JSON.parse(
  await readFile("artifacts/browser-site" + manifest.typecheck.configuration.url, "utf8"),
);

await mkdir("artifacts/benchmarks", { recursive: true });
await writeFile(
  "artifacts/benchmarks/typecheck.json",
  JSON.stringify(
    {
      date: new Date().toISOString(),
      cpu: cpus()[0].model,
      scope:
        "Same current checker and React project. Three fresh pages per policy, six checks per page, alternating policy order. Repeated medians exclude each page's first check. Includes asset loading, Worker startup, WASM initialization and diagnostic delivery. Standard browser cache policy: no-store. WASM peak is per invocation, not process RSS; declaration bytes exclude JS index and compiled Module overhead.",
      staticDeclarationFiles: Object.keys(configuration.files).length,
      staticDeclarationUtf8Bytes: Object.values(configuration.files).reduce(
        (n, text) => n + Buffer.byteLength(text),
        0,
      ),
      results,
    },
    null,
    2,
  ) + "\n",
);
