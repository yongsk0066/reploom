import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileFunction } from "node:vm";
import { Worker as NodeWorker } from "node:worker_threads";
import { once } from "node:events";
import { setImmediate as nextTask, setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { createEngine } from "../../crates/compiler/engine.mjs";
import { createProjectCompiler } from "../../packages/runtime/src/compiler/project-compiler.ts";
import { createModuleRuntime } from "../../packages/runtime/src/execution/module-runtime.ts";
import { createModulePolicy } from "../../packages/runtime/src/execution/adapters/policy.ts";
import { createAssetRepository } from "../../packages/runtime/src/shared/assets.ts";
import { createValidationServices } from "../../packages/runtime/src/browser/validation.ts";
import { createTypecheckFiles } from "../../packages/build/src/typecheck-files.mjs";
import { mapTypeDiagnostics } from "../../packages/build/src/typecheck-diagnostics.mjs";
import { NotFoundError } from "@tsrs/wasm/core";
import { PROTOCOL, MODULE_ABI } from "../../packages/runtime/src/shared/protocol.ts";

const wasm = await WebAssembly.compile(
  await readFile(new URL("../../crates/compiler/artifacts/compiler.wasm", import.meta.url)),
);

const config = {
  key: "contracts",
  runtime: "dom",
  entry: "/main.ts",
  imports: {},
  styles: [],
  dependencyFiles: {},
};

const load = ({ code }) => compileFunction(`return (${code})`)();

function setup(t) {
  const compiler = createProjectCompiler(createEngine(wasm), config);
  const runtime = createModuleRuntime(createModulePolicy({}), load);
  t.after(async () => {
    await runtime.dispose();
    compiler.dispose();
    delete globalThis.__commitGate;
    delete globalThis.__loads;
  });
  return { runtime, apply: (files) => runtime.apply(compiler.compile(files), () => {}) };
}

test("staged state transfers late scalar and nested inputs, including input after publication", async (t) => {
  const { runtime, apply } = setup(t);

  const source =
    "const count=import.meta.state('count',0); const list=import.meta.state('list',[]); export const bump=()=>{count.value++;list.value.push(count.value)}; export const read=()=>[count.value,list.value];";

  const first = await apply({ "/main.ts": source });
  first.entry.bump();
  const gate = Promise.withResolvers();
  globalThis.__commitGate = gate.promise;
  const pending = apply({ "/main.ts": source + "await globalThis.__commitGate;" });
  await nextTask();
  first.entry.bump();
  gate.resolve();
  const updated = await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(updated.entry.read())), [2, [1, 2]]);
  first.entry.bump();
  assert.deepEqual(JSON.parse(JSON.stringify(updated.entry.read())), [3, [1, 2, 3]]);
  assert.equal(runtime.captureState()["/main.ts"].count, 3);
});

test("state read/write conflicts abort the complete graph, preserve live input and recover on a later edit", async (t) => {
  const { runtime, apply } = setup(t);

  const source =
    "const count=import.meta.state('count',0); export const bump=()=>++count.value; export const read=()=>count.value;";

  const first = await apply({ "/main.ts": source });
  first.entry.bump();
  for (const candidate of ["const cached=count.value;", "count.value=100;"]) {
    const gate = Promise.withResolvers();
    globalThis.__commitGate = gate.promise;
    const pending = apply({ "/main.ts": source + candidate + "await globalThis.__commitGate;" });
    await nextTask();
    const expected = first.entry.bump();
    gate.resolve();
    await assert.rejects(pending, /Managed state changed/);
    assert.equal(runtime.captureState()["/main.ts"].count, expected);
  }
  const recovered = await apply({ "/main.ts": source + "export const updated=true;" });
  assert.equal(recovered.entry.read(), 3);
  assert.equal(recovered.entry.bump(), 4);
});

