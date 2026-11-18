import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { resolve, join, extname, sep } from "node:path";
import { chromium, firefox, webkit } from "@playwright/test";

async function snapshot(directory) {
  await mkdir(directory, { recursive: true });
  await cp("apps/demo/dist", join(directory, "site"), { recursive: true });
  await build({
    entryPoints: ["packages/runtime/src/browser/platform.ts"],
    outfile: join(directory, "platform.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
  });
}

if (process.argv[2] === "--snapshot") {
  if (!process.argv[3]) throw Error("Specify a snapshot directory");
  await snapshot(resolve(process.argv[3]));
  process.exit(0);
}

const output = resolve("artifacts/benchmarks/loading");
const current = join(output, "current");
await snapshot(current);
const variants = { ...(process.argv[2] ? { before: resolve(process.argv[2]) } : {}), current };

const probe = `import {createBrowserPlatform} from '/__probe/platform.js';
let platform, projects;
globalThis.probe = {
  async load(count) {
    platform=createBrowserPlatform({manifestUrl:location.origin+'/__probe/manifest.json'});
    const start=performance.now();
    projects=await Promise.all(Array.from({length:count},()=>platform.services.loadProject('large')));
    return {milliseconds:performance.now()-start, consumers:projects.length,
      sourceObjects:new Set(projects.map(p=>p.files)).size,
      programObjects:new Set(projects.map(p=>p.output)).size,
      scripts:projects[0].vendor.map(p=>({kind:typeof p==='string'?'string':'Blob',size:typeof p==='string'?p.length:p.size}))};
  },
  release() {projects=undefined;platform.dispose();platform=undefined;}
};`;

async function serve(directory) {
  const root = join(directory, "site");
  const prepared = JSON.parse(await readFile(join(root, "reploom/manifest.json"), "utf8"));
  const firstProject = Object.values(prepared.projects)[0];
  const sampleProgram = JSON.parse(await readFile(join(root, firstProject.program.url), "utf8"));
  const bodies = new Map();

  function asset(name, source) {
    const data = Buffer.from(source);
    bodies.set(`/__probe/${name}`, data);
    return { url: `/__probe/${name}`, sha256: createHash("sha256").update(data).digest("hex") };
  }

  const text = "한글abcdef".repeat(50_000);

  const sources = asset(
    "sources.json",
    JSON.stringify({ "/main.ts": `export const value=${JSON.stringify(text)};` }),
  );

  const program = asset(
    "program.json",
    JSON.stringify({
      schema: sampleProgram.schema,
      abi: sampleProgram.abi,
      compilerVersion: "asset-workload",
      projectKey: "large",
      entry: "/main.ts",
      runtime: "dom",
      styles: [],
      execution: { mode: "window", budgetMs: 32 },
      transformed: [],
      modules: {
        "/main.ts": {
          id: "/main.ts",
          kind: "js",
          code: `function(context){const value=${JSON.stringify(text)};context.export('value',()=>value)}`,
          imports: {},
          dependencies: [],
          dynamicDependencies: [],
        },
      },
    }),
  );

  const vendor = asset("vendor.js", `/*${"x".repeat(500_000)}*/`);
  const bootstrap = asset("bootstrap.js", "");
  bodies.set(
    "/__probe/manifest.json",
    Buffer.from(
      JSON.stringify({
        schema: prepared.schema,
        protocol: prepared.protocol,
        moduleABI: prepared.moduleABI,
        bootstrap,
        projects: { large: { sources, program, vendor: [vendor], assets: {} } },
      }),
    ),
  );
  bodies.set("/__probe/platform.js", await readFile(join(directory, "platform.js")));
  bodies.set("/__probe/probe.js", Buffer.from(probe));
  bodies.set(
    "/__probe/",
    Buffer.from('<!doctype html><script type="module" src="/__probe/probe.js"></script>'),
  );

  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".css": "text/css",
    ".wasm": "application/wasm",
  };

  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://local.invalid").pathname);
    try {
      const filename = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
      if (!filename.startsWith(root + sep)) throw Error("Invalid path");
      const body = bodies.get(pathname) ?? (await readFile(filename));
      res.setHeader(
        "content-type",
        pathname.endsWith("/")
          ? "text/html"
          : (types[extname(pathname)] ?? "application/octet-stream"),
      );
      res.setHeader("cache-control", "no-store");
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function gallery(browser, origin, project) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const requests = [];
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    globalThis.loading = {};

    const mark = (name) => {
      if (globalThis.loading[name] !== undefined) return;
      globalThis.loading[name + "Ready"] = performance.now();
      globalThis.loading[name] = null;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          globalThis.loading[name] = performance.now();
        }),
      );
    };

    const mutations = { subtree: true, childList: true, attributes: true };
    let surface = document;

    const observer = new MutationObserver(() => {
      const shadow = document.querySelector(".reploom-host")?.shadowRoot;
      if (shadow && shadow !== surface) {
        surface = shadow;
        observer.observe(surface, mutations);
      }

      if (surface.querySelector('[data-project][data-phase="ready"]')) mark("previewMs");
      if (surface.querySelector('[data-editor-ready="true"]')) mark("editorMs");
      if (globalThis.loading.previewMs !== undefined && globalThis.loading.editorMs !== undefined)
        observer.disconnect();
    });

    observer.observe(document, mutations);
  });
  try {
    await page.goto(`${origin}/#${project}`);
    await page.waitForFunction(
      () =>
        Number.isFinite(globalThis.loading.previewMs) &&
        Number.isFinite(globalThis.loading.editorMs),
    );
    assert.ok(requests.every((url) => url.startsWith(origin + "/")));
    assert.ok(requests.every((url) => !/compiler-worker|\.wasm(?:$|\?)/.test(url)));
    return await page.evaluate(() => ({
      ...globalThis.loading,
      bodyBytes: performance
        .getEntriesByType("resource")
        .reduce((n, e) => n + e.encodedBodySize, 0),
      requests: performance.getEntriesByType("resource").length,
    }));
  } finally {
    await context.close();
  }
}

