import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "@playwright/test";
import { createEngine } from "../crates/compiler/engine.mjs";
import { createProjectCompiler } from "../packages/runtime/src/compiler/project-compiler.ts";

const sources = {
  "/main.ts":
    "import {a,b,c,step,reset} from './values.ts'; export function sum(n){reset();let total=0;for(let i=0;i<n;i++){step();total+=a+b+c}return total}",
  "/values.ts":
    "export let a=0; export const b=2; export const c=3; export function step(){a++} export function reset(){a=0}",
};

const wasm = await readFile("crates/compiler/artifacts/compiler.wasm");

const compiler = createProjectCompiler(createEngine(await WebAssembly.compile(wasm)), {
  key: "review-native-bindings",
  runtime: "dom",
  entry: "/main.ts",
  imports: {},
  styles: [],
  dependencyFiles: {},
});

const hotSources = {
  ...sources,
  "/values.ts": sources["/values.ts"] + ";import.meta.hot.accept();",
};

const program = compiler.compile(hotSources);

const updates = Array.from({ length: 20 }, (_, i) =>
  compiler.compile({
    ...hotSources,
    "/values.ts": hotSources["/values.ts"] + ";export const revision=" + i,
  }),
);

compiler.dispose();
const root = process.cwd();

const script = await build({
  stdin: {
    contents: `
import { createModuleRuntime } from ${JSON.stringify(path.join(root, "packages/runtime/src/execution/module-runtime.ts"))};
import { createModulePolicy } from ${JSON.stringify(path.join(root, "packages/runtime/src/execution/adapters/policy.ts"))};
globalThis.run = async () => {
  const runtime = createModuleRuntime(createModulePolicy({}), ({code}) => new Function('return ('+code+')')());
  try {
    const own = (await runtime.apply(${JSON.stringify(program)}, () => {})).entry.sum;
    const native = (await import('/native/main.ts')).sum;
    const readers = [own, native];
    const n = 250000, batch = 32, expected = n*(n+1)/2+5*n;
    for(let i=0; i<4; i++) for(const read of readers) if(read(n)!==expected) throw Error('semantic mismatch');
    async function measure() {
    const samples=[[], []];
    for(let round=0; round<11; round++) {
      for(const i of round%2 ? [1,0] : [0,1]) {
        const start=performance.now();
        for(let k=0; k<batch; k++) if(readers[i](n)!==expected) throw Error('semantic mismatch');
        samples[i].push((performance.now()-start)/batch);
      }
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    return {samplesMs:samples, mediansMs:samples.map(a=>[...a].sort((x,y)=>x-y)[5])};
    }
    const initial = await measure();
    for(const update of ${JSON.stringify(updates)}) {
      const result = await runtime.apply(update, () => {});
      if(result.entry.sum !== own || result.evaluated.includes('/main.ts')) throw Error('importer identity changed');
    }
    const afterUpdates = await measure();
    return {namedReadsPerCall:n*4+1, iterationsPerCall:n, batch, rounds:11, updates:20, ...initial, afterUpdates};
  } finally { await runtime.dispose(); }
};`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  external: ["/native/main.ts"],
});

const server = createServer((request, response) => {
  if (request.url === "/bench.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(script.outputFiles[0].contents);
  } else if (request.url?.startsWith("/native/") && sources[request.url.slice(7)]) {
    response.setHeader("Content-Type", "text/javascript");
    response.end(sources[request.url.slice(7)]);
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><script src="/bench.js"></script>');
  }
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
        ...(await page.evaluate(() => globalThis.run())),
      };
      console.log(name, {
        initial: results[name].mediansMs,
        after20Updates: results[name].afterUpdates.mediansMs,
      });
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}

const receipt = {
  date: new Date().toISOString(),
  cpu: cpus()[0].model,
  variants: ["Reploom direct reader slots (module ABI 4)", "Native browser ESM"],
  scope:
    "Same mutable named imports and computed-result assertions. Steady-state execution only; no HMR, compiler, editor, or rendering in the timed region. Native ESM is a browser baseline, not a full Vite benchmark.",
  compilerSHA256: createHash("sha256").update(wasm).digest("hex"),
  sources,
  generatedCodeUsesCheckpoint: program.modules["/main.ts"].code.includes(".checkpoint("),
  results,
};

await mkdir("artifacts/benchmarks", { recursive: true });
await writeFile("artifacts/benchmarks/bindings.json", JSON.stringify(receipt, null, 2) + "\n");