test("nested mutations conflict without proxies and discarded candidate writes stay private", async (t) => {
  const { runtime, apply } = setup(t);

  const source =
    "const cell=import.meta.state('object',{items:[0]}); export const bump=()=>cell.value.items.push(1); export const read=()=>cell.value.items.length;";

  const first = await apply({ "/main.ts": source });
  const gate = Promise.withResolvers();
  globalThis.__commitGate = gate.promise;

  const pending = apply({
    "/main.ts":
      source + "const cached=cell.value; cached.items.push(99); await globalThis.__commitGate;",
  });

  await nextTask();
  first.entry.bump();
  gate.resolve();
  await assert.rejects(pending, /Managed state changed/);
  assert.deepEqual([...runtime.captureState()["/main.ts"].object.items], [0, 1]);
});

test("state conflicts after resource disposal carry only committed state for realm recovery", async (t) => {
  const { apply } = setup(t);

  const source =
    "const count=import.meta.state('count',0); import.meta.hot.dispose(()=>{}); export const bump=()=>++count.value;";

  const first = await apply({ "/main.ts": source });
  const gate = Promise.withResolvers();
  globalThis.__commitGate = gate.promise;
  const pending = apply({ "/main.ts": source + "count.value=100; await globalThis.__commitGate;" });
  await nextTask();
  first.entry.bump();
  gate.resolve();
  await assert.rejects(
    pending,
    (error) => error.requiresRestart && error.state["/main.ts"].count === 1,
  );
});

test("explicit accepted exports stop only matching named edges; updated module side effects still run", async (t) => {
  const { apply } = setup(t);
  globalThis.__loads = { a: 0, b: 0, dep: 0 };

  const files = {
    "/main.ts":
      "import {read} from './a.ts'; import {value} from './b.ts'; export const sample=()=>[read(),value];",
    "/a.ts": "import {foo} from './dep.ts'; globalThis.__loads.a++; export const read=()=>foo;",
    "/b.ts": "import {bar} from './dep.ts'; globalThis.__loads.b++; export const value=bar;",
    "/dep.ts":
      "globalThis.__loads.dep++; export let foo=1; export const bar=2; import.meta.hot.acceptExports(['foo']);",
  };

  await apply(files);
  const changed = { ...files, "/dep.ts": files["/dep.ts"].replace("foo=1", "foo=3") };
  const next = await apply(changed);
  assert.deepEqual(next.entry.sample(), [3, 2]);
  assert.deepEqual(globalThis.__loads, { a: 1, b: 2, dep: 2 });
  assert.equal(next.evaluated.includes("/a.ts"), false);

  const withdrawn = await apply({
    ...changed,
    "/dep.ts": changed["/dep.ts"].replace("import.meta.hot.acceptExports(['foo']);", ""),
  });

  assert.equal(withdrawn.evaluated.includes("/a.ts"), true);
});

test("namespace, dynamic and explicit side-effect edges propagate despite selective acceptance", async (t) => {
  const { apply } = setup(t);
  const dependency = "export let foo=1; import.meta.hot.acceptExports(['foo']);";
  for (const importer of [
    "import * as ns from './dep.ts'; export const read=()=>ns.foo;",
    "import './dep.ts'; import {foo} from './dep.ts'; export const read=()=>foo;",
    "const ns=await import('./dep.ts'); export const read=()=>ns.foo;",
  ]) {
    await apply({ "/main.ts": importer, "/dep.ts": dependency });

    const next = await apply({
      "/main.ts": importer,
      "/dep.ts": dependency.replace("foo=1", "foo=2"),
    });

    assert.equal(next.entry.read(), 2);
    assert.ok(next.evaluated.includes("/main.ts"));
  }
});