async function assets(browser, origin, engine, count) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(origin + "/__probe/");
    await page.waitForFunction(() => !!globalThis.probe);
    const cdp = engine === "chromium" ? await context.newCDPSession(page) : undefined;

    const heap = async () => {
      if (!cdp) return;
      await cdp.send("HeapProfiler.collectGarbage");
      return (await cdp.send("Runtime.getHeapUsage")).usedSize;
    };

    const empty = await heap();
    const observation = await page.evaluate((count) => globalThis.probe.load(count), count);
    const retained = await heap();
    await page.evaluate(() => globalThis.probe.release());
    const released = await heap();
    return {
      ...observation,
      ...(cdp
        ? { retainedJSHeapBytes: retained - empty, releasedJSHeapBytes: released - empty }
        : {}),
    };
  } finally {
    await context.close();
  }
}

const servers = Object.fromEntries(
  await Promise.all(
    Object.entries(variants).map(async ([name, directory]) => [name, await serve(directory)]),
  ),
);

const samples = [];
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit }))
    for (let round = 0; round < 5; round++)
      for (const variant of round % 2 ? Object.keys(variants).reverse() : Object.keys(variants)) {
        const browser = await launcher.launch();
        try {
          const origin = servers[variant].url;

          const result = {
            engine,
            version: browser.version(),
            round,
            variant,
            react: await gallery(browser, origin, "react-counter"),
            dom: await gallery(browser, origin, "dom-todos"),
            singleAssets: await assets(browser, origin, engine, 1),
            assets: await assets(browser, origin, engine, 12),
          };

          if (variant === "current") {
            assert.equal(result.assets.sourceObjects, 1);
            assert.equal(result.assets.programObjects, 1);
            assert.ok(result.assets.scripts.every((script) => script.kind === "Blob"));
          }
          samples.push(result);
          console.log(engine, variant, round, JSON.stringify(result));
        } finally {
          await browser.close();
        }
      }
} finally {
  await Promise.all(Object.values(servers).map((server) => server.close()));
  await writeFile(
    join(output, "samples.json"),
    JSON.stringify(
      {
        scope:
          "Five alternating fresh-browser trials. Gallery timestamps include two animation frames after readiness and local uncompressed HTTP downloads; no edit. Separate asset workloads retain one or twelve loaded views of one 400k UTF-16 source/program plus a 500k script without executing them. Chromium heap is measured after explicit GC, excludes Blob backing storage and other native/browser memory, and is separate from load timing. Firefox/WebKit report shared object identity and load time, not heap bytes.",
        samples,
      },
      null,
      2,
    ) + "\n",
  );
}
