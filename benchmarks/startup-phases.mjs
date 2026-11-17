import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep, dirname } from "node:path";
import { chromium, firefox, webkit, expect } from "@playwright/test";

const site = resolve(process.argv[2] ?? "artifacts/browser-site");
const output = process.argv[3] ?? "artifacts/benchmarks/startup.json";
const probes = process.env.REPLOOM_STARTUP_PROBES !== "0";
const requestDelayMs = Number(process.env.REPLOOM_STARTUP_REQUEST_DELAY ?? 0);
const chromiumArgs = process.env.REPLOOM_STARTUP_CHROMIUM_ARGS?.split(" ") ?? [];
const tracing = process.env.REPLOOM_STARTUP_TRACE === "1";
const manifest = JSON.parse(await readFile(resolve(site, "features/assets/manifest.json"), "utf8"));
const originalWorker = await readFile(resolve(site, "." + manifest.compilerWorker.url), "utf8");

const probe = `
const note = (name, data = {}) => postMessage({ probe: name, at: performance.timeOrigin + performance.now(), ...data });
note('worker-entry');
const originalFetch = fetch;
globalThis.fetch = async (...args) => {
  const url = String(args[0]); note('fetch-start', { url });
  const response = await originalFetch(...args); note('fetch-headers', { url }); return response;
};
for (const name of ['compileStreaming', 'compile']) {
  const original = WebAssembly[name];
  if (original) WebAssembly[name] = async (...args) => {
    note(name + '-start'); const result = await original.apply(WebAssembly, args); note(name + '-end'); return result;
  };
}
WebAssembly.Instance = new Proxy(WebAssembly.Instance, { construct(target, args) {
  note('instance-start'); const value = Reflect.construct(target, args); note('instance-end'); return value;
} });
const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = async (...args) => {
  note('digest-start', { bytes: args[1].byteLength }); const result = await originalDigest(...args); note('digest-end'); return result;
};
addEventListener('message', ({data}) => { if (data?.type) note('command-' + data.type); });
`;

const worker = (probes ? probe : "") + originalWorker;
manifest.compilerWorker.sha256 = createHash("sha256").update(worker).digest("hex");
for (const project of Object.values(manifest.projects)) project.updateDelayMs = 0;

const mime = {
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".html": "text/html",
  ".css": "text/css",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (requestDelayMs) await new Promise((resolve) => setTimeout(resolve, requestDelayMs));
    if (url.pathname === "/features/assets/manifest.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(manifest));
      return;
    }
    if (url.pathname === manifest.compilerWorker.url) {
      res.setHeader("content-type", "text/javascript");
      res.end(worker);
      return;
    }

    const path = resolve(
      site,
      "." + decodeURIComponent(url.pathname) + (url.pathname.endsWith("/") ? "index.html" : ""),
    );

    if (!path.startsWith(site + sep)) throw Error("Invalid path");
    res.setHeader("content-type", mime[extname(path)] ?? "application/octet-stream");
    res.end(await readFile(path));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = {};
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    if (
      process.env.REPLOOM_STARTUP_ENGINES &&
      !process.env.REPLOOM_STARTUP_ENGINES.split(",").includes(engine)
    )
      continue;
    const samples = [];
    results[engine] = { samples };
    for (let round = 0; round < 3; round++) {
      const browser = await launcher.launch(engine === "chromium" ? { args: chromiumArgs } : {});
      results[engine].version = browser.version();
      try {
        const page = await browser.newPage();
        const external = [];
        page.on("request", (request) => {
          const u = new URL(request.url());
          if (u.origin !== origin && !["blob:", "data:"].includes(u.protocol))
            external.push(u.href);
        });
        await page.addInitScript(() => {
          const NativeWorker = Worker;
          window.startup = [];
          globalThis.Worker = class extends NativeWorker {
            constructor(url, options) {
              const started = performance.timeOrigin + performance.now();
              super(url, options);
              window.startup.push({ probe: "worker-created", at: started, name: options?.name });
              this.addEventListener("message", ({ data }) => {
                if (data?.probe) window.startup.push(data);
                else if (data?.ok)
                  window.startup.push({
                    probe: "compiled",
                    at: performance.timeOrigin + performance.now(),
                  });
              });
            }
          };
        });
        await page.goto(origin + "/features/?project=react");
        await page.waitForFunction(() => document.body.dataset.phase === "ready");
        assert.equal(await page.evaluate(() => window.startup.length), 0);
        const button = page.frameLocator("iframe").getByRole("button");
        await button.click();

        const trace =
          tracing && engine === "chromium" ? await page.context().newCDPSession(page) : undefined;

        if (trace)
          await trace.send("Tracing.start", {
            categories: "devtools.timeline,blink.user_timing,v8",
            transferMode: "ReturnAsStream",
          });

        const observation = await page.evaluate(async () => {
          const start = performance.timeOrigin + performance.now();
          performance.mark("reploom-edit-start");
          const session = window.session;
          const original = session.getSnapshot().files["/Counter.tsx"].toString();
          const phases = [];
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              unsubscribe();
              reject(Error("Compile timeout"));
            }, 30000);

            const unsubscribe = session.subscribe(() => {
              const view = session.getSnapshot();
              phases.push({
                phase: view.state.phase,
                at: performance.timeOrigin + performance.now(),
              });
              if (view.state.phase === "ready" || view.state.phase === "error") {
                clearTimeout(timer);
                unsubscribe();
                if (view.state.phase === "error") reject(Error(JSON.stringify(view.state)));
                else resolve();
              }
            });

            session.change("/Counter.tsx", original + "\nconst startupMarker=1;");
          });
          return {
            start,
            phases,
            worker: window.startup,
            resources: performance.getEntriesByType("resource").map((r) => ({
              name: r.name,
              start: performance.timeOrigin + r.startTime,
              end: performance.timeOrigin + r.responseEnd,
              bytes: r.transferSize,
            })),
          };
        });

        await expect(button).toHaveText("count 1");
        assert.deepEqual(external, []);
        if (trace) {
          const completed = new Promise((resolve) =>
            trace.once("Tracing.tracingComplete", resolve),
          );

          await trace.send("Tracing.end");
          const { stream } = await completed;
          let data = "";
          for (;;) {
            const chunk = await trace.send("IO.read", { handle: stream });
            data += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString() : chunk.data;
            if (chunk.eof) break;
          }
          await trace.send("IO.close", { handle: stream });
          await mkdir(dirname(output), { recursive: true });
          await writeFile(output.replace(/\.json$/, `-${round}.trace.json`), data);
        }
        samples.push(observation);
        console.log(
          engine,
          round,
          JSON.stringify(
            observation.worker.map((e) => ({
              phase: e.probe,
              ms: +(e.at - observation.start).toFixed(2),
              url: e.url,
              bytes: e.bytes,
            })),
          ),
        );
      } finally {
        await browser.close();
      }
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
        site,
        probes,
        tracing,
        requestDelayMs,
        chromiumArgs,
        manifest,
        scope:
          "Three fresh processes per engine. Fixed zero admission delay, passive network observation. Optional Worker fetch/digest/compile/Instance probes add messages and identify stages; use probes:false samples for end-to-end comparison. The host records Worker creation/replies. A nonzero requestDelayMs adds that delay before every server response, not a network bandwidth model. Same-origin resources and React state verified. Chromium flags are experimental attribution controls, never product settings.",
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