const asset = { url: "asset", sha256: createHash("sha256").update("hello").digest("hex") };
test("download consumers cancel independently; last cancellation aborts and evicts a pending producer", async () => {
  const replies = [];
  const signals = [];

  const repo = createAssetRepository({
    manifestUrl: "https://fixture.invalid/assets/manifest.json",
    fetch: (_url, { signal }) => {
      signals.push(signal);
      return new Promise((resolve) => replies.push(resolve));
    },
  });

  try {
    const a = new AbortController();
    const b = new AbortController();
    const one = repo.loadAsset(asset, a.signal);
    const two = repo.loadAsset(asset, b.signal);
    await nextTask();
    a.abort();
    await assert.rejects(one, { name: "AbortError" });
    assert.equal(signals[0].aborted, false);
    replies[0](new Response("hello"));
    assert.equal(await two, "hello");
    const uncached = { ...asset, sha256: "different" };
    const c = new AbortController();
    const three = repo.loadAsset(uncached, c.signal);
    await nextTask();
    c.abort();
    await assert.rejects(three, { name: "AbortError" });
    assert.equal(signals[1].aborted, true);
    const d = new AbortController();
    const retry = repo.loadAsset(uncached, d.signal);
    await nextTask();
    assert.equal(signals.length, 3);
    d.abort();
    await assert.rejects(retry, { name: "AbortError" });
    replies[1](new Response("hello"));
    replies[2](new Response("hello"));
  } finally {
    repo.dispose();
  }
});

test("a nonresponding download times out and the next consumer can retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requests = 0;

  const repo = createAssetRepository({
    manifestUrl: "https://fixture.invalid/manifest.json",
    downloadTimeoutMs: 10,
    fetch: async () => {
      requests++;
      if (requests === 1) return new Promise(() => {});
      return new Response("hello");
    },
  });

  try {
    const expired = assert.rejects(repo.loadAsset(asset), { name: "TimeoutError" });
    await nextTask();
    t.mock.timers.tick(10);
    await expired;
    assert.equal(await repo.loadAsset(asset), "hello");
    assert.equal(requests, 2);
  } finally {
    repo.dispose();
  }
});

test("type-check download cancellation releases the lane and retries without a stale request", async () => {
  let requests = 0;

  const repo = createAssetRepository({
    manifestUrl: "https://fixture.invalid/manifest.json",
    fetch: async () => {
      requests++;
      return new Promise(() => {});
    },
  });

  const services = createValidationServices(repo);
  const a = new AbortController();
  const first = services.types({}, a.signal);
  await nextTask();
  a.abort();
  await assert.rejects(first, { name: "AbortError" });
  const b = new AbortController();
  const second = services.types({}, b.signal);
  await nextTask();
  assert.equal(requests, 2);
  b.abort();
  await assert.rejects(second, { name: "AbortError" });
  services.dispose();
  repo.dispose();
});

