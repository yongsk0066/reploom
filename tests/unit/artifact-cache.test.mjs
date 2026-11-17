import test from "node:test";
import assert from "node:assert/strict";
import { createArtifactStore } from "../../packages/runtime/src/compiler/artifact-cache.ts";
import { createProjectCompiler } from "../../packages/runtime/src/compiler/project-compiler.ts";
import { createCompilerService } from "../../packages/runtime/src/compiler/service.ts";
import { PROTOCOL } from "../../packages/runtime/src/shared/protocol.ts";
import * as nativeOxc from "oxc-transform";
import { createReferenceEngine } from "../reference/reference-engine.ts";

const engine = createReferenceEngine(nativeOxc);

const config = {
  key: "budget",
  entry: "/a.js",
  runtime: "dom",
  styles: [],
  imports: {},
  dependencyFiles: {},
};

const tick = () => new Promise((r) => setImmediate(r));

test("shared LRU isolates namespaces and keeps the global bound even when each project is below its own limit", () => {
  const store = createArtifactStore({ bytes: 1000, entries: 3 });

  const a = store.scope();
  const b = store.scope();
  const c = store.scope();

  const artifact = (code) => ({
    id: "/a.js",
    kind: "js",
    code,
    specifiers: [],
    dynamic: [],
  });

  a.set("/a.js", "same", artifact("a"));
  b.set("/a.js", "same", artifact("b"));
  c.set("/a.js", "same", artifact("c"));
  assert.equal(a.get("/a.js", "same").code, "a");
  c.set("/b.js", "new", artifact("d"));
  assert.equal(b.get("/a.js", "same"), undefined);
  assert.equal(a.get("/a.js", "same").code, "a");
  c.set("/large.js", "large", artifact("x".repeat(430)));
  assert.ok(store.stats().retainedBytes <= 1000);
  assert.ok(store.stats().entries <= 3);
  c.prune({});
  a.clear();
  b.clear();
  assert.equal(store.stats().retainedBytes, 0);
  assert.equal(store.stats().entries, 0);
});

test("cross-project eviction changes only reuse: exact recompilation and emitted graphs survive", () => {
  const store = createArtifactStore({ bytes: 14000, entries: 32 });

  const compilers = Array.from({ length: 8 }, () =>
    createProjectCompiler(engine, config, undefined, undefined, store.scope()),
  );

  const inputs = compilers.map((_, i) => ({
    "/a.js": `export const value=${i};\n/*${"x".repeat(1400)}*/`,
  }));

  const programs = compilers.map((compiler, i) => {
    const program = compiler.compile(inputs[i]);
    assert.ok(store.stats().retainedBytes <= 14000);
    return program;
  });

  assert.ok(store.stats().evictions > 0);
  assert.equal(programs[0].modules["/a.js"].code.includes("value = 0"), true);
  const again = compilers[0].compile(inputs[0]);
  assert.deepEqual(again.modules, programs[0].modules);
  assert.deepEqual(again.transformed, ["/a.js"]);
  compilers.forEach((c) => c.dispose());
  assert.equal(store.stats().retainedBytes, 0);
});

test("shared service accounts cancelled work and releases caches without discarding other projects' results", async () => {
  let clock = 0;
  let release;
  let first = true;

  const replies = [];
  const order = [];

  const gate = new Promise((r) => (release = r));

  const asyncEngine = {
    ...engine,
    async compileModuleAsync(id, source, runtime, cancelled) {
      order.push(source);
      if (first) {
        first = false;
        await gate;
        clock += 30;
      }
      if (cancelled()) throw new DOMException("Aborted", "AbortError");
      clock += 5;
      return engine.compileModule(id, source, runtime);
    },
  };

  const service = createCompilerService(
    {
      loadEngine: async () => asyncEngine,
      reply: (r) => replies.push(r),
      yieldTask: tick,
      now: () => clock,
    },
    { bytes: 2000, entries: 2 },
  );

  const command = (projectId, value, revision = 1, baseRevision = null) => ({
    protocol: PROTOCOL,
    type: "compile",
    id: projectId + revision,
    projectId,
    revision,
    baseRevision,
    changes: { "/a.js": `export const value=${value}` },
    config,
    compiler: { url: "/c", sha256: "c" },
    priority: "visible",
  });

  service.receive(command("large", 1));
  for (let i = 0; i < 20 && first; i++) await tick();
  assert.equal(first, false);
  service.receive(command("small", 2));
  service.receive(command("large", 3, 2, 1));
  release();
  for (let i = 0; i < 60 && replies.length < 2; i++) await tick();
  assert.deepEqual(
    replies.map((r) => r.id),
    ["small1", "large2"],
  );
  assert.equal(
    replies.every((r) => r.ok),
    true,
  );
  assert.ok(service.stats().cache.retainedBytes <= 2000);
  assert.ok(service.stats().emittedCharacters > 0);
  service.dispose();
  assert.deepEqual(service.stats(), {
    projects: 0,
    cache: {
      retainedBytes: 0,
      entries: 0,
      evictions: service.stats().cache.evictions,
    },
    sourceCharacters: 0,
    emittedCharacters: 0,
  });
});
