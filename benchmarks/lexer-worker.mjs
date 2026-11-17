import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { chromium, firefox, webkit } from "@playwright/test";
import {
  scalarTransition,
  batchedTransition,
  inlineTransition,
  characterRun,
} from "./editor/lexer-transition.mjs";

const bundles = {};
const variants = process.env.REPLOOM_LEXER_VARIANTS?.split(",") ?? ["before", "inline", "after"];
for (const variant of variants) {
  const result = await build({
    entryPoints: ["packages/ui/src/codemirror/language/worker.ts"],
    bundle: true,
    write: false,
    format: "iife",
    minify: !process.env.REPLOOM_LEXER_UNMINIFIED,
    alias: { "@codemirror/state": resolve("packages/ui/vendor/codemirror-state/index.ts") },
    plugins: [
      {
        name: "worker-stages",
        setup(build) {
          build.onLoad({ filter: /language\/worker.ts$/ }, async ({ path }) => {
            const source = await readFile(path, "utf8");
            assert.ok(source.includes("const parse ="));
            return {
              loader: "ts",
              contents: source
                .replace("const parse =", "const start=performance.now(); const parse =")
                .replace(
                  "const { reply, transfer } =",
                  "const parsed=performance.now(); const { reply, transfer } =",
                )
                .replace(
                  "host.postMessage(reply, transfer)",
                  "host.postMessage({...reply,parseMs:parsed-start,encodeMs:performance.now()-parsed},transfer)",
                ),
            };
          });
          build.onLoad({ filter: /@lezer\/lr\/dist\/index.js$/ }, async ({ path }) => {
            const contents = await readFile(path, "utf8");
            assert.ok(contents.includes(batchedTransition));

            const transformed =
              variant === "after"
                ? contents
                : contents
                    .replace(
                      batchedTransition,
                      variant === "before" ? scalarTransition : inlineTransition,
                    )
                    .replace(characterRun, "");

            return { loader: "js", contents: transformed };
          });
        },
      },
    ],
  });

  bundles[variant] = result.outputFiles[0].text;
}

const server = createServer((req, res) => {
  const variant = req.url.slice(1).split(".")[0];
  res.setHeader("content-type", bundles[variant] ? "text/javascript" : "text/html");
  res.end(bundles[variant] ?? "<!doctype html>");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const results = {};
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    if (process.env.REPLOOM_LEXER_ENGINE && engine !== process.env.REPLOOM_LEXER_ENGINE) continue;
    const browser = await launcher.launch();
    results[engine] = { version: browser.version(), samples: [] };
    try {
      for (let round = 0; round < 3; round++)
        for (const variant of round % 2 ? [...variants].reverse() : variants) {
          const page = await browser.newPage();
          await page.goto(`http://127.0.0.1:${server.address().port}`);

          const samples = await page.evaluate(async (variant) => {
            const worker = new Worker("/" + variant + ".js");
            const samples = [];
            const source = 'export const text = "12345' + "a".repeat(899950) + '";';
            try {
              for (let i = 0; i < 16; i++) {
                const start = performance.now();

                const result = await new Promise((resolve, reject) => {
                  const timeout = setTimeout(() => reject(Error("Timeout")), 20000);
                  worker.onmessage = ({ data }) => {
                    clearTimeout(timeout);
                    resolve(data);
                  };
                  worker.onerror = (e) => {
                    clearTimeout(timeout);
                    reject(Error(e.message));
                  };
                  worker.postMessage({
                    revision: i + 1,
                    base: i,
                    path: "/main.js",
                    kind: "jsx",
                    ...(i === 0
                      ? { source }
                      : {
                          edits: [
                            {
                              from: source.indexOf("12345") + 2,
                              to: source.indexOf("12345") + 3,
                              insert: i % 2 ? "6" : "3",
                            },
                          ],
                        }),
                  });
                });

                if (result.type !== "tree") throw Error(JSON.stringify(result));
                samples.push({
                  revision: i + 1,
                  wallMs: performance.now() - start,
                  parseMs: result.parseMs,
                  encodeMs: result.encodeMs,
                  records: result.records.length,
                });
              }
              return samples;
            } finally {
              worker.terminate();
            }
          }, variant);

          assert.equal(samples.length, 16);

          results[engine].samples.push({ variant, round, samples });
          console.log(engine, variant, round, JSON.stringify(samples.map((s) => s.parseMs)));
          await page.close();
        }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  const output = process.argv[2] ?? "artifacts/lexer-worker.json";
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify({ unminified: !!process.env.REPLOOM_LEXER_UNMINIFIED, results }, null, 2) + "\n",
  );
}