test("type-check leases reuse initialization, terminate active cancellation, then retire after idle", async () => {
  const workers = [];
  const reusable = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const contents = { worker: "", config: "{}", wasm: "bytes" };

  const assets = Object.fromEntries(
    Object.entries(contents).map(([key, value]) => [
      key,
      { url: key, sha256: createHash("sha256").update(value).digest("hex") },
    ]),
  );

  const repo = createAssetRepository({
    manifestUrl: "https://fixture.invalid/manifest.json",
    fetch: async (url) =>
      new URL(url).pathname === "/manifest.json"
        ? Response.json({
            schema: 2,
            protocol: PROTOCOL,
            moduleABI: MODULE_ABI,
            typecheck: { worker: assets.worker, configuration: assets.config, wasm: assets.wasm },
          })
        : new Response(contents[new URL(url).pathname.slice(1)]),
  });

  const services = createValidationServices(repo, {
    idleMs: 10,
    createWorker: () => {
      const worker = {
        messages: [],
        terminate() {
          this.retired = true;
        },
        postMessage(message) {
          this.messages.push(message);
          if (message.module)
            throw new DOMException("Module cloning unavailable", "DataCloneError");
          if (!this.hold)
            queueMicrotask(() =>
              this.onmessage?.({
                data: {
                  protocol: 1,
                  id: message.id,
                  ready: true,
                  diagnostics: message.files?.["/error.ts"]
                    ? [{ text: "Type error", file: "/error.ts", line: 1, column: 0 }]
                    : [],
                  memoryBytes: message.files?.["/large.ts"] ? 256 * 1024 * 1024 : 65536,
                  checkpoint: message.files?.["/large.ts"]
                    ? { module: reusable, buildInfo: "checkpoint" }
                    : undefined,
                },
              }),
            );
        },
      };

      workers.push(worker);
      return worker;
    },
  });

  try {
    const signal = new AbortController().signal;
    assert.deepEqual(await services.types({}, signal), []);
    assert.deepEqual(await services.types({}, signal), []);
    assert.equal(workers.length, 1);
    assert.deepEqual(
      workers[0].messages.map((m) => m.type),
      ["initialize", "check"],
    );
    const mutable = { "/error.ts": "invalid" };
    const diagnostics = await services.types(mutable, signal);
    diagnostics[0].text = "mutated";
    mutable["/error.ts"] = "edited";
    assert.equal((await services.types({ "/error.ts": "invalid" }, signal))[0].text, "Type error");
    assert.equal(workers[0].messages.filter((m) => m.type === "check").length, 2);
    await services.types(mutable, signal);
    assert.equal(workers[0].messages.filter((m) => m.type === "check").length, 3);
    workers[0].hold = true;
    const c = new AbortController();
    const active = services.types({ "/changed.ts": "export const changed = true;" }, c.signal);
    await nextTask();
    c.abort();
    await assert.rejects(active, { name: "AbortError" });
    assert.equal(workers[0].retired, true);
    await services.types({}, signal);
    assert.equal(workers.length, 2);
    await delay(20);
    assert.equal(workers[1].retired, true);
    const large = { "/large.ts": "export const large = true;" };
    await services.types(large, signal);
    assert.equal(workers[2].retired, true);
    await services.types(large, signal);
    assert.equal(workers.length, 3);
    await services.types({ ...large, "/changed.ts": "export const changed = true;" }, signal);
    assert.equal(workers[3].messages[0].module, reusable);
    assert.equal(workers[3].messages[1].module, undefined);
    assert.equal(workers[3].messages[1].buildInfo, "checkpoint");
    assert.equal(workers[3].retired, true);
    await delay(20);
    await services.types(large, signal);
    assert.equal(workers.length, 5);
    assert.equal(workers[4].messages[0].module, undefined);
    assert.equal(workers[4].messages[0].buildInfo, undefined);
  } finally {
    services.dispose();
    repo.dispose();
  }
});

test("indexed declarations are shared while project file overlays and writes remain isolated", () => {
  const create = createTypecheckFiles({
    "/node_modules/lib/index.d.ts": "export const n: number",
    "/a.d.ts": "declare const a: number",
  });

  const a = create({ "/main.ts": "let x=1" });
  const b = create({ "/main.ts": "let x='a'" });
  assert.equal(
    a.readFile("/node_modules/lib/index.d.ts"),
    b.readFile("/node_modules/lib/index.d.ts"),
  );
  assert.deepEqual(a.readDir("/node_modules"), [["d", "lib"]]);
  assert.equal(a.stat("/node_modules/lib").kind, "d");
  a.writeFile("/main.ts", new TextEncoder().encode("changed"), false);
  assert.equal(new TextDecoder().decode(b.readFile("/main.ts")), "let x='a'");
});

test("one state conflict prevents every candidate state from publishing", async (t) => {
  const { runtime, apply } = setup(t);

  const files = {
    "/main.ts": "import {read} from './a.ts'; import {bump} from './b.ts'; export {read,bump};",
    "/a.ts": "const a=import.meta.state('a',1); export const read=()=>a.value;",
    "/b.ts": "const b=import.meta.state('b',1); export const bump=()=>++b.value;",
  };

  const first = await apply(files);
  const gate = Promise.withResolvers();
  globalThis.__commitGate = gate.promise;

  const pending = apply({
    ...files,
    "/a.ts": files["/a.ts"] + "a.value=99;",
    "/b.ts": files["/b.ts"] + "const observed=b.value; await globalThis.__commitGate;",
  });

  await nextTask();
  first.entry.bump();
  gate.resolve();
  await assert.rejects(pending, /Managed state changed/);
  assert.equal(runtime.captureState()["/a.ts"].a, 1);
  assert.equal(runtime.captureState()["/b.ts"].b, 2);
});

