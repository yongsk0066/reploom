import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "@playwright/test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import path from "node:path";

const execute = promisify(execFile);
const collect = process.env.REPLOOM_MEMORY_GC === "1";
const heap = process.env.REPLOOM_MEMORY_HEAP === "1";
const diagnose = process.env.REPLOOM_MEMORY_DIAGNOSE === "1";
const waitLimit = Number(process.env.REPLOOM_MEMORY_WAIT_MS ?? 10000);
const baseline = process.env.REPLOOM_MEMORY_BASELINE;
const variants = baseline ? ["baseline", "current"] : ["current"];
const rounds = Number(process.env.REPLOOM_MEMORY_ROUNDS ?? (collect ? 1 : 2));
const collectionFailures = [];
const builds = new Map();
const bundles = {};
for (const variant of variants) {
  const root = path.resolve(variant === "baseline" ? baseline : ".");
  const require = createRequire(path.join(root, "packages/ui/package.json"));

  const alias = Object.fromEntries(
    ["state", "view", "language", "commands"].map((name) => [
      "@codemirror/" + name,
      require.resolve("@codemirror/" + name).replace(/\.cjs$/, ".js"),
    ]),
  );

  const worker = await build({
    entryPoints: [path.join(root, "packages/ui/src/codemirror/language/worker.ts")],
    bundle: true,
    format: "iife",
    minify: true,
    write: false,
    alias: { "@codemirror/state": path.join(root, "packages/ui/vendor/codemirror-state/index.ts") },
  });

  const source = worker.outputFiles[0].text;
  bundles[variant] = {
    bytes: Buffer.byteLength(source),
    gzipBytes: gzipSync(source).length,
    sha256: createHash("sha256").update(source).digest("hex"),
  };

  const host = await build({
    entryPoints: ["benchmarks/editor/memory.ts"],
    bundle: true,
    format: "iife",
    minify: !heap,
    write: false,
    alias,
    plugins: [
      {
        name: "worker-version",
        setup(builder) {
          builder.onResolve({ filter: /packages\/ui\/src\/codemirror\/editor\.ts$/ }, () => ({
            path: path.join(root, "packages/ui/src/codemirror/editor.ts"),
          }));
          builder.onResolve({ filter: /^@yongsk0066\/reploom-ui\/language-worker$/ }, () => ({
            path: "source",
            namespace: "worker",
          }));
          builder.onLoad({ filter: /.*/, namespace: "worker" }, () => ({
            contents: `export const source=${JSON.stringify(source)}`,
            loader: "js",
          }));
        },
      },
    ],
  });

  builds.set("/" + variant + ".js", host.outputFiles[0].contents);
}

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

async function webkitSnapshot(page, variant, stage) {
  // The pinned Playwright server exposes WebKit's inspector session only internally.
  const session = page._connection.toImpl(page).delegate._session;
  const snapshot = await session.send("Heap.snapshot");
  const output = path.dirname(process.argv[2] ?? "artifacts/benchmarks/editor-memory.json");
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, `heap-${variant}-${stage}.json`), snapshot.snapshotData);
}

