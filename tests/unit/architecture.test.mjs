import test from "node:test";
import assert from "node:assert/strict";
import {
  composeTextPatch,
  applySourceChanges,
} from "../../packages/runtime/src/shared/source-patch.ts";
import {
  createArtifactPublisher,
  createArtifactReceiver,
} from "../../packages/runtime/src/shared/artifact-channel.ts";
import { createRealmResources } from "../../packages/runtime/src/execution/resources.ts";
import { createProjectCompiler } from "../../packages/runtime/src/compiler/project-compiler.ts";
import { createModuleRuntime } from "../../packages/runtime/src/execution/module-runtime.ts";
import { createModulePolicy } from "../../packages/runtime/src/execution/adapters/policy.ts";
import { createEngine } from "../../crates/compiler/engine.mjs";
import { readFile } from "node:fs/promises";
import { sameExecution } from "../../packages/runtime/src/shared/protocol.ts";

test("module reuse is tied to the source and resolution shape, including overlapping jobs", () => {
  const engine = {
    compilerVersion: "test",
    compileModule(id, source) {
      return {
        id,
        kind: "js",
        code: source,
        specifiers: id === "/main.js" ? ["./data.js"] : [],
        dynamic: [],
      };
    },
  };

  const compiler = createProjectCompiler(engine, {
    key: "shape",
    runtime: "dom",
    entry: "/main.js",
    imports: {},
    styles: [],
    dependencyFiles: {},
  });

  try {
    const files = { "/main.js": "import data", "/data.js": "first" };
    const first = compiler.compile(files);
    assert.throws(() => {
      first.modules["/main.js"].code = "poison";
    }, TypeError);
    assert.throws(() => {
      first.modules["/main.js"].imports["./data.js"] = "/other.js";
    }, TypeError);
    assert.throws(() => first.modules["/main.js"].dependencies.push("/other.js"), TypeError);
    const next = compiler.compile({ ...files, "/data.js": "second" });
    assert.equal(next.modules["/main.js"], first.modules["/main.js"]);
    assert.notEqual(next.modules["/data.js"], first.modules["/data.js"]);
    assert.throws(() => compiler.compile({ "/main.js": "import data" }), /data\.js/);
    const suspended = compiler.createJob(files);
    suspended.step();
    compiler.compile({ ...files, "/extra.js": "other graph" });
    let step;
    do {
      step = suspended.step();
    } while (!step.done);
    assert.deepEqual(Object.keys(step.value.modules).sort(), Object.keys(files).sort());
    assert.equal(step.value.modules["/main.js"].imports["./data.js"], "/data.js");
  } finally {
    compiler.dispose();
  }
});

test("execution equivalence ignores import key insertion order while preserving targets", () => {
  const module = {
    id: "/a.js",
    kind: "js",
    code: "same",
    imports: { first: "/a", second: "/b" },
    dependencies: ["/a", "/b"],
    dynamicDependencies: [],
  };

  assert.equal(sameExecution(module, { ...module, imports: { second: "/b", first: "/a" } }), true);
  assert.equal(sameExecution(module, { ...module, imports: { second: "/c", first: "/a" } }), false);
});

const apply = (text, patch) => applySourceChanges({ "/a": text }, { "/a": patch })["/a"];
test("operation composition matches sequential Unicode/multi-cursor edits without reading the base", () => {
  let seed = 0x51a7;
  const random = (n) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
  for (let trial = 0; trial < 300; trial++) {
    const base = trial % 2 ? "ab😀한글\ud800Z".repeat(random(20)) : "";
    let text = base;
    let patch = { baseLength: base.length, edits: [] };
    for (let step = 0; step < 30; step++) {
      const points = Array.from({ length: 2 + random(8) }, () => random(text.length + 1)).sort(
        (a, b) => a - b,
      );

      const edits = [];
      for (let i = 1; i < points.length; i += 2)
        edits.push({
          from: points[i - 1],
          to: points[i],
          insert: ["", "X", "한😀", "\ud800", "\n"][random(5)],
        });
      text = apply(text, { baseLength: text.length, edits });
      patch = composeTextPatch(patch, edits);
      assert.equal(apply(base, patch), text, `trial ${trial}, step ${step}`);
    }
  }
  assert.throws(() => composeTextPatch({ baseLength: -1, edits: [] }, []), /base/);
  assert.throws(
    () => apply("abc", { baseLength: 3, edits: [{ from: 2, to: 1, insert: "" }] }),
    /range/,
  );
});