async function createChecker(t, configuration, options = {}) {
  const worker = new NodeWorker(
    `const {parentPort, workerData} = require('node:worker_threads');
    globalThis.self = globalThis;
    globalThis.postMessage = value => parentPort.postMessage(value);
    import(workerData).then(() => {
      parentPort.on('message', data => self.onmessage({data}));
      parentPort.postMessage({loaded:true});
    });`,
    {
      eval: true,
      workerData: new URL("../../packages/build/src/typecheck-worker.mjs", import.meta.url).href,
    },
  );

  t.after(() => worker.terminate());
  const receive = async () => (await once(worker, "message"))[0];
  assert.equal((await receive()).loaded, true);
  const wasm = await readFile(new URL(import.meta.resolve("@tsrs/wasm/tsrs.wasm")));
  let id = 0;

  const send = async (message) => {
    const response = receive();
    worker.postMessage({ protocol: 1, id: ++id, ...message });
    const result = await response;
    assert.equal(result.error, undefined);
    return result;
  };

  const ready = await send({
    type: "initialize",
    wasm,
    configuration: new TextEncoder().encode(JSON.stringify(configuration)),
    ...options,
  });

  assert.equal(ready.ready, true);
  return Object.assign((files) => send({ type: "check", files }), {
    dispose: () => worker.terminate(),
  });
}

test("reused type checking preserves diagnostic locations in prepared declarations", async (t) => {
  const source =
    "export const one: string;\nexport const two: number;\nexport const broken: Missing;";

  const check = await createChecker(t, {
    files: { "/vendor.d.ts": source, "/reploom.d.ts": "" },
    compilerOptions: { skipLibCheck: false, incremental: true },
  });

  for (let i = 0; i < 3; i++) {
    const result = await check({
      "/main.ts": "import {one} from './vendor'; export const value = one;",
    });

    const diagnostic = result.diagnostics.find((item) => item.file === "/vendor.d.ts");
    assert.ok(diagnostic, JSON.stringify(result.diagnostics));
    assert.equal(diagnostic.line, 3);
    assert.equal(diagnostic.column, source.split("\n")[2].indexOf("Missing"));
    assert.ok(result.buildInfoBytes > 0 && result.buildInfoBytes <= 1024 * 1024);
  }
});

test("incremental type metadata invalidates dependent errors, added roots, removed files and moves", async (t) => {
  const check = await createChecker(t, {
    files: { "/reploom.d.ts": "" },
    compilerOptions: { strict: true, incremental: true },
  });

  const files = {
    "/main.ts": "import type {Item} from './model'; export const item: Item={value:1};",
    "/model.ts": "export type Item={value:number};",
  };

  assert.deepEqual((await check(files)).diagnostics, []);
  files["/model.ts"] = "export type Item={value:string};";
  const failed = await check(files);
  assert.equal(failed.diagnostics.length, 1);
  assert.match(failed.diagnostics[0].text, /TS2322/);
  assert.deepEqual((await check(files)).diagnostics, failed.diagnostics);
  delete files["/model.ts"];
  assert.match((await check(files)).diagnostics[0].text, /TS2307/);
  files["/types.ts"] = "export type Item={value:number};";
  files["/main.ts"] = files["/main.ts"].replace("./model", "./types");
  assert.deepEqual((await check(files)).diagnostics, []);
  files["/extra.ts"] = "export const extra: number='wrong';";
  assert.equal((await check(files)).diagnostics[0].file, "/extra.ts");
  delete files["/extra.ts"];
  assert.deepEqual((await check(files)).diagnostics, []);
});

