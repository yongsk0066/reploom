import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname, dirname, sep } from "node:path";
import { cpus } from "node:os";
import { chromium, firefox, webkit, expect } from "@playwright/test";

const baseline = process.env.REPLOOM_INTERACTION_BASELINE;

const roots = {
  current: resolve("artifacts/browser-site"),
  ...(baseline ? { baseline: resolve(baseline) } : {}),
};

const rounds = Number(process.env.REPLOOM_INTERACTION_ROUNDS ?? 3);
const count = Number(process.env.REPLOOM_INTERACTION_SAMPLES ?? 40);

const cases = process.env.REPLOOM_INTERACTION_CASES?.split(",") ?? [
  "ordinary",
  "large",
  "concurrent",
  "resumed",
];

assert.ok(Number.isSafeInteger(rounds) && rounds > 0);
assert.ok(Number.isSafeInteger(count) && count >= 2 && count % 2 === 0);
for (const name of cases) assert.ok(["ordinary", "large", "concurrent", "resumed"].includes(name));
let active = "current";

const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".css": "text/css",
};

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;

    const path = resolve(
      roots[active],
      "." + decodeURIComponent(pathname) + (pathname.endsWith("/") ? "index.html" : ""),
    );

    if (!path.startsWith(roots[active] + sep)) throw Error("Invalid path");
    response.setHeader("content-type", mime[extname(path)] ?? "application/octet-stream");
    response.setHeader("cache-control", "no-store");
    response.end(await readFile(path));
  } catch {
    response.statusCode = 404;
    response.end();
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const output = process.argv[2] ?? "artifacts/benchmarks/interaction.json";
const results = [];

const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];

try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    if (
      process.env.REPLOOM_INTERACTION_ENGINES &&
      !process.env.REPLOOM_INTERACTION_ENGINES.split(",").includes(engine)
    )
      continue;
    const browser = await launcher.launch();
    try {
      for (let round = 0; round < rounds; round++) {
        const variants = Object.keys(roots);
        if (round % 2) variants.reverse();
        for (const variant of variants)
          for (const name of cases) {
            active = variant;

            const context = await browser.newContext({
              viewport: { width: 1100, height: 800 },
              serviceWorkers: "block",
            });

            const page = await context.newPage();
            page.setDefaultTimeout(15000);
            console.log(engine, variant, round, name, "starting");
            const external = [];
            page.on("request", (request) => {
              const url = new URL(request.url());
              if (url.origin !== origin && !["blob:", "data:"].includes(url.protocol))
                external.push(url.href);
            });
            try {
              await page.goto(origin + "/features/?project=react&language&languageIdle=150");
              await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
              const button = page.frameLocator("iframe").getByRole("button");
              await button.click();
              const editor = page.getByRole("textbox", { name: "Feature editor" });
              await editor.focus();
              await editor.press("ControlOrMeta+End");
              if (name === "large") {
                await editor.evaluate((element) => {
                  const clipboardData = new DataTransfer();
                  clipboardData.setData(
                    "text/plain",
                    "\n" +
                      Array.from({ length: 26000 }, (_, i) => `const value${i}=${i};`).join("\n"),
                  );
                  element.dispatchEvent(
                    new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
                  );
                });
                await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
              }
              await page.keyboard.insertText("\n// ");
              await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");

              const initial = await page.evaluate(() => {
                const host = window;
                return host.session
                  .getSnapshot()
                  .files[host.session.getSnapshot().active].toString();
              });

              if (name === "concurrent")
                await page.evaluate(async () => {
                  const host = window;
                  host.background = [];
                  for (const id of ["dom", "compute"]) {
                    const session = new host.ProjectSession(id, host.platform.services);
                    await session.start();
                    const path = session.getSnapshot().active;
                    const source = session.getSnapshot().files[path].toString();
                    host.background.push({ session, path, source });
                  }
                  let serial = 0;
                  host.backgroundTimer = setInterval(() => {
                    for (const item of host.background)
                      item.session.change(item.path, item.source + `\n// revision ${++serial}`);
                  }, 90);
                });
              if (name === "resumed") {
                console.log(engine, variant, round, "waiting for idle retirement");
                await page.waitForFunction(
                  () =>
                    window.ownedWorkers.filter((w) => w.name === "reploom-compiler").length > 0 &&
                    window.ownedWorkers
                      .filter((w) => w.name === "reploom-compiler")
                      .every((w) => w.retired),
                  undefined,
                  { timeout: 40000 },
                );
                const other = await context.newPage();
                await other.goto("about:blank");
                await other.bringToFront();
                await page.bringToFront();
                await other.close();
                await editor.focus();
              }
              await editor.focus();
              await page.evaluate(() => {
                const host = window;
                host.interaction = {
                  samples: [],
                  eventTiming: [],
                  visibility: document.visibilityState,
                };
                document.addEventListener(
                  "keydown",
                  (event) => {
                    if (event.key !== "x" && event.key !== "Backspace") return;
                    const start = performance.now();
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() =>
                        host.interaction.samples.push({
                          ms: performance.now() - start,
                          trusted: event.isTrusted,
                          key: event.key,
                          visibility: document.visibilityState,
                        }),
                      ),
                    );
                  },
                  true,
                );
                if (PerformanceObserver.supportedEntryTypes?.includes("event")) {
                  host.observer = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries())
                      host.interaction.eventTiming.push({
                        name: entry.name,
                        duration: entry.duration,
                        inputDelay: entry.processingStart - entry.startTime,
                      });
                  });
                  host.observer.observe({ type: "event", durationThreshold: 16 });
                }
              });
              for (let i = 0; i < count; i++) {
                await page.keyboard.press(i % 2 ? "Backspace" : "x");
                await page.waitForFunction((n) => window.interaction.samples.length > n, i);
              }
              await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
              await expect(button).toHaveText("count 1");

              const result = await page.evaluate(() => {
                const host = window;
                host.observer?.disconnect();
                clearInterval(host.backgroundTimer);
                for (const item of host.background ?? []) item.session.dispose();
                return {
                  ...host.interaction,
                  source: host.session
                    .getSnapshot()
                    .files[host.session.getSnapshot().active].toString(),
                  workers: host.ownedWorkers.map((w) => ({ name: w.name, retired: w.retired })),
                };
              });

              assert.equal(result.source, initial);
              assert.equal(result.samples.length, count);
              assert.ok(result.samples.every((s) => s.trusted));
              assert.deepEqual(external, []);
              delete result.source;
              results.push({ engine, version: browser.version(), variant, round, name, ...result });
              console.log(engine, variant, round, name, {
                p50: percentile(
                  result.samples.map((s) => s.ms),
                  0.5,
                ),
                p95: percentile(
                  result.samples.map((s) => s.ms),
                  0.95,
                ),
                p99: percentile(
                  result.samples.map((s) => s.ms),
                  0.99,
                ),
              });
            } finally {
              await context.close();
            }
          }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        cpu: cpus()[0].model,
        rounds,
        count,
        scope:
          "Trusted browser key events to two animation-frame callbacks, not a physical display timestamp. Optional Event Timing records entries above the browser threshold. Large setup dispatches a synthetic ClipboardEvent through the editor paste handler, not the OS clipboard or IME. Concurrent workload adds two compiling headless sessions. Resumed waits for actual compiler retirement, then switches tabs; recorded visibility states determine what the engine exposed. Every case checks exact source restoration, React state and same-origin requests. No force GC or heap snapshots.",
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