test("direct artifact channel supports skipped revisions, reconnect, full resync and bounded lifetime", async (t) => {
  const program = {
    schema: 8,
    abi: 4,
    compilerVersion: "test",
    projectKey: "same",
    runtime: "dom",
    entry: "/a.js",
    styles: [],
    transformed: [],
    modules: {
      "/a.js": {
        id: "/a.js",
        kind: "js",
        code: "one",
        imports: {},
        dependencies: [],
        dynamicDependencies: [],
      },
    },
  };

  let current = { revision: 1, program };

  const publisher = createArtifactPublisher((id) => (id === "a" ? current : undefined));
  const receiver = createArtifactReceiver();

  t.after(() => {
    receiver.dispose();
    publisher.dispose();
  });

  const connect = (generation) => {
    const { port1, port2 } = new MessageChannel();
    publisher.connect("a", generation, port1);
    receiver.connect(port2);
  };

  connect("first");
  const first = await receiver.get(1, null);
  assert.equal(first.baseRevision, null);
  current = {
    revision: 5,
    program: {
      ...program,
      modules: {
        ...program.modules,
        "/b.json": {
          id: "/b.json",
          kind: "json",
          data: "[]",
          imports: {},
          dependencies: [],
          dynamicDependencies: [],
        },
      },
    },
  };
  const next = await receiver.get(5, 1);
  assert.equal(next.baseRevision, 1);
  assert.equal((await receiver.get(5, 5)).baseRevision, null);
  assert.deepEqual(Object.keys(next.changed), ["/b.json"]);
  await assert.rejects(receiver.get(1, 1), { reason: "superseded" });
  await assert.rejects(receiver.get(6, 5), { reason: "missing" });
  assert.equal((await receiver.get(5, 999)).baseRevision, null);
  connect("second");
  publisher.disconnect("a", "first"); // stale cleanup cannot close the new lease
  assert.equal((await receiver.get(5, 5)).baseRevision, null);
  publisher.disconnect("a", "second");
  const pending = receiver.get(6, 5);
  receiver.dispose();
  await assert.rejects(pending, /disposed/);
});

test("resource scope keeps old debug maps valid within a hard budget and releases assets/Workers", async (t) => {
  const original = globalThis.Worker;
  const terminated = [];

  globalThis.Worker = class {
    constructor(url) {
      this.url = url;
    }

    terminate() {
      terminated.push(this);
    }
  };
  t.after(() => {
    globalThis.Worker = original;
  });

  const type = "text/javascript";
  const bytes = new TextEncoder().encode("onmessage=e=>postMessage(e.data)");

  const scope = createRealmResources(
    {
      assets: { "/worker.js": { url: "/local", sha256: "test", type } },
      workers: 1,
      debugMaps: { mode: "external", bytes: 128, entries: 1 },
    },
    { "/worker.js": { type, bytes } },
  );

  t.after(() => scope.dispose());

  const map =
    "data:application/json;base64," +
    Buffer.from('{"version":3,"sources":["old.ts"],"mappings":""}').toString("base64");

  const url = scope.sourceMap(map);
  assert.match(url, /^blob:/);
  assert.equal(scope.sourceMap(map), map);
  assert.equal((await (await fetch(url)).json()).sources[0], "old.ts");
  const asset = scope.access.asset("/worker.js");
  assert.equal(scope.access.asset("/worker.js"), asset);
  const worker = scope.access.worker("/worker.js");
  assert.throws(() => scope.access.worker("/worker.js"), /limit/);
  worker.terminate();
  const live = scope.access.worker("/worker.js");
  live.terminate = () => {
    throw Error("user override");
  };
  assert.throws(() => scope.access.asset("/other.js"), /Undeclared/);
  scope.dispose();
  scope.dispose();
  assert.equal(terminated.length, 2);
  await assert.rejects(fetch(url));
  await assert.rejects(fetch(asset));
  assert.throws(() => scope.access.asset("/worker.js"), /disposed/);
  assert.deepEqual(scope.stats(), {
    mapBytes: 0,
    mapEntries: 0,
    inlineMaps: 1,
    assetURLs: 0,
    workers: 0,
  });
  const denied = createRealmResources();
  assert.throws(() => new Worker("blob:local"), /limit/);
  denied.dispose();
});

test("JSON is data, skips JS transforms, preserves shared default identity and propagates changes", async (t) => {
  const wasm = await WebAssembly.compile(
    await readFile(new URL("../../crates/compiler/artifacts/compiler.wasm", import.meta.url)),
  );

  const engine = createEngine(wasm);
  const transforms = [];

  const compiler = createProjectCompiler(
    {
      ...engine,
      compileModule(...args) {
        transforms.push(args[0]);
        return engine.compileModule(...args);
      },
    },
    {
      key: "json",
      runtime: "dom",
      entry: "/a.js",
      imports: {},
      styles: [],
      dependencyFiles: {},
    },
  );

  const runtime = createModuleRuntime(createModulePolicy({}), async (module) => {
    assert.equal(module.kind, "js");
    return (
      await import(
        `data:text/javascript;base64,${Buffer.from("export default " + module.code).toString("base64")}`
      )
    ).default;
  });

  t.after(async () => {
    await runtime.dispose();
    compiler.dispose();
  });

  const files = {
    "/a.js":
      "import a from './data.json'; import b from './other.js'; export const value=[a,b]; export function mount(){}",
    "/other.js": "import a from './data.json'; export default a;",
    "/data.json": '{ "a": -0, "__proto__": {"x": 1}, "duplicate": 1, "duplicate": 2 }',
  };

  const first = compiler.compile(files);
  const count = transforms.length;

  assert.equal(first.modules["/data.json"].kind, "json");
  assert.equal("code" in first.modules["/data.json"], false);

  const run = await runtime.apply(first, () => {});
  const [a, b] = run.entry.value;

  assert.equal(a, b);
  assert.equal(Object.is(a.a, -0), true);
  assert.equal(a.duplicate, 2);
  assert.equal(Object.hasOwn(a, "__proto__"), true);
  a.changed = true;
  assert.equal(b.changed, true);
  const next = compiler.compile({ ...files, "/data.json": '{"a":42}' });
  assert.equal(transforms.length, count);
  const second = await runtime.apply(next, () => {});
  assert.equal(second.entry.value[0].a, 42);
  assert.equal(second.entry.value[0], second.entry.value[1]);
  assert.notEqual(second.entry.value[0], a);
});
