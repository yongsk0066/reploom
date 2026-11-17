import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { cpus } from "node:os";
import { chromium, firefox, webkit, expect } from "@playwright/test";

const site = resolve(process.env.REPLOOM_DELAY_SITE ?? "artifacts/browser-site");
const manifest = JSON.parse(await readFile(resolve(site, "features/assets/manifest.json"), "utf8"));
let delay = 120;

const policies = process.env.REPLOOM_DELAY_POLICIES?.split(",").map((value) =>
  value === "adaptive" ? value : Number(value),
) ?? [120, 40, 16, 0, "adaptive"];

const mime = {
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".html": "text/html",
  ".css": "text/css",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/features/assets/manifest.json") {
      const copy = structuredClone(manifest);
      for (const project of Object.values(copy.projects)) {
        if (delay === "adaptive") delete project.updateDelayMs;
        else project.updateDelayMs = delay;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(copy));
      return;
    }

    const path = resolve(
      site,
      "." + decodeURIComponent(url.pathname) + (url.pathname.endsWith("/") ? "index.html" : ""),
    );

    if (!path.startsWith(site + sep)) throw Error("Invalid path");
    response.setHeader("content-type", mime[extname(path)] ?? "application/octet-stream");
    response.end(await readFile(path));
  } catch {
    response.statusCode = 404;
    response.end();
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = {};
const passive = !!process.env.REPLOOM_DELAY_PASSIVE;
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await launcher.launch();
    results[engine] = { version: browser.version(), trials: [] };
    try {
      for (const project of ["react", "dom"])
        for (let round = 0; round < 3; round++) {
          for (const updateDelay of round % 2 ? [...policies].reverse() : policies) {
            delay = updateDelay;
            const context = await browser.newContext();
            const page = await context.newPage();
            const external = [];
            const requests = [];

            const observe = (request) => {
              const url = new URL(request.url());
              requests.push(url.pathname);
              if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) return true;
              external.push(url.href);
              return false;
            };

            if (passive) page.on("request", observe);
            else
              await page.route("**/*", (route) =>
                observe(route.request()) ? route.continue() : route.abort(),
              );
            try {
              await page.goto(`${origin}/features/?project=${project}`);
              await page.waitForFunction(() => document.body.dataset.phase === "ready");
              assert.equal(requests.filter((url) => /\.wasm$|compiler-worker/.test(url)).length, 0);
              const button = page.frameLocator("iframe").getByRole("button");
              await button.click();

              const data = await page.evaluate(async (project) => {
                const session = window.session;
                const path = project === "react" ? "/Counter.tsx" : "/main.ts";
                const original = session.getSnapshot().files[path].toString();
                let serial = 0;
                const originalPost = Worker.prototype.postMessage;
                const commands = [];
                Worker.prototype.postMessage = function (message, ...rest) {
                  if (["compile", "cancel"].includes(message?.type))
                    commands.push({ type: message.type, time: performance.now() });
                  return originalPost.call(this, message, ...rest);
                };

                async function edit(count, gap) {
                  let target = -1;
                  let issued = 0;
                  const ready = [];
                  const phases = [];
                  const start = performance.now();
                  let last = start;
                  const before = commands.length;

                  const completed = new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                      unsubscribe();
                      reject(Error("Timed out"));
                    }, 30000);

                    const unsubscribe = session.subscribe(() => {
                      const view = session.getSnapshot();
                      if (phases.at(-1)?.phase !== view.state.phase)
                        phases.push({ phase: view.state.phase, ms: performance.now() - start });
                      if (view.state.phase === "error") {
                        clearTimeout(timer);
                        unsubscribe();
                        reject(Error(JSON.stringify(view.state)));
                      }
                      if (view.state.phase !== "ready") return;
                      ready.push({ revision: view.revision, ms: performance.now() - start });
                      if (issued === count && view.revision === target) {
                        clearTimeout(timer);
                        unsubscribe();
                        resolve({
                          totalMs: performance.now() - start,
                          afterLastMs: performance.now() - last,
                          ready,
                          phases,
                          commands: commands
                            .slice(before)
                            .map((command) => ({ ...command, time: command.time - start })),
                        });
                      }
                    });
                  });

                  for (let i = 0; i < count; i++) {
                    if (i) await new Promise((resolve) => setTimeout(resolve, gap));
                    issued++;
                    last = performance.now();
                    session.change(path, original + `\nconst delayMarker = ${++serial};`);
                    target = session.getSnapshot().revision;
                  }
                  return completed;
                }

                try {
                  const cold = await edit(1, 0);
                  const warm = await edit(1, 0);
                  const burst = await edit(6, 30);
                  return { cold, warm, burst };
                } finally {
                  Worker.prototype.postMessage = originalPost;
                }
              }, project);

              await expect(button).toHaveText("count 1");
              await button.click();
              await expect(button).toHaveText("count 2");
              assert.deepEqual(external, []);
              results[engine].trials.push({ project, round, delay, ...data });
              console.log(
                engine,
                project,
                round,
                delay,
                Math.round(data.warm.afterLastMs),
                data.burst.commands.filter((c) => c.type === "compile").length,
              );
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
  await writeFile(
    process.argv[2] ?? `artifacts/benchmarks/update-delay${passive ? "-passive" : ""}.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        site,
        cpu: cpus()[0].model,
        networkMode: passive
          ? "passive request observation, no route interception"
          : "route interception with external requests blocked",
        scope:
          "Three alternating rounds, fresh context per project/policy in a shared browser process; current compiled fixture site. Programmatic source change through real session/compiler/preview ack. First activation then warm one-edit, then six edits 30ms apart. Compiler commands and acknowledged revisions recorded. Counter state retained, initial compiler requests absent, zero external requests. Browser process caches may survive between contexts. Numeric policies set a fixed manifest delay; adaptive removes the override and runs the shipped admission policy.",
        manifest,
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
