import { build } from "esbuild";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, firefox, webkit } from "@playwright/test";

const require = createRequire(new URL("../packages/ui/package.json", import.meta.url));

const alias = Object.fromEntries(
  ["common", "javascript", "json"].map((name) => [
    "@lezer/" + name,
    require.resolve("@lezer/" + name).replace(".cjs", ".js"),
  ]),
);

const bundle = await build({
  entryPoints: ["benchmarks/editor/syntax-channel.ts"],
  bundle: true,
  format: "iife",
  write: false,
  alias,
});

const server = createServer((req, res) => {
  if (req.url === "/cases.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(bundle.outputFiles[0].contents);
  } else {
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><script src="/cases.js"></script>');
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const results = {};
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await launcher.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      results[engine] = {
        version: browser.version(),
        ...(await page.evaluate(() => globalThis.runSyntaxChannel())),
      };
      console.log(engine, JSON.stringify(results[engine].summary));
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  const output = process.argv[2] ?? "artifacts/benchmarks/syntax-channel.json";
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        scope:
          "Preparsed structurally shared tree pairs, 250 replacements per batch, seven batches. Encoding/structured clone with transfer/decoding separately timed in one Window. Excludes parsing, inter-thread scheduling, rendering and network. Checks semantic identity and exact retained node counts after replacement and reset.",
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
