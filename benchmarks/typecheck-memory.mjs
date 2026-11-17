import { chromium, firefox, webkit } from "@playwright/test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import assert from "node:assert/strict";
import path from "node:path";

const execute = promisify(execFile);

async function processes() {
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,rss=,comm="]);
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [, pid, parent, kib, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return { pid: Number(pid), parent: Number(parent), bytes: Number(kib) * 1024, command };
    });
}

async function footprint(root, before, webkitRoot) {
  const rows = await processes();
  const owned = new Set([root]);
  for (const row of rows)
    if (webkitRoot && !before.has(row.pid) && row.command.startsWith(webkitRoot))
      owned.add(row.pid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { pid, parent } of rows)
      if (owned.has(parent) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
  }
  const included = rows.filter((row) => owned.has(row.pid));
  return {
    bytes: included.reduce((sum, row) => sum + row.bytes, 0),
    processes: included.map(({ command, ...row }) => ({ ...row, name: path.basename(command) })),
  };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
    const cases = [];
    for (let round = 0; round < 2; round++) {
      for (const idleMs of round % 2 ? [5000, 0] : [0, 5000]) {
        const before = new Set((await processes()).map((row) => row.pid));

        const webkitRoot =
          engine === "webkit" ? path.dirname(launcher.executablePath()) + path.sep : undefined;

        const owner = await launcher.launchServer();
        const memory = () => footprint(owner.process().pid, before, webkitRoot);
        const browser = await launcher.connect(owner.wsEndpoint());
        const samples = [];
        let sampling = true;
        let poll;
        try {
          const page = await browser.newPage();
          await page.goto(`http://127.0.0.1:4331/features/?project=react&typeIdle=${idleMs}`);
          await page.waitForFunction(() => document.body.dataset.phase === "ready");
          await sleep(200);
          const base = await memory();
          const start = performance.now();
          poll = (async () => {
            while (sampling) {
              samples.push({
                ms: performance.now() - start,
                ...(await memory()),
              });
              await sleep(100);
            }
          })();

          const checks = await page.evaluate(async () => {
            const results = [];
            for (let i = 0; i < 30; i++)
              results.push((await window.session.check("types")).diagnostics.length);
            return results;
          });

          assert.ok(checks.every((count) => count === 0));
          const finished = performance.now();
          const settled = await memory();
          await page.waitForFunction(() =>
            window.ownedWorkers
              .filter((worker) => worker.name === "reploom-typecheck")
              .every((worker) => worker.retired),
          );
          const retired = await memory();
          const retiredAfterMs = performance.now() - finished;
          await sleep(Math.max(0, 5500 - (performance.now() - finished)));
          const afterIdle = await memory();
          const observedAfterMs = performance.now() - finished;
          sampling = false;
          await poll;
          cases.push({
            round,
            version: browser.version(),
            idleMs,
            checks: 30,
            baseBytes: base.bytes,
            ownership: { base, settled, retired, afterIdle },
            retiredAfterMs,
            observedAfterMs,
            peakBytes: Math.max(settled.bytes, ...samples.map((s) => s.bytes)),
            settledBytes: settled.bytes,
            afterIdleBytes: afterIdle.bytes,
            samples,
          });
          console.log(engine, idleMs, {
            baseMiB: base.bytes / 1048576,
            settledMiB: settled.bytes / 1048576,
            afterIdleMiB: afterIdle.bytes / 1048576,
          });
        } finally {
          sampling = false;
          await poll;
          await browser.close();
          await owner.close();
        }
      }
    }
    results[engine] = cases;
  }
} finally {
  server.kill("SIGTERM");
}
await mkdir("artifacts/benchmarks", { recursive: true });
await writeFile(
  "artifacts/benchmarks/typecheck-memory.json",
  JSON.stringify(
    {
      date: new Date().toISOString(),
      cpu: cpus()[0].model,
      scope:
        "Separate memory experiment, not a latency benchmark. Two fresh browser-process-tree trials per policy, alternating order, 30 checks each. RSS sums the launched browser PID and current descendants every ~100ms using ps. For WebKit, newly launched processes from the same Playwright WebKit installation are also included because macOS XPC reparents WebContent/Networking/GPU to PID 1. Prior process IDs are excluded. Run serially without other Playwright launches. Ownership lists accompany the samples. This includes browser/JIT/editor/preview/automation costs; unrelated OS services are outside the denominator. No forced GC. Idle observations require actual Worker retirement and use a common 5,500ms interval after the last check for both policies. Earlier retirement is also recorded. No browser/benchmark suite runs concurrently.",
      results,
    },
    null,
    2,
  ) + "\n",
);