test("checker checkpoints cross retirement with compiled code and bounded metadata but no WASM instance", async (t) => {
  const configuration = { files: { "/reploom.d.ts": "" }, compilerOptions: { incremental: true } };
  const first = await createChecker(t, configuration, { maxMemoryBytes: 1 });
  const result = await first({ "/main.ts": "export const value: number = 1;" });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(Object.keys(result.checkpoint).sort(), ["buildInfo", "module"]);
  assert.ok(result.checkpoint.module instanceof WebAssembly.Module);
  assert.ok(result.checkpoint.buildInfo.length * 2 <= 1024 * 1024);
  await first.dispose();

  const second = await createChecker(t, configuration, {
    ...result.checkpoint,
    wasm: new Uint8Array(),
  });

  assert.match(
    (await second({ "/main.ts": "export const value: number = 'changed';" })).diagnostics[0].text,
    /TS2322/,
  );
});

test("diagnostic batches locate Unicode and CRLF sources without reusing obsolete line indexes", async (t) => {
  const check = await createChecker(t, {
    files: { "/reploom.d.ts": "" },
    compilerOptions: { incremental: true },
  });

  const row = 'const label = "한글😀"; export const broken: number = "wrong";';
  for (const prefix of ["\r\n".repeat(500), "// updated\n", ""]) {
    const result = await check({
      "/a.ts": prefix + row,
      "/b.ts": 'export const other: number = "bad";',
    });

    assert.equal(result.diagnostics.length, 2);
    const first = result.diagnostics.find((item) => item.file === "/a.ts");
    assert.equal(first.line, prefix.split("\n").length);
    assert.equal(first.column, row.indexOf("broken"));
    const second = result.diagnostics.find((item) => item.file === "/b.ts");
    assert.equal(second.line, 1);
    assert.equal(second.column, 13);
  }
});

test("diagnostic projection prefers checker coordinates and indexes fallback sources once per batch", () => {
  const source = "// 한글😀\r\nlet x=1;\n";
  const reads = [];

  const read = (file) => {
    reads.push(file);
    return source;
  };

  const diagnostic = { fileName: "/a.ts", code: 2322, text: "invalid" };

  const supplied = mapTypeDiagnostics(
    [{ ...diagnostic, startPosition: { line: 2, character: 4 } }],
    read,
  );

  assert.deepEqual(reads, []);
  assert.equal(supplied[0].line, 3);
  assert.equal(supplied[0].column, 4);

  const positions = [
    0,
    1,
    7,
    source.indexOf("\n"),
    source.indexOf("\n") + 1,
    source.length,
    source.length + 10,
  ];

  const fallback = mapTypeDiagnostics(
    positions.map((pos) => ({ ...diagnostic, pos })),
    read,
  );

  assert.deepEqual(reads, ["/a.ts"]);
  for (let i = 0; i < positions.length; i++) {
    const prefix = source.slice(0, positions[i]).split("\n");
    assert.equal(fallback[i].line, prefix.length);
    assert.equal(fallback[i].column, prefix.at(-1).length);
  }
  assert.equal(mapTypeDiagnostics([{ ...diagnostic, pos: source.length }], () => "")[0].line, 1);
  assert.equal(
    mapTypeDiagnostics([{ code: 1, text: "global" }], () => {
      throw Error("missing");
    })[0].column,
    0,
  );
});

