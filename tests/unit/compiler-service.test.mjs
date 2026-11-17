import test from "node:test";
import assert from "node:assert/strict";
import * as nativeOxc from "oxc-transform";
import { createReferenceEngine } from "../reference/reference-engine.ts";

const oxc = createReferenceEngine(nativeOxc);
import { createCompilerService } from "../../packages/runtime/src/compiler/service.ts";
import { createProjectCompiler } from "../../packages/runtime/src/compiler/project-compiler.ts";
import { PROTOCOL } from "../../packages/runtime/src/shared/protocol.ts";
import {
  sourceChange,
  applySourceChanges,
} from "../../packages/runtime/src/shared/source-patch.ts";
import { ProjectSession } from "../../packages/runtime/src/project/session.ts";

const config = {
  key: "jobs",
  runtime: "dom",
  entry: "/a.js",
  styles: [],
  imports: {},
  dependencyFiles: {},
};

const command = (projectId, files, revision = 1, baseRevision = null) => ({
  protocol: PROTOCOL,
  type: "compile",
  id: `${projectId}-${revision}`,
  projectId,
  revision,
  baseRevision,
  changes: files,
  compiler: { url: "/compiler", sha256: "test" },
  config,
  priority: "visible",
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("module scheduling admits a small project before the large project completes and eventually finishes both", async () => {
  let now = 0;
  let service;
  let started = false;

  const order = [];
  const replies = [];

  const engine = {
    transformSync(...args) {
      order.push(args[0]);
      now += 6;
      return nativeOxc.transformSync(...args);
    },
  };

  service = createCompilerService({
    now: () => now,
    loadEngine: async () => createReferenceEngine(engine),
    reply: (r) => replies.push(r),
    yieldTask: async () => {
      await tick();
      if (order.length === 1 && !started) {
        started = true;
        service.receive(command("small", { "/a.js": "export const small=1" }));
      }
    },
  });
  service.receive(
    command("large", {
      "/a.js": "export const a=1",
      "/b.js": "export const b=1",
      "/c.js": "export const c=1",
      "/d.js": "export const d=1",
    }),
  );
  for (let i = 0; i < 30 && replies.length < 2; i++) await tick();
  assert.deepEqual(
    replies.map((r) => r.projectId),
    ["small", "large"],
  );
  assert.equal(order.length, 5);
  assert.equal(
    replies.every((r) => r.ok),
    true,
  );
  service.dispose();
});

test("all cancelled source patches apply; only the newest complete graph publishes; completed transforms survive", async () => {
  let now = 0;
  let service;
  let injected = false;

  const calls = [];
  const replies = [];

  const engine = {
    transformSync(...args) {
      calls.push(args[0]);
      now += 6;
      return nativeOxc.transformSync(...args);
    },
  };

  service = createCompilerService({
    now: () => now,
    loadEngine: async () => createReferenceEngine(engine),
    reply: (r) => replies.push(r),
    yieldTask: async () => {
      await tick();
      if (calls.length === 1 && !injected) {
        injected = true;
        service.receive({
          protocol: PROTOCOL,
          type: "cancel",
          projectId: "p",
          id: "p-1",
        });
        service.receive(command("p", { "/b.js": "export const b=2" }, 2, 1));
        service.receive({
          protocol: PROTOCOL,
          type: "cancel",
          projectId: "p",
          id: "p-2",
        });
        service.receive(command("p", { "/c.js": "export const c=3" }, 3, 2));
      }
    },
  });

  const files = {
    "/a.js": "export const a=1",
    "/b.js": "export const b=1",
    "/c.js": "export const c=1",
  };

  service.receive(command("p", files));
  for (let i = 0; i < 30 && !replies.length; i++) await tick();
  assert.deepEqual(
    replies.map((r) => r.id),
    ["p-3"],
  );
  assert.deepEqual(calls, ["/a.js", "/b.js", "/c.js"]);
  const clean = createProjectCompiler(oxc, config);
  assert.deepEqual(replies[0].patch.changed, {
    ...clean.compile({
      ...files,
      "/b.js": "export const b=2",
      "/c.js": "export const c=3",
    }).modules,
  });
  clean.dispose();
  service.dispose();
});

test("job snapshots, cache budgets and disposal bound cancelled work without changing clean results", () => {
  const compiler = createProjectCompiler(oxc, config, undefined, {
    bytes: 4000,
    entries: 2,
  });

  const files = { "/a.js": "export const a=1", "/b.js": "export const b=1" };
  const job = compiler.createJob(files);
  job.step();
  files["/b.js"] = "export const b=2";
  job.step();
  const result = job.step().value;
  const clean = createProjectCompiler(oxc, config);
  assert.deepEqual(
    result.modules,
    clean.compile({ "/a.js": "export const a=1", "/b.js": "export const b=1" }).modules,
  );
  for (let i = 0; i < 100; i++) {
    const abandoned = compiler.createJob({ "/a.js": `export const a=${i}` });
    abandoned.step();
    abandoned.dispose();
  }
  assert.ok(compiler.stats().retainedBytes <= 4000);
  assert.ok(compiler.stats().entries <= 2);
  assert.equal(compiler.stats().jobs, 0);
  const pending = compiler.createJob(files);
  compiler.dispose();
  assert.throws(() => pending.step(), { name: "AbortError" });
  assert.equal(compiler.stats().retainedBytes, 0);
  clean.dispose();
});

test("UTF-16 source patches preserve Unicode, lone surrogates, sequential edits and atomic rejection", () => {
  let source = "한글😀\ud800\udfff" + "abc\n".repeat(1000);
  let files = { "/a.js": source };
  let seed = 42;

  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };

  for (let i = 0; i < 500; i++) {
    const at = random() % (source.length + 1);
    const count = random() % 8;
    const insert = ["", "값", "😀", "\ud800", "\udfff", "\n"][random() % 6];

    const next = source.slice(0, at) + insert + source.slice(at + count);
    files = applySourceChanges(files, { "/a.js": sourceChange(source, next) });
    assert.equal(files["/a.js"], next);
    source = next;
  }
  assert.throws(
    () =>
      applySourceChanges(files, {
        "/b.js": "new",
        "/a.js": { from: 0, to: 1, insert: "x", baseLength: 0 },
      }),
    /mismatch/,
  );
  assert.equal(files["/b.js"], undefined);
});

test("selected stores notify every subscriber once and ignore unrelated state", async () => {
  const compiler = createProjectCompiler(oxc, config);
  const files = { "/a.js": "export const a=1" };
  const output = compiler.compile(files);

  const session = new ProjectSession("test", {
    newId: () => "test",
    schedule: () => () => {},
    compiler: { compile: async () => ({ ok: true, output }), release() {} },
    loadProject: async () => ({
      files,
      output,
      vendor: [],
      bootstrap: "",
      updateDelayMs: 0,
      compilerResources: async () => ({ compiler: {}, config }),
    }),
  });

  const selected = session.observe((v) => v.snapshot);
  let one = 0;
  let two = 0;

  const u1 = selected.subscribe(() => one++);
  const u2 = selected.subscribe(() => two++);

  await session.start();
  assert.equal(one, 1);
  assert.equal(two, 1);
  session.change("/a.js", "next");
  assert.equal(one, 1);
  assert.equal(two, 1);
  session.onEvent({ type: "console", revision: 1, text: "log" });
  assert.equal(one, 1);
  session.reset();
  assert.equal(one, 2);
  assert.equal(two, 2);
  u1();
  u2();
  session.dispose();
  compiler.dispose();
});
