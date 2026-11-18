import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createEngine } from "../../crates/compiler/engine.mjs";
import { createProjectCompiler } from "../../packages/runtime/src/compiler/project-compiler.ts";
import { compileFunction } from "node:vm";
import { createModuleRuntime } from "../../packages/runtime/src/execution/module-runtime.ts";
import { createModulePolicy } from "../../packages/runtime/src/execution/adapters/policy.ts";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

const base = new URL("../../crates/compiler/", import.meta.url);
const bytes = await readFile(new URL("artifacts/compiler.wasm", base));
const module = await WebAssembly.compile(bytes);

const config = {
  key: "rust-contract",
  entry: "/a.ts",
  runtime: "dom",
  imports: {},
  styles: [],
  dependencyFiles: {},
};

test("a WASM trap retires the Instance without reentering its allocator", async () => {
  const broken = await WebAssembly.compile(
    await readFile(new URL("../fixtures/runtime/trapping-compiler.wasm", import.meta.url)),
  );

  for (const cooperative of [false, true]) {
    const engine = createEngine(broken, { yieldTask: async () => {} });

    const check = (error) =>
      error.fatal === true && error.cause instanceof WebAssembly.RuntimeError;

    if (cooperative)
      await assert.rejects(
        engine.compileModuleAsync("/a.js", "export {}", "dom", () => false),
        check,
      );
    else assert.throws(() => engine.compileModule("/a.js", "export {}", "dom"), check);
    assert.throws(() => engine.compileModule("/a.js", "export {}", "dom"), /requires restart/);
  }
});

test("shipped compiler is tied to its sources and exports only the explicit host ABI", async () => {
  const manifest = JSON.parse(await readFile(new URL("artifacts/manifest.json", base)));
  const hash = (b) => createHash("sha256").update(b).digest("hex");
  assert.equal(hash(bytes), manifest.sha256);
  for (const [file, digest] of Object.entries(manifest.sources))
    assert.equal(hash(await readFile(new URL(file, base))), digest, file);
  assert.deepEqual(
    WebAssembly.Module.exports(module)
      .map((e) => e.name)
      .sort(),
    ["abi_version", "alloc", "compile_module", "dealloc", "free_result", "memory"],
  );
});

test("Rust diagnostics use UTF-16 columns and rewritten imported identifiers retain original source locations", () => {
  const engine = createEngine(module);
  const compiler = createProjectCompiler(engine, config);

  assert.throws(
    () =>
      compiler.compile({
        "/a.ts": "const 한글 = '😀';\nexport const value = ;",
      }),
    (error) => error.diagnostics[0].line === 2 && error.diagnostics[0].column === 21,
  );

  const source =
    "import {value} from './b.ts';\nconst 한글 = '😀';\nexport const result = value + 한글;";

  const output = compiler.compile({
    "/a.ts": source,
    "/b.ts": "export const value=1",
  });

  const artifact = output.modules["/a.ts"];

  const map = new TraceMap(
    JSON.parse(Buffer.from(output.debug["/a.ts"].sourceMap.split(",")[1], "base64")),
  );

  const index = artifact.code.lastIndexOf(".read()");
  assert.ok(index > 0);
  const prefix = artifact.code.slice(0, index).split("\n");

  const location = originalPositionFor(map, {
    line: prefix.length + 2,
    column: prefix.at(-1).length,
  });

  assert.equal(location.line, 3);
  assert.equal(location.column, 22);
  assert.equal(location.source, "/a.ts");
  compiler.dispose();
});

test("JSPI cancellation, rejected scheduler and reentry release ownership and leave the Instance reusable", async () => {
  let cancel = false;
  let clock = 0;
  let mode = "cancel";
  let reentry = false;
  let engine;
  engine = createEngine(module, {
    now: () => ++clock * 5,
    yieldTask: async () => {
      await new Promise((r) => setImmediate(r));
      assert.throws(
        () => engine.compileModule("/a.ts", "export const value=9", "dom"),
        /reentered/,
      );
      reentry = true;
      if (mode === "cancel") cancel = true;
      if (mode === "reject") throw Error("scheduler failed");
    },
  });
  if (!engine.supportsJSPI) return; // Three-browser integration separately requires the feature.

  const source =
    "export const rows=[" +
    Array.from({ length: 500 }, (_, i) => `{id:${i},label:"row${i}"}`).join(",") +
    "];";

  for (let i = 0; i < 40; i++) {
    cancel = false;
    await assert.rejects(
      engine.compileModuleAsync("/a.ts", source, "dom", () => cancel),
      { name: "AbortError" },
    );
  }
  assert.equal(reentry, true);
  mode = "reject";
  await assert.rejects(
    engine.compileModuleAsync("/a.ts", source, "dom", () => false),
    /scheduler failed/,
  );
  mode = "run";
  const result = await engine.compileModuleAsync("/a.ts", source, "dom", () => false);
  assert.deepEqual(result, engine.compileModule("/a.ts", source, "dom"));
  const size = engine.memoryBytes();
  for (let i = 0; i < 40; i++) engine.compileModule("/a.ts", source, "dom");
  assert.equal(engine.memoryBytes(), size);
});

