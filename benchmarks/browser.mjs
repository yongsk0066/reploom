import { build } from "esbuild";
import { chromium, firefox, webkit } from "@playwright/test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { cpus } from "node:os";

const uiRequire = createRequire(new URL("../packages/ui/package.json", import.meta.url));

const output = await build({
  entryPoints: {
    bench: new URL("./browser-cases.ts", import.meta.url).pathname,
    "compiler-bench": new URL("./compiler-worker.mjs", import.meta.url).pathname,
  },
  outdir: "artifacts/benchmarks/scripts",
  bundle: true,
  write: false,
  format: "iife",
  alias: { "@codemirror/state": uiRequire.resolve("@codemirror/state") },
});

const scripts = new Map(
  output.outputFiles.map((file) => ["/" + file.path.split("/").at(-1), file.contents]),
);

const wasm = await readFile(new URL("../crates/compiler/artifacts/compiler.wasm", import.meta.url));

const baseline = process.env.REPLOOM_BASELINE_WASM
  ? await readFile(process.env.REPLOOM_BASELINE_WASM)
  : undefined;

const server = createServer((request, response) => {
  if (scripts.has(request.url)) {
    response.setHeader("content-type", "text/javascript");
    response.end(scripts.get(request.url));
  } else if (request.url === "/compiler.wasm") {
    response.setHeader("content-type", "application/wasm");
    response.end(wasm);
  } else if (request.url === "/compiler-before.wasm" && baseline) {
    response.setHeader("content-type", "application/wasm");
    response.end(baseline);
  } else response.end('<!doctype html><script src="/bench.js"></script>');
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const results = {};
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      page.on("pageerror", (error) => console.error(error));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      results[name] = {
        version: browser.version(),
        cases: await page.evaluate((compare) => globalThis.runBenchmarks(compare), !!baseline),
      };
      console.log(
        `${name} ${browser.version()}: ${Object.keys(results[name].cases).length} benchmark groups completed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
await mkdir(new URL("../artifacts/benchmarks/", import.meta.url), { recursive: true });
await writeFile(
  new URL(`../artifacts/benchmarks/${process.argv[2] || "browser"}.json`, import.meta.url),
  JSON.stringify({ date: new Date().toISOString(), cpu: cpus()[0].model, results }, null, 2) + "\n",
);
