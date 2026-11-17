import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { cpus } from "node:os";
import { chromium, firefox, webkit } from "@playwright/test";
import {
  comparisons,
  computedKeys,
  grammarCases,
  nestedGenerics,
} from "../tests/fixtures/compiler/parser-cases.mjs";

const baselinePath = process.argv[2];
if (!baselinePath) throw Error("Usage: pnpm bench:parser <baseline.wasm> [--bounded-baseline]");
const boundedBaseline = process.argv.includes("--bounded-baseline");
const before = await readFile(baselinePath);

const after = await readFile(
  new URL("../crates/compiler/artifacts/compiler.wasm", import.meta.url),
);

const engine = await readFile(new URL("../crates/compiler/engine.mjs", import.meta.url));
const cases = [];
for (const file of [
  "examples/effect-events/App.tsx",
  "examples/react-counter/App.tsx",
  "tests/fixtures/regression/projects/react-effect-dependencies/App.jsx",
])
  cases.push({
    name: file,
    source: await readFile(file, "utf8"),
    file: "/App." + (file.endsWith(".tsx") ? "tsx" : "jsx"),
    runtime: "react",
  });
for (const count of [64, 128, 512, 2048])
  cases.push({ name: `comparisons-${count}`, source: comparisons(count) });
cases.push({ name: "computed-keys-20", source: computedKeys(20) });
// The original compiler reaches 4 GiB on 24 levels; exercise that case only after the fix.
cases.push({ name: "computed-keys-24", source: computedKeys(24), afterOnly: true });
grammarCases.forEach((source, index) => cases.push({ name: `grammar-${index}`, source }));
cases.push({ name: "deep-generics", source: nestedGenerics(140), resourceDiagnostic: true });
cases.push({
  name: "deep-computed-keys",
  source: computedKeys(140),
  resourceDiagnostic: true,
  afterOnly: true,
});

const worker = `
import {createEngine} from '/engine.mjs';
self.onmessage=async ({data:{variant,test}})=>{
  let engine;
  let attempts=0;
  try {
    engine=createEngine(await WebAssembly.compile(await (await fetch('/'+variant+'.wasm')).arrayBuffer()));
    const compile=()=>{
      attempts++;
      try {return {ok:true,value:engine.compileModule(test.file||'/main.tsx',test.source,test.runtime||'dom')}}
      catch(error){
        if(error.fatal) throw error;
        return {ok:false,error:error.message,diagnostics:error.diagnostics};
      }
    };
    const start=performance.now();let result=compile();const firstMs=performance.now()-start;
    for(let warmup=0;warmup<3;warmup++)result=compile();
    const warm=performance.now();result=compile();const warmMs=performance.now()-warm;
    const batch=warmMs>5?1:Math.max(64,Math.min(256,Math.ceil(10/Math.max(warmMs,0.05))));
    const samplesMs=[];
    for(let round=0;round<7;round++){
      const start=performance.now();
      for(let index=0;index<batch;index++)result=compile();
      samplesMs.push((performance.now()-start)/batch);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    const output=JSON.stringify(result);
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(output));
    const outputHash=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
    const recovered=!!engine.compileModule('/recovery.ts','export const recovered=1;','dom').code;
    postMessage({status:'completed',attempts,firstMs,batch,samplesMs,medianMs:[...samplesMs].sort((a,b)=>a-b)[3],memoryBytes:engine.memoryBytes(),outputHash,ok:result.ok,diagnostics:result.diagnostics,recovered});
  } catch(error) {
    postMessage({status:'fatal',attempts,memoryBytes:engine?.memoryBytes(),error:error.message,cause:error.cause?.message});
  }
};`;

const html = `<!doctype html><script>
globalThis.measure=(variant,test)=>new Promise(resolve=>{
  const worker=new Worker('/probe.mjs',{type:'module'});
  const done=result=>{clearTimeout(timer);worker.terminate();resolve(result)};
  const timer=setTimeout(()=>done({status:'timeout'}),20000);
  worker.onmessage=({data})=>done(data);
  worker.onerror=event=>done({status:'error',error:event.message});
  worker.postMessage({variant,test});
});</script>`;

const resources = {
  "/before.wasm": [before, "application/wasm"],
  "/after.wasm": [after, "application/wasm"],
  "/engine.mjs": [engine, "text/javascript"],
  "/probe.mjs": [worker, "text/javascript"],
};

const server = createServer((request, response) => {
  const [body, type] = resources[request.url] ?? [html, "text/html"];
  response.setHeader("content-type", type);
  response.end(body);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const results = {};
try {
  for (const [name, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await launcher.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      results[name] = { version: browser.version(), cases: [] };
      for (let index = 0; index < cases.length; index++) {
        const test = cases[index];
        const observed = {};

        const variants =
          test.afterOnly && !boundedBaseline
            ? ["after"]
            : index % 2
              ? ["after", "before"]
              : ["before", "after"];

        for (const variant of variants)
          observed[variant] = await page.evaluate(
            ({ variant, test }) => globalThis.measure(variant, test),
            { variant, test },
          );
        const entry = { name: test.name, sourceCharacters: test.source.length, ...observed };
        results[name].cases.push(entry);
        if (boundedBaseline) {
          assert.equal(observed.before.status, "completed", JSON.stringify(entry));
          assert.equal(observed.before.recovered, true, JSON.stringify(entry));
          assert.equal(
            observed.after.outputHash,
            observed.before.outputHash,
            JSON.stringify(entry),
          );
        }
        assert.equal(observed.after.status, "completed", JSON.stringify(entry));
        assert.equal(observed.after.recovered, true, JSON.stringify(entry));
        if (test.resourceDiagnostic)
          assert.ok(
            observed.after.diagnostics?.some((item) => item.text.includes("nesting budget (32)")),
            JSON.stringify(entry),
          );
        else if (observed.before?.status === "completed")
          assert.equal(
            observed.after.outputHash,
            observed.before.outputHash,
            JSON.stringify(entry),
          );
        if (test.name.startsWith("computed-keys"))
          assert.ok(observed.after.memoryBytes < 8 * 1024 * 1024);
        console.log(
          name,
          test.name,
          JSON.stringify({
            beforeMs: observed.before?.medianMs,
            afterMs: observed.after.medianMs,
            beforeMiB: observed.before?.memoryBytes / 1048576,
            afterMiB: observed.after.memoryBytes / 1048576,
          }),
        );
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  await mkdir("artifacts/benchmarks", { recursive: true });
  await writeFile(
    "artifacts/benchmarks/parser.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        cpu: cpus()[0].model,
        scope:
          "Fresh Worker/Instance per variant and workload; whole compileModule, excluding Worker startup/WASM initialization. Five calls before measurement, seven calibrated samples (at least 64 calls for workloads calibrating below 5 ms), alternating variant order. Any fatal attempt ends that instance immediately. Memory is WASM linear-memory capacity, not process RSS. Successful outputs/diagnostics must match except the new explicit type budget. Every completed case must compile a subsequent valid module using the same instance.",
        before: { path: baselinePath, sha256: hash(before), bytes: before.length, boundedBaseline },
        after: { sha256: hash(after), bytes: after.length },
        cases,
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