test("owned outputs survive reuse and late cancellation releases raw maps", async () => {
  let phase = 0;
  let cancelAt = 0;

  const engine = createEngine(module, {
    onCheckpoint: (p) => {
      phase = p;
    },
    yieldTask: async () => {},
  });

  const source =
    "export const rows=[" + Array.from({ length: 3000 }, (_, i) => `"한글😀${i}"`).join(",") + "];";

  const first = engine.compileModule("/한글.js", source, "dom");
  const saved = JSON.stringify(first);
  if (engine.supportsJSPI) {
    cancelAt = 6;
    for (let i = 0; i < 20; i++) {
      phase = 0;
      await assert.rejects(
        engine.compileModuleAsync("/한글.js", source, "dom", () => phase === cancelAt),
        { name: "AbortError" },
      );
    }
  }
  cancelAt = 0;
  for (let i = 0; i < 10; i++)
    assert.throws(() => engine.compileModule("/bad.js", "const =", "dom"));
  const capacity = engine.memoryBytes();
  for (let i = 0; i < 40; i++)
    assert.deepEqual(engine.compileModule("/한글.js", source, "dom"), first);
  assert.equal(engine.memoryBytes(), capacity);
  assert.equal(JSON.stringify(first), saved);
});

test("ABI 3 works when JSPI is unavailable", async () => {
  const suspending = WebAssembly.Suspending;
  const promising = WebAssembly.promising;

  try {
    WebAssembly.Suspending = WebAssembly.promising = undefined;
    const engine = createEngine(module, { yieldTask: async () => {} });
    assert.equal(engine.supportsJSPI, false);
    assert.deepEqual(
      await engine.compileModuleAsync("/a.js", "export const n=1", "dom", () => false),
      engine.compileModule("/a.js", "export const n=1", "dom"),
    );
    await assert.rejects(
      engine.compileModuleAsync("/a.js", "export const n=1", "dom", () => true),
      { name: "AbortError" },
    );
  } finally {
    WebAssembly.Suspending = suspending;
    WebAssembly.promising = promising;
  }
});

test("raw UTF-8 maps agree through native and bounded fallback base64 encoding", () => {
  const engine = createEngine(module);
  const source = "export const 값=" + JSON.stringify("한글😀".repeat(5000)) + ";";
  const native = engine.compileModule("/한글.js", source, "dom");
  const encode = Uint8Array.prototype.toBase64;
  try {
    Uint8Array.prototype.toBase64 = undefined;
    const fallback = engine.compileModule("/한글.js", source, "dom");
    assert.deepEqual(fallback, native);
    const map = JSON.parse(Buffer.from(fallback.sourceMap.split(",")[1], "base64"));
    assert.deepEqual(map.sources, ["/한글.js"]);
    assert.deepEqual(map.sourcesContent, [source]);
  } finally {
    Uint8Array.prototype.toBase64 = encode;
  }
});

test("malformed ABI slices retire the Instance instead of touching invalid ownership", async () => {
  const invalid = await WebAssembly.compile(
    await readFile(new URL("../fixtures/runtime/invalid-compiler-result.wasm", import.meta.url)),
  );

  const engine = createEngine(invalid);
  assert.throws(
    () => engine.compileModule("/a.js", "export {}", "dom"),
    (error) => error.fatal === true && error.cause.message === "Invalid result slice",
  );
  assert.throws(() => engine.compileModule("/a.js", "export {}", "dom"), /requires restart/);
});

test("JSON modules preserve data semantics for __proto__, negative zero, duplicate keys and Unicode", async () => {
  const compiler = createProjectCompiler(createEngine(module), config);

  const runtime = createModuleRuntime(createModulePolicy({}), ({ code }) =>
    compileFunction(`return (${code})`)(),
  );

  const source =
    '{\n "__proto__": {"polluted":true}, "n": -0, "same":1,"same":2, "text": ' +
    JSON.stringify('한글😀 \t " \\ \n') +
    "\n}";

  const files = {
    [config.entry]: 'export {default as data} from "./data.json";',
    "/data.json": source,
  };

  try {
    const result = await runtime.apply(compiler.compile(files), () => {});
    const data = result.entry.data;
    assert.equal(Object.hasOwn(data, "__proto__"), true);
    assert.equal(Object.getPrototypeOf(data), Object.prototype);
    assert.equal(data.polluted, undefined);
    assert.equal(Object.is(data.n, -0), true);
    assert.deepEqual(data, JSON.parse(source));

    const compact = compiler.compile({
      ...files,
      "/data.json": source.replace(/\n/g, ""),
    });

    const unchanged = await runtime.apply(compact, () => {});
    assert.deepEqual(unchanged.evaluated, []);
    assert.throws(() => compiler.compile({ ...files, "/data.json": "{broken" }));

    const primitive = await runtime.apply(
      compiler.compile({ ...files, "/data.json": "-0" }),
      () => {},
    );

    assert.equal(Object.is(primitive.entry.data, -0), true);
  } finally {
    await runtime.dispose();
    compiler.dispose();
  }
});

test("generated module prelude lines preserve source positions for arbitrary string export names", () => {
  const compiler = createProjectCompiler(createEngine(module), config);
  const name = "line\u2028paragraph\u2029name";

  const quoted = JSON.stringify(name)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

  const source = `import { ${quoted} as input } from "./b.ts";\nexport { input as ${quoted} };\nexport const marker = input + 7;`;
  try {
    const result = compiler.compile({
      "/a.ts": source,
      "/b.ts": `const value = 2; export { value as ${quoted} };`,
    });

    const code = result.modules["/a.ts"].code;
    const lines = code.slice(0, code.lastIndexOf(".read()")).split(/\r\n|[\n\r\u2028\u2029]/);

    const map = new TraceMap(
      JSON.parse(Buffer.from(result.debug["/a.ts"].sourceMap.split(",")[1], "base64")),
    );

    const pos = originalPositionFor(map, { line: lines.length + 2, column: lines.at(-1).length });
    assert.deepEqual(
      [pos.source, pos.line, pos.column],
      ["/a.ts", 3, source.split("\n")[2].indexOf("input")],
    );
    assert.ok(code.includes(quoted));
  } finally {
    compiler.dispose();
  }
});