const server = createServer((req, res) => {
  if (builds.has(req.url)) {
    res.setHeader("content-type", "text/javascript");
    res.end(builds.get(req.url));
    return;
  }
  const variant = new URL(req.url, "http://localhost").searchParams.get("variant");
  res.setHeader("content-type", "text/html");
  res.end(
    `<!doctype html><style>#editor{width:760px;height:360px}.cm-editor{height:100%}.cm-scroller{overflow:auto}</style><div id="editor"></div><script src="/${variant}.js"></script>`,
  );
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const results = {};
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    if (
      process.env.REPLOOM_MEMORY_ENGINES &&
      !process.env.REPLOOM_MEMORY_ENGINES.split(",").includes(engine)
    )
      continue;
    const trials = (results[engine] = []);
    for (let round = 0; round < rounds; round++)
      for (const variant of round % 2 ? [...variants].reverse() : variants) {
        const before = new Set((await processes()).map((row) => row.pid));

        const webkitRoot =
          engine === "webkit" ? path.dirname(launcher.executablePath()) + path.sep : undefined;

        const owner = heap || diagnose ? undefined : await launcher.launchServer();

        const browser = owner
          ? await launcher.connect(owner.wsEndpoint())
          : await launcher.launch();

        const measure = () => footprint(owner?.process().pid ?? -1, before, webkitRoot);
        try {
          const page = await browser.newPage();
          const errors = [];
          page.on("pageerror", (e) => errors.push(e.message));
          await page.goto(
            `http://127.0.0.1:${server.address().port}/?variant=${variant}${collect ? "&gc" : ""}`,
          );
          const samples = [{ stage: "loaded", ...(await measure()) }];
          const mounted = await page.evaluate(() => globalThis.memoryCase.mount());
          samples.push({ stage: "mounted", ...(await measure()) });
          const batches = [];
          for (let n = 0; n < (heap ? 0 : 4); n++) {
            batches.push(await page.evaluate(() => globalThis.memoryCase.batch()));
            samples.push({ stage: "edit-" + (n + 1) * 100, ...(await measure()) });
          }
          const idle = await page.evaluate(() => globalThis.memoryCase.idle());
          samples.push({ stage: "retired", ...(await measure()) });
          const resumed = await page.evaluate(() => globalThis.memoryCase.batch());
          assert.equal(resumed.created, 2);
          const destroyed = await page.evaluate(() => globalThis.memoryCase.destroy());
          assert.deepEqual(destroyed, { created: 2, retired: 2, views: 0 });
          await page.waitForTimeout(200);
          samples.push({ stage: "destroyed", ...(await measure()) });
          let references;
          const collections = [];
          if (collect) {
            for (let n = 0; n < 3; n++) {
              await page.requestGC();
              await page.waitForTimeout(50);
            }
            references = await page.evaluate(() => globalThis.memoryCase.retained());
            collections.push({ waitedMs: 0, references });
            console.log(engine, variant, "weak-references", JSON.stringify(references));
            if ((heap || diagnose) && engine === "webkit")
              await webkitSnapshot(page, variant, "retained");
            for (
              let waitedMs = 1000;
              references.some((entry) => entry.alive) && waitedMs <= waitLimit;
              waitedMs += 1000
            ) {
              await page.waitForTimeout(1000);
              await page.requestGC();
              references = await page.evaluate(() => globalThis.memoryCase.retained());
              collections.push({ waitedMs, references });
            }
            console.log(engine, variant, "final-collection", JSON.stringify(collections.at(-1)));
            if (references.some((entry) => entry.alive))
              collectionFailures.push({ engine, variant, round, references });
            samples.push({ stage: "collected", ...(await measure()) });
          }
          if ((heap || diagnose) && engine === "webkit") {
            await webkitSnapshot(page, variant, "released");
          }
          assert.deepEqual(errors, []);
          trials.push({
            round,
            variant,
            version: browser.version(),
            mounted,
            batches,
            idle,
            resumed,
            destroyed,
            references,
            collections,
            samples,
          });
          console.log(
            engine,
            round,
            variant,
            JSON.stringify(samples.map((s) => [s.stage, Math.round(s.bytes / 1048576)])),
          );
        } finally {
          await browser.close();
          await owner?.close();
        }
      }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));

  const output =
    process.argv[2] ??
    `artifacts/benchmarks/editor-memory${heap ? "-heap" : collect ? "-gc" : ""}.json`;

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        diagnose,
        rounds,
        collectionFailures,
        waitLimit,
        bundles,
        collect,
        heap,
        collectionScope: collect
          ? "Separate ownership diagnostic: one process per variant/engine/round, weak references only, three initial page.requestGC calls after disposal, then one-second waits with GC up to waitLimit until tracked objects disappear. Collections are recorded separately. Natural RSS/performance observations require a separate run with collect disabled."
          : undefined,
        scope:
          "macOS RSS sum of owned browser processes, including newly launched WebKit XPC processes. Each configured round launches a fresh process for every engine and variant. Isolated editor with ordinary undo, 400 incremental edits with syntax settling, 1.5s configured idle retirement, 100 edits after reseed, disposal. No compiler WASM, preview or per-edit protocol round trips. Natural RSS mode has no GC requests or heap snapshots. collect enables weak-reference/GC diagnostics; heap uses a separate 100-edit unminified-host inspector experiment. Uses one identical input harness with each selected editor, parser and tree transport. Optional baseline is a separate source checkout. Inlined Worker source excludes network startup. RSS is allocator/process retention, not JS object liveness.",
        results,
      },
      null,
      2,
    ) + "\n",
  );
}

assert.deepEqual(
  collectionFailures,
  [],
  "Disposed editor roots remained reachable; see recorded collection outcomes",
);
