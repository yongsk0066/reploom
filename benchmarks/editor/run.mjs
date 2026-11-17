import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "@playwright/test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { dirname, resolve } from "node:path";

const uiRequire = createRequire(new URL("../../packages/ui/package.json", import.meta.url));

const alias = Object.fromEntries(
  ["state", "view", "language", "commands"].map((name) => [
    `@codemirror/${name}`,
    uiRequire.resolve(`@codemirror/${name}`).replace(/\.cjs$/, ".js"),
  ]),
);

const baseline = process.env.REPLOOM_EDITOR_BASELINE;

const variants =
  process.env.REPLOOM_EDITOR_VARIANTS?.split(",") ??
  (baseline ? ["baseline", "production"] : ["production", "production-worker"]);

for (const variant of variants)
  assert.ok(
    ["production", "production-worker", ...(baseline ? ["baseline"] : [])].includes(variant),
    "Unknown editor mode",
  );

const builds = new Map();
const receipts = {};
for (const variant of variants) {
  const output = await build({
    entryPoints: ["benchmarks/editor/cases.ts"],
    bundle: true,
    write: false,
    format: "iife",
    alias,
    plugins:
      variant === "baseline"
        ? [
            {
              name: "baseline-editor",
              setup(build) {
                build.onResolve({ filter: /packages\/ui\/src\/codemirror\/editor\.ts$/ }, () => ({
                  path: resolve(baseline, "packages/ui/src/codemirror/editor.ts"),
                }));
              },
            },
          ]
        : [],
  });

  const bytes = output.outputFiles[0].contents;
  builds.set(`/${variant}.js`, bytes);
  receipts[variant] = createHash("sha256").update(bytes).digest("hex");
}

const ordinary =
  "export const value = 12345;\n" + (await readFile("examples/effect-events/App.tsx", "utf8"));

const lines = (size) => {
  const rows = [];
  let length = 0;
  for (let n = 0; length < size; n++) {
    const line = `const value_${n} = 12345;\n`;
    rows.push(line);
    length += line.length;
  }
  return rows.join("");
};

const cases = [
  { name: "ordinary-tsx", path: "/App.tsx", source: ordinary },
  { name: "lines-250k", path: "/main.js", source: lines(250000) },
  { name: "lines-900k", path: "/main.js", source: lines(900000) },
  {
    name: "string-900k",
    path: "/main.js",
    source: 'export const text = "12345' + "a".repeat(899950) + '";',
  },
  {
    name: "array-840k",
    path: "/main.js",
    source: "export const list = [" + "12345,".repeat(140000) + "0];",
  },
  { name: "json-500k", path: "/data.json", source: "[\n" + " 12345,\n".repeat(62000) + " 0\n]" },
  {
    name: "css-300k",
    path: "/style.css",
    source: ".a { z-index: 12345; color: red; }\n".repeat(9000),
  },
];

if (process.env.REPLOOM_EDITOR_CONFORMANCE) {
  cases.splice(
    0,
    cases.length,
    {
      name: "nested-tsx",
      path: "/App.tsx",
      source:
        "const value = 12345;\n" +
        Array.from(
          { length: 100 },
          (_, i) => `const x${i} = <div a={{n:${i}}}>{[1,2,3].map(x => <b>{x}</b>)}</div>;`,
        ).join("\n"),
    },
    {
      name: "incomplete-tsx",
      path: "/App.tsx",
      source:
        "const value = 12345;\n" +
        'function f({x}) { return <div>{x?.map((n)=>[n,{a:"😀"}])}\n'.repeat(50),
    },
    {
      name: "nested-json",
      path: "/data.json",
      source: JSON.stringify({
        value: 12345,
        entries: Array.from({ length: 1000 }, (_, i) => ({
          i,
          values: [true, null, { text: "한글😀" }],
          empty: [],
        })),
      }),
    },
    {
      name: "broken-json",
      path: "/data.json",
      source: "[12345," + '[{},[null,true,1],"😀",],'.repeat(300),
    },
    {
      name: "nested-css",
      path: "/style.css",
      source:
        ".a {z-index:12345}\n" +
        '@media (width > 10px) { .a:is(.b,.c) { color: var(--a, red); content: "😀"; } }\n'.repeat(
          300,
        ),
    },
    {
      name: "repeated-edits",
      path: "/main.ts",
      source:
        "const value = 12345;\n" +
        Array.from(
          { length: 800 },
          (_, i) => `const v${i} = [\`item ${i}\`, /ab[c]*/g, {n:${i}}];`,
        ).join("\n"),
    },
  );
}

