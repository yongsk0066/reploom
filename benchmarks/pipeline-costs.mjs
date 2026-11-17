import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { cpus } from "node:os";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "@playwright/test";

const source = await readFile("crates/compiler/engine.mjs", "utf8");
const wasm = await readFile("crates/compiler/artifacts/compiler.wasm");
let instrumented = source;
for (const [before, after] of [
  ["checkpoint: supportsJSPI ? new WebAssembly.Suspending(checkpoint) : () => 0,", "checkpoint,"],
  [
    "begin(id, source, runtime, () => false, false)",
    "begin(id, source, runtime, () => false, true)",
  ],
  [
    "result = wasm.compile_module(...args);",
    "onCheckpoint?.(0); result = wasm.compile_module(...args); onCheckpoint?.(7);",
  ],
  [
    "return readResult(result, id);",
    "const value = readResult(result, id); onCheckpoint?.(8); return value;",
  ],
]) {
  assert.ok(instrumented.includes(before));
  instrumented = instrumented.replace(before, after);
}

const bundle = await build({
  entryPoints: ["benchmarks/pipeline-cases.mjs"],
  bundle: true,
  format: "iife",
  write: false,
  external: ["/original-engine.mjs"],
  plugins: [
    {
      name: "checkpoint-observation",
      setup(build) {
        build.onLoad({ filter: /compiler\/engine\.mjs$/ }, () => ({
          contents: instrumented,
          loader: "js",
        }));
      },
    },
  ],
});

const inputs = [
  {
    name: "effect-events",
    path: "/App.tsx",
    runtime: "react",
    source: await readFile("apps/demo/examples/effect-events/App.tsx", "utf8"),
  },
  {
    name: "functions-558k",
    path: "/large.ts",
    runtime: "dom",
    source: Array.from(
      { length: 10000 },
      (_, i) => `export function f${i}(a: number) { return a + ${i}; }`,
    ).join("\n"),
  },
  {
    name: "lines-900k",
    path: "/large.ts",
    runtime: "dom",
    source: Array.from({ length: 35000 }, (_, i) => `const value_${i} = 12345;`).join("\n"),
  },
  {
    name: "string-900k",
    path: "/large.js",
    runtime: "dom",
    source: 'export const text = "' + "a".repeat(900000) + '";',
  },
];

const responses = new Map([
  ["/cases.js", [bundle.outputFiles[0].contents, "text/javascript"]],
  ["/compiler.wasm", [wasm, "application/wasm"]],
  ["/original-engine.mjs", [source, "text/javascript"]],
]);

const server = createServer((request, response) => {
  const resource = responses.get(request.url) ?? [
    '<!doctype html><script src="/cases.js"></script>',
    "text/html",
  ];

  response.setHeader("content-type", resource[1]);
  response.end(resource[0]);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const results = {};
try {
  for (const [name, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await launcher.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      results[name] = {
        version: browser.version(),
        ...(await page.evaluate((inputs) => globalThis.runPipelineCosts(inputs), inputs)),
      };
      console.log(name, "complete");
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await mkdir("artifacts/benchmarks", { recursive: true });
  await writeFile(
    "artifacts/benchmarks/pipeline.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        cpu: cpus()[0].model,
        scope:
          "Current WASM, checkpoint timestamps collected in a dedicated Worker, no scheduling yields, instrumented output equal to unmodified engine. First round retained separately; warm phases use remaining seven rounds. This measures service time, not cooperative scheduling latency. JSON tests use actual compiled output plus source payload, main decode/parse versus cold and warm Worker decode/parse plus result clone; initial byte copying excluded equally. Worker return reconstructs full objects; direct-to-preview designs are not measured here.",
        phases: [
          "upload",
          "parse",
          "semantic",
          "transform",
          "link",
          "codegen",
          "map",
          "Rust finalize/free",
          "host decode/map/base64/free",
          "input release",
        ],
        compilerSHA256: createHash("sha256").update(wasm).digest("hex"),
        engineSHA256: createHash("sha256").update(source).digest("hex"),
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