test("checkpoint initialization skips WASM bytes and cancellation owns a failed-clone fallback", async () => {
  const reusable = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const contents = { worker: "", config: "{}", wasm: new Uint8Array(9 * 1024 * 1024) };

  const assets = Object.fromEntries(
    Object.entries(contents).map(([name, value]) => [
      name,
      { url: name, sha256: createHash("sha256").update(value).digest("hex") },
    ]),
  );

  let wasmRequests = 0;
  let rejectClone = false;
  let fallbackSignal;
  const workers = [];

  const repo = createAssetRepository({
    manifestUrl: "https://fixture.invalid/manifest.json",
    fetch: async (url, options) => {
      const key = new URL(url).pathname.slice(1);
      if (key === "manifest.json")
        return Response.json({
          schema: 2,
          protocol: PROTOCOL,
          moduleABI: MODULE_ABI,
          typecheck: { worker: assets.worker, configuration: assets.config, wasm: assets.wasm },
        });
      if (key === "wasm" && ++wasmRequests === 2) {
        fallbackSignal = options.signal;
        return new Promise(() => {});
      }
      return new Response(contents[key]);
    },
  });

  const services = createValidationServices(repo, {
    maxMemoryBytes: 1,
    createWorker: () => {
      const worker = {
        messages: [],
        terminated: 0,
        terminate() {
          this.terminated++;
        },
        postMessage(message) {
          this.messages.push(message);
          if (message.module && rejectClone)
            throw new DOMException("unsupported module", "DataCloneError");
          queueMicrotask(() =>
            this.onmessage?.({
              data: {
                protocol: 1,
                id: message.id,
                ready: true,
                diagnostics: [],
                memoryBytes: 2,
                checkpoint: { module: reusable },
              },
            }),
          );
        },
      };

      workers.push(worker);
      return worker;
    },
  });

  try {
    const signal = new AbortController().signal;
    await services.types({ "/a.ts": "export const n=1;" }, signal);
    await services.types({ "/a.ts": "export const n=2;" }, signal);
    assert.equal(wasmRequests, 1);
    assert.equal(workers[1].messages[0].module, reusable);
    assert.equal(workers[1].messages[0].wasm, undefined);
    rejectClone = true;
    const controller = new AbortController();
    const pending = services.types({ "/a.ts": "export const n=3;" }, controller.signal);
    while (!fallbackSignal) await nextTask();
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await nextTask();
    assert.equal(fallbackSignal.aborted, true);
    assert.equal(workers[2].terminated, 1);
    rejectClone = false;
    await services.types({ "/a.ts": "export const n=4;" }, signal);
    assert.equal(wasmRequests, 3);
    assert.equal(workers[3].messages[0].module, undefined);
  } finally {
    services.dispose();
    repo.dispose();
  }
});

test("file-system layers index writes, append, removal, directory merges and normalized paths", () => {
  const encode = new TextEncoder();
  const decode = (bytes) => new TextDecoder().decode(bytes);

  const create = createTypecheckFiles({
    "/lib/index.d.ts": "original",
    "/lib/shared.d.ts": "shared",
    "/empty.d.ts": "",
  });

  const host = create({ "/lib/index.d.ts": "overlay", "/src/main.ts": "source" });
  const other = create({});
  assert.equal(decode(host.readFile("\\lib\\..\\lib\\index.d.ts")), "overlay");
  assert.equal(decode(other.readFile("/lib/index.d.ts")), "original");
  host.writeFile("/lib/index.d.ts", encode.encode("😀"), true);
  assert.equal(decode(host.readFile("/lib/index.d.ts")), "overlay😀");
  assert.equal(host.written.get("/lib/index.d.ts"), "overlay😀");
  host.writeFile("/new/nested/file.ts", encode.encode("text"), false);
  assert.deepEqual(host.readDir("/new"), [["d", "nested"]]);
  assert.equal(host.stat("/new/nested").kind, "d");
  assert.equal(host.stat("/empty.d.ts").size, 0);
  assert.deepEqual(
    new Set(host.readDir("/lib").map((entry) => entry.join(":"))),
    new Set(["f:index.d.ts", "f:shared.d.ts"]),
  );
  host.remove("/new");
  assert.throws(() => host.stat("/new"), NotFoundError);
  assert.equal(host.written.has("/new/nested/file.ts"), false);
  host.remove("/lib");
  assert.equal(decode(host.readFile("/lib/index.d.ts")), "original");
  assert.equal(host.written.has("/lib/index.d.ts"), false);
  assert.equal(host.realpath("/src/../lib/index.d.ts"), "/lib/index.d.ts");
});