const server = createServer((request, response) => {
  if (builds.has(request.url)) {
    response.setHeader("content-type", "text/javascript");
    response.end(builds.get(request.url));
  } else {
    const variant =
      new URL(request.url, "http://localhost").searchParams.get("variant") ?? "production";

    response.setHeader("content-type", "text/html");
    response.end(
      `<!doctype html><style>#editor{width:760px;height:360px}.cm-editor{height:100%}.cm-scroller{overflow:auto}body{margin:10px}</style><div id="editor"></div><script>globalThis.forceLanguageWorker=${variant === "production-worker"}</script><script src="/${variant}.js"></script>`,
    );
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const results = {};
const selected = process.argv[2];
const output = process.argv[3] ?? "artifacts/benchmarks/editor/editor.json";
await mkdir(dirname(output), { recursive: true });
try {
  if (selected)
    assert.ok(
      selected.split(",").every((name) => cases.some((test) => test.name === name)),
      "Unknown editor workload",
    );
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await launcher.launch();
    results[engine] = { version: browser.version(), cases: [] };
    try {
      const trials = Array.from(
        { length: Number(process.env.REPLOOM_EDITOR_ROUNDS ?? 1) },
        (_, round) => cases.map((test, index) => ({ ...test, index, round })),
      ).flat();

      for (const test of trials) {
        const index = test.index + test.round;
        if (selected && !selected.split(",").includes(test.name)) continue;
        for (const variant of index % 2 ? [...variants].reverse() : variants) {
          const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
          const page = await context.newPage();
          page.on("pageerror", (error) => console.error(engine, variant, error.message));
          try {
            await page.goto(`http://127.0.0.1:${server.address().port}/?variant=${variant}`);
            let profiler;
            if (process.env.REPLOOM_EDITOR_PROFILE && engine === "chromium") {
              profiler = await context.newCDPSession(page);
              await profiler.send("Profiler.enable");
              await profiler.send("Profiler.setSamplingInterval", { interval: 100 });
              await profiler.send("Profiler.start");
            }
            const result = await page.evaluate((test) => globalThis.runEditor(test), test);
            if (profiler) {
              const profile = await profiler.send("Profiler.stop");
              await writeFile(
                `${dirname(output)}/cpu-${test.name}-${variant}.json`,
                JSON.stringify(profile),
              );
              await profiler.detach();
            }
            results[engine].cases.push({ name: test.name, round: test.round, variant, ...result });
            assert.equal(result.externalLifecycle.created, 0);
            assert.equal(result.externalLifecycle.destroyed, 0);
            assert.equal(
              result.externalLifecycle.selection,
              Math.max(0, test.source.indexOf("12345")) + 1,
            );
            const comparable = results[engine].cases.filter((item) => item.name === test.name);
            for (const previous of comparable) {
              assert.deepEqual(result.syntax, previous.syntax);
              assert.deepEqual(result.navigation, previous.navigation);
            }
            const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
            console.log(
              engine,
              test.name,
              variant,
              JSON.stringify({
                mount: result.mount.syncMs,
                viewportSyntax: result.mount.toViewportSyntaxMs,
                fullSyntax: result.mount.toSyntaxMs,
                native: median(result.native.map((x) => x.syncMs)),
                external: median(result.external.map((x) => x.syncMs)),
                paste: median(result.paste.map((x) => x.syncMs)),
              }),
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
  await mkdir("artifacts/benchmarks/editor", { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        cpu: cpus()[0].model,
        naturalSyntax: true,
        scope:
          "Fresh browser context per workload and mode. In-page timers isolate synchronous editor work, two-rAF settling and syntax availability without forced parsing. Production uses the configured size threshold; production-worker routes every nonempty document through the language Worker. Document text, syntax, navigation, bracket matching, selection and lifecycle are checked after reversible edits. Native input is a dispatch workload and paste is a synthetic ClipboardEvent. Inlined Worker source excludes network startup.",
        receipts,
        baseline: baseline ? true : undefined,
        inputs: cases.map(({ name, path, source }) => ({
          name,
          path,
          characters: source.length,
          sha256: createHash("sha256").update(source).digest("hex"),
        })),
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
