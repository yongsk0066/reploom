import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, dirname, sep } from "node:path";
import { cpus } from "node:os";
import { chromium, firefox, webkit, expect } from "@playwright/test";

const baselinePath = process.argv[2];
if (!baselinePath)
  throw Error("Usage: node benchmarks/compiler-startup.mjs <baseline.wasm> [output.json]");
const outputPath = process.argv[3] ?? "artifacts/benchmarks/compiler-startup.json";
const site = resolve("artifacts/browser-site");
const original = JSON.parse(await readFile(resolve(site, "features/assets/manifest.json"), "utf8"));
const loader = await readFile(resolve(site, "." + original.compiler.url), "utf8");
const workerSource = await readFile(resolve(site, "." + original.compilerWorker.url), "utf8");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifacts = {};

for (const [variant, path] of Object.entries({
  before: baselinePath,
  after: "crates/compiler/artifacts/compiler.wasm",
})) {
  const wasm = await readFile(path);
  const sha256 = hash(wasm);
  const url = `/features/assets/oxc.${sha256.slice(0, 16)}.wasm`;
  const engine = loader.replaceAll(original.wasm.url, url).replaceAll(original.wasm.sha256, sha256);
  const engineHash = hash(engine);
  const engineUrl = `/features/assets/oxc-loader.${engineHash.slice(0, 16)}.mjs`;

  const worker = workerSource
    .replaceAll(original.wasm.url, url)
    .replaceAll(original.wasm.sha256, sha256)
    .replaceAll(original.compiler.sha256, engineHash);

  const workerHash = hash(worker);
  const workerUrl = `/features/assets/compiler-worker.${workerHash.slice(0, 16)}.js`;

  const manifest = {
    ...original,
    wasm: { url, sha256 },
    compiler: { url: engineUrl, sha256: engineHash },
    compilerWorker: { url: workerUrl, sha256: workerHash },
  };

  artifacts[variant] = {
    identity: { path, sha256, bytes: wasm.length },
    responses: new Map([
      ["/features/assets/manifest.json", [JSON.stringify(manifest), "application/json"]],
      [url, [wasm, "application/wasm"]],
      [engineUrl, [engine, "text/javascript"]],
      [workerUrl, [worker, "text/javascript"]],
    ]),
  };
}

let active;

const mime = {
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".html": "text/html",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const resource = active.responses.get(url.pathname);
    if (resource) {
      response.setHeader("content-type", resource[1]);
      response.setHeader("cache-control", "no-store");
      response.end(resource[0]);
      return;
    }

    const path = resolve(
      site,
      "." + decodeURIComponent(url.pathname) + (url.pathname.endsWith("/") ? "index.html" : ""),
    );

    if (!path.startsWith(site + sep)) throw Error("Invalid path");
    const bytes = await readFile(path);
    response.setHeader("content-type", mime[extname(path)] ?? "application/octet-stream");
    response.setHeader("cache-control", "no-store");
    response.end(bytes);
  } catch {
    response.statusCode = 404;
    response.end();
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = {};

try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const samples = [];
    results[engine] = { samples };
    for (const project of ["react", "dom"]) {
      for (let round = 0; round < 5; round++) {
        for (const variant of round % 2 ? ["after", "before"] : ["before", "after"]) {
          active = artifacts[variant];
          const browser = await launcher.launch();
          try {
            results[engine].version = browser.version();
            const page = await browser.newPage();
            const requests = [];
            const external = [];
            await page.route("**/*", (route) => {
              const url = new URL(route.request().url());
              requests.push(url.pathname);
              if (url.origin === origin || ["blob:", "data:"].includes(url.protocol))
                return route.continue();
              external.push(url.href);
              return route.abort();
            });
            await page.goto(`${origin}/features/?project=${project}`);
            await page.waitForFunction(() => document.body.dataset.phase === "ready");
            const beforeRequests = requests.filter((url) => /\.wasm$|compiler-worker/.test(url));
            assert.deepEqual(beforeRequests, []);
            const button = page.frameLocator("iframe").getByRole("button");
            await button.click();

            const observation = await page.evaluate(async (project) => {
              const session = window.session;
              const file = project === "react" ? "/Counter.tsx" : "/main.ts";
              const snapshot = session.getSnapshot();
              const started = performance.now();
              return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                  unsubscribe();
                  reject(Error("Edit timed out"));
                }, 30000);

                const unsubscribe = session.subscribe(() => {
                  const current = session.getSnapshot();
                  if (current.revision <= snapshot.revision) return;
                  if (current.state.phase !== "ready" && current.state.phase !== "error") return;
                  clearTimeout(timer);
                  unsubscribe();
                  if (current.state.phase === "error") {
                    reject(Error(JSON.stringify(current.state)));
                    return;
                  }
                  resolve({
                    firstEditMs: performance.now() - started,
                    outcome: current.state.outcome,
                    compilerWorkers: window.compilerWorkers().length,
                  });
                });

                session.change(
                  file,
                  snapshot.files[file].toString() + "\nconst firstEditMarker = 1;",
                );
              });
            }, project);

            await expect(button).toHaveText("count 1");
            await button.click();
            await expect(button).toHaveText("count 2");
            assert.deepEqual(external, []);
            samples.push({ project, round, variant, ...observation });
            console.log(engine, project, round, variant, observation.firstEditMs);
          } finally {
            await browser.close();
          }
        }
      }
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        cpu: cpus()[0].model,
        scope:
          "Five alternating pairs per project and engine, fresh browser process each trial. Same current host/UI/runtime and integrity-checked loader; only WASM compiler bytes vary. In-page timer measures a programmatic first edit through preview acknowledgement, including debounce, compiler download/integrity, Worker/WASM startup and rendering. Initial viewing requests no compiler; counter state and blocked external requests are asserted. This is not compiler-only time or keyboard latency.",
        before: artifacts.before.identity,
        after: artifacts.after.identity,
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
