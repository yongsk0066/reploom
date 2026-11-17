import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { createServer } from "node:http";
import { chromium, firefox, webkit } from "@playwright/test";

const candidate = process.argv[2];
if (!candidate) throw Error("Usage: node benchmarks/wasm-build.mjs <candidate.wasm> [output.json]");
const identity = {};
const resources = {};
for (const [variant, path] of Object.entries({
  before: "crates/compiler/artifacts/compiler.wasm",
  after: candidate,
})) {
  const bytes = await readFile(path);
  resources[`/${variant}.wasm`] = [bytes, "application/wasm"];
  identity[variant] = {
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
resources["/engine.mjs"] = [await readFile("crates/compiler/engine.mjs"), "text/javascript"];
resources["/worker.mjs"] = [
  `
import {createEngine} from '/engine.mjs';
onmessage=async ({data:{variant,cases}})=>{
 try {
  const begin=performance.now();
  const module=await WebAssembly.compileStreaming(fetch('/'+variant+'.wasm'));
  const compiled=performance.now();
  const engine=createEngine(module);
  const instantiated=performance.now();
  const samples=[];
  for(const test of cases){
   const start=performance.now();
   let result=engine.compileModule(test.file,test.source,test.runtime);
   const firstMs=performance.now()-start;
   for(let i=0;i<3;i++)engine.compileModule(test.file,test.source,test.runtime);
   const warm=performance.now();
   for(let i=0;i<20;i++)result=engine.compileModule(test.file,test.source,test.runtime);
   const warmMs=(performance.now()-warm)/20;
   const bytes=new TextEncoder().encode(JSON.stringify(result));
   const digest=await crypto.subtle.digest('SHA-256',bytes);
   samples.push({name:test.name,firstMs,warmMs,memoryBytes:engine.memoryBytes(),outputSha256:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')});
  }
  postMessage({compileMs:compiled-begin,instanceMs:instantiated-compiled,firstReadyMs:instantiated-begin+samples[0].firstMs,samples});
 }catch(error){postMessage({error:String(error)})}
};`,
  "text/javascript",
];

const cases = [
  {
    name: "effect-events",
    file: "/App.tsx",
    runtime: "react",
    source: await readFile("apps/demo/examples/effect-events/App.tsx", "utf8"),
  },
  {
    name: "declarations-250k",
    file: "/main.ts",
    runtime: "dom",
    source: Array.from({ length: 10000 }, (_, i) => `export const v${i} = ${i};`).join("\n"),
  },
  {
    name: "string-900k",
    file: "/main.ts",
    runtime: "dom",
    source: 'export const text="' + "x".repeat(900000) + '";',
  },
  {
    name: "typed-generics",
    file: "/main.ts",
    runtime: "dom",
    source:
      "type Box<T>={value:T};" +
      Array.from(
        { length: 1000 },
        (_, i) => `export function get${i}<T>(b:Box<T>):T{return b.value}`,
      ).join("\n"),
  },
];

const server = createServer((req, res) => {
  const [body, mime] = resources[req.url] ?? ["<!doctype html>", "text/html"];
  res.setHeader("content-type", mime);
  res.end(body);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const results = {};
try {
  for (const [name, launcher] of Object.entries({ chromium, firefox, webkit })) {
    results[name] = { samples: [] };
    for (let round = 0; round < 3; round++)
      for (const variant of round % 2 ? ["after", "before"] : ["before", "after"]) {
        const browser = await launcher.launch();
        try {
          results[name].version = browser.version();
          const page = await browser.newPage();
          await page.goto(`http://127.0.0.1:${server.address().port}`);

          const observation = await page.evaluate(
            ({ variant, cases }) =>
              new Promise((resolve, reject) => {
                const worker = new Worker("/worker.mjs", { type: "module" });

                const timer = setTimeout(() => {
                  worker.terminate();
                  reject(Error("Timed out"));
                }, 30000);

                worker.onmessage = ({ data }) => {
                  clearTimeout(timer);
                  worker.terminate();
                  if (data.error) reject(Error(data.error));
                  else resolve(data);
                };
                worker.onerror = (event) => {
                  clearTimeout(timer);
                  worker.terminate();
                  reject(Error(event.message));
                };
                worker.postMessage({ variant, cases });
              }),
            { variant, cases },
          );

          results[name].samples.push({ variant, round, ...observation });
          console.log(
            name,
            variant,
            round,
            observation.firstReadyMs,
            observation.samples.map((s) => s.warmMs),
          );
        } finally {
          await browser.close();
        }
      }
    for (const sample of results[name].samples)
      assert.deepEqual(
        sample.samples.map((s) => s.outputSha256),
        results[name].samples[0].samples.map((s) => s.outputSha256),
      );
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  const output = process.argv[3] ?? "artifacts/wasm-build.json";
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        identity,
        scope:
          "Three alternating fresh-process pairs per engine, same Rust/bindgen input with different Binaryen optimization. Worker compileStreaming includes local network, then instance and first compile. Warm cases average 20 compiles after three warmups. Every output hash must agree.",
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
