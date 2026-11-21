import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileFunction } from "node:vm";
import { createEngine } from "../../crates/compiler/engine.mjs";
import { createProjectCompiler } from "../../packages/runtime/src/compiler/project-compiler.ts";
import { createModuleRuntime } from "../../packages/runtime/src/execution/module-runtime.ts";
import { createModulePolicy } from "../../packages/runtime/src/execution/adapters/policy.ts";
import { createReactPolicy } from "../../packages/runtime/src/execution/adapters/react.ts";
import { ownCompilerConfig } from "../../packages/runtime/src/project/definition.ts";
import { cloneState, readArchive } from "../../packages/runtime/src/project/snapshot.ts";
import { ProjectSession } from "../../packages/runtime/src/project/session.ts";
import { createCompilerClient } from "../../packages/runtime/src/browser/compiler-client.ts";
import {
  PROTOCOL,
  diffProgram,
  programReference,
} from "../../packages/runtime/src/shared/protocol.ts";
import { createDebugLocations } from "../../packages/runtime/src/execution/debug-locations.ts";
import { createValidationLane } from "../../packages/runtime/src/browser/validation.ts";
import Refresh from "react-refresh/runtime";
import React from "react";

const module = await WebAssembly.compile(
  await readFile(new URL("../../crates/compiler/artifacts/compiler.wasm", import.meta.url)),
);

const config = {
  key: "revisions",
  runtime: "dom",
  entry: "/main.ts",
  imports: {},
  styles: [],
  dependencyFiles: {},
};

const load = ({ code }) => compileFunction(`return (${code})`)();

test("compiler configuration owns nested inputs for its complete lifetime", () => {
  const input = {
    ...config,
    imports: { lib: "vendor:original" },
    resources: {
      assets: { "/a.png": { url: "/a", sha256: "hash", type: "image/png" } },
      workers: 0,
      debugMaps: { mode: "inline", bytes: 4096, entries: 8 },
    },
  };

  const owned = ownCompilerConfig(input);
  const compiler = createProjectCompiler(createEngine(module), input);
  input.imports.lib = "vendor:mutated";
  input.resources.assets["/a.png"].url = "/changed";
  assert.equal(owned.resources.assets["/a.png"].url, "/a");
  assert.throws(() => {
    owned.imports.lib = "changed";
  }, TypeError);
  const output = compiler.compile({ "/main.ts": "import { value } from 'lib'; export { value };" });
  assert.equal(output.modules["/main.ts"].imports.lib, "vendor:original");
  compiler.dispose();
});

test("Rust named cells preserve receivers, live bindings and retired cleanup observations", async () => {
  const compiler = createProjectCompiler(createEngine(module), config);
  const runtime = createModuleRuntime(createModulePolicy({}), load);
  globalThis.__cellLog = [];

  const files = {
    "/main.ts":
      "import { value, bump, receiver, then } from './value.ts'; import.meta.hot.dispose(() => globalThis.__cellLog.push(value)); export const read = () => [value, receiver(), then]; export { bump };",
    "/value.ts":
      "export let value=1; export function bump(){value++} export function receiver(){return this} export const then=7;",
  };

  try {
    const first = await runtime.apply(compiler.compile(files), () => {});
    const old = first.entry.read;
    first.entry.bump();
    assert.deepEqual(old(), [2, undefined, 7]);
    assert.match(compiler.compile(files).modules["/main.ts"].code, /_slot[0-9]+\.read\(/);
    await runtime.apply(
      compiler.compile({ ...files, "/value.ts": files["/value.ts"].replace("value=1", "value=8") }),
      () => {},
    );
    assert.deepEqual(globalThis.__cellLog, [2]);
    assert.deepEqual(old(), [2, undefined, 7]);
    await assert.rejects(
      runtime.apply(
        compiler.compile({
          ...files,
          "/value.ts":
            "throw new Error('candidate failed'); export const value=100; export function bump(){} export function receiver(){} export const then=7;",
        }),
        () => {},
      ),
      /candidate failed/,
    );
  } finally {
    await runtime.dispose();
    compiler.dispose();
    delete globalThis.__cellLog;
  }
});

test("managed state is explicit, isolated during evaluation and portable across realms", async () => {
  const compiler = createProjectCompiler(createEngine(module), config);
  const policy = () => createModulePolicy({});
  const runtime = createModuleRuntime(policy(), load);
  let restored;

  const source =
    "const count=import.meta.state('count', 0); export const bump=()=>++count.value; export const read=()=>count.value;";

  try {
    const result = await runtime.apply(compiler.compile({ "/main.ts": source }), () => {});
    result.entry.bump();
    await assert.rejects(
      runtime.apply(
        compiler.compile({ "/main.ts": source + "count.value=100; throw Error('reject');" }),
        () => {},
      ),
    );
    assert.equal(runtime.captureState()["/main.ts"].count, 1);
    restored = createModuleRuntime(
      policy(),
      load,
      undefined,
      undefined,
      undefined,
      undefined,
      runtime.captureState(),
    );
    const next = await restored.apply(compiler.compile({ "/main.ts": source }), () => {});
    assert.equal(next.entry.read(), 1);
    assert.equal(next.entry.bump(), 2);
    assert.equal(result.entry.read(), 1);
    assert.throws(
      () =>
        cloneState({
          get value() {
            throw Error("getter invoked");
          },
        }),
      /accessors/,
    );
    const cycle = {};
    cycle.self = cycle;
    assert.throws(() => cloneState(cycle), /cycles/);
    const sparse = [];
    sparse.length = 10000;
    assert.throws(() => cloneState(sparse), /dense/);
    assert.throws(() => cloneState({ x: Infinity }), /finite/);
  } finally {
    await runtime.dispose();
    await restored?.dispose();
    compiler.dispose();
  }
});

test("then exports remain visible to static namespaces and follow native dynamic-import assimilation", async () => {
  const compiler = createProjectCompiler(createEngine(module), config);
  const runtime = createModuleRuntime(createModulePolicy({}), load);
  try {
    const result = await runtime.apply(
      compiler.compile({
        "/main.ts":
          "import {then,calls} from './then.ts'; import * as ns from './then.ts'; export const read=()=>[then===ns.then,calls]; export const lazy=()=>import('./then.ts');",
        "/then.ts":
          "export let calls=0; export function then(resolve){calls++; resolve('assimilated')}",
      }),
      () => {},
    );

    assert.deepEqual(result.entry.read(), [true, 0]);
    assert.equal(await result.entry.lazy(), "assimilated");
    assert.deepEqual(result.entry.read(), [true, 1]);
  } finally {
    await runtime.dispose();
    compiler.dispose();
  }
});

test("React boundaries compare previous and next constants and compound component exports", () => {
  const policy = createReactPolicy({ react: React }, Refresh);
  const Before = function Widget() {};
  const After = function Widget() {};
  Before.Item = function Item() {};
  After.Item = function Item() {};
  assert.equal(
    policy.canAccept({ Widget: Before, label: "stable" }, { Widget: After, label: "stable" }),
    true,
  );
  assert.equal(
    policy.canAccept({ Widget: Before, label: "old" }, { Widget: After, label: "new" }),
    false,
  );
  assert.equal(policy.canAccept({ Widget: Before }, { Widget: After, added: 1 }), false);
  assert.equal(policy.canAccept({ Widget: Before, data: {} }, { Widget: After, data: {} }), false);
  Object.defineProperty(Before, "hiddenValue", {
    enumerable: true,
    get() {
      throw Error("getter must not run");
    },
  });
  After.hiddenValue = undefined;
  assert.equal(policy.canAccept({ Widget: Before }, { Widget: After }), false);
  policy.dispose();
});

test("file transactions publish one revision; archive restore and checks reject stale results", async () => {
  const compiler = createProjectCompiler(createEngine(module), config);
  const files = { "/main.ts": "export const value=1;", "/helper.ts": "export const x=1;" };
  const output = compiler.compile(files);
  let id = 0;
  let scheduled;
  let checkSignal;
  let finishCheck;

  const session = new ProjectSession("demo", {
    newId: () => String(++id),
    schedule(task) {
      scheduled = task;
      return () => {
        scheduled = undefined;
      };
    },
    loadProject: async () => ({
      files,
      output,
      bootstrap: "",
      vendor: [],
      updateDelayMs: 0,
      typecheck: true,
      compilerResources: async () => ({ config, compiler: { url: "/oxc", sha256: "hash" } }),
    }),
    compiler: {
      compile: async (input) => ({ ok: true, output: compiler.compile(input.files) }),
      release() {},
    },
    validation: {
      tests: async () => [],
      types(_files, signal) {
        checkSignal = signal;
        return new Promise((resolve) => {
          finishCheck = resolve;
        });
      },
    },
  });

  try {
    await session.start();
    let notifications = 0;
    session.subscribe(() => notifications++);
    session.transaction([
      { type: "move", from: "/helper.ts", to: "/renamed.ts" },
      { type: "write", path: "/main.ts", source: "import {x} from './renamed.ts'; export {x};" },
    ]);
    assert.equal(notifications, 1);
    const revision = session.getSnapshot().revision;
    assert.throws(() => session.transaction([{ type: "remove", path: "/main.ts" }]));
    assert.equal(session.getSnapshot().revision, revision);
    const archive = session.exportProject();
    assert.throws(() =>
      readArchive({ ...archive, projectKey: "wrong" }, "demo", config.key, config.entry),
    );
    const checking = session.check("types");
    session.change("/main.ts", "export const next=2");
    assert.equal(checkSignal.aborted, true);
    finishCheck([{ text: "obsolete" }]);
    await assert.rejects(checking, { name: "AbortError" });
    assert.equal(session.getSnapshot().checks, undefined);
    session.restore(archive);
    scheduled();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session.getSnapshot().files["/main.ts"], archive.files["/main.ts"]);
    assert.equal(session.reveal({ file: "/renamed.ts", revision, line: 1 }), false);
    assert.equal(
      session.reveal({ file: "/renamed.ts", revision: session.getSnapshot().revision, line: 1 }),
      true,
    );
  } finally {
    session.dispose();
    compiler.dispose();
  }
});

test("project source resync leaves another project alive and retries only once", async () => {
  const workers = [];

  const client = createCompilerClient(() => {
    const worker = {
      messages: [],
      postMessage(data) {
        this.messages.push(data);
      },
      terminate() {
        this.dead = true;
      },
    };

    workers.push(worker);
    return worker;
  });

  const compiler = createProjectCompiler(createEngine(module), config);
  const files = { "/main.ts": "export const value=1" };
  const output = compiler.compile(files);

  const request = (projectId) => ({
    projectId,
    revision: 1,
    files,
    config,
    compiler: { url: "/oxc", sha256: "hash" },
    seed: { files, output },
  });

  try {
    const a = client.compile(request("a"), new AbortController().signal);
    const b = client.compile(request("b"), new AbortController().signal);
    const worker = workers[0];
    const commands = worker.messages.filter((m) => m.type === "compile");
    worker.onmessage({
      data: {
        protocol: PROTOCOL,
        projectId: "a",
        id: commands[0].id,
        ok: false,
        failure: "source-resync",
        errors: [{ text: "gap" }],
      },
    });
    const retry = worker.messages.at(-1);
    assert.equal(retry.baseRevision, null);
    assert.deepEqual(retry.changes, files);
    assert.equal(worker.dead, undefined);
    worker.onmessage({
      data: {
        protocol: PROTOCOL,
        projectId: "b",
        id: commands[1].id,
        ok: true,
        patch: diffProgram(undefined, { revision: 1, program: output }),
      },
    });
    assert.equal((await b).ok, true);
    worker.onmessage({
      data: {
        protocol: PROTOCOL,
        projectId: "a",
        id: retry.id,
        ok: false,
        failure: "source-resync",
        errors: [{ text: "gap again" }],
      },
    });
    await assert.rejects(a, /resynchronization failed/);
    assert.equal(workers.length, 1);
  } finally {
    client.dispose();
    compiler.dispose();
  }
});

test("compiler rollover waits for preview acknowledgements and reseeds after retirement", async () => {
  const workers = [];
  const ports = [];

  const client = createCompilerClient(
    () => {
      const worker = {
        messages: [],
        postMessage(data) {
          this.messages.push(data);
        },
        terminate() {
          this.dead = true;
        },
      };

      workers.push(worker);
      return worker;
    },
    { maxMemoryBytes: 1, minLifetimeMs: 0 },
  );

  const compiler = createProjectCompiler(createEngine(module), config);
  const files = { "/main.ts": "export const value=1" };
  const output = compiler.compile(files);

  const connection = client.connectPreview("a", "generation", () => {
    const channel = new MessageChannel();
    ports.push(channel.port1, channel.port2);
    return channel.port1;
  });

  const request = {
    projectId: "a",
    files,
    config,
    compiler: { url: "/oxc", sha256: "hash" },
    seed: { files, output },
  };

  function reply() {
    const worker = workers.at(-1);
    const command = worker.messages.findLast((m) => m.type === "compile");
    worker.onmessage({
      data: {
        protocol: PROTOCOL,
        projectId: "a",
        id: command.id,
        ok: true,
        reference: programReference(output),
        memoryBytes: 100,
      },
    });
    return command;
  }

  try {
    let job = client.compile({ ...request, revision: 1 }, new AbortController().signal);
    reply();
    await job;
    job = client.compile({ ...request, revision: 2 }, new AbortController().signal);
    reply();
    await job;
    assert.equal(workers.length, 1);
    connection.acknowledge(1);
    job = client.compile({ ...request, revision: 3 }, new AbortController().signal);
    reply();
    await job;
    assert.equal(workers.length, 1);
    connection.acknowledge(3);
    job = client.compile({ ...request, revision: 4 }, new AbortController().signal);
    assert.equal(reply().baseRevision, null);
    await job;
    assert.equal(workers.length, 2);
    assert.equal(workers[0].dead, true);
  } finally {
    connection.close();
    client.dispose();
    compiler.dispose();
    for (const port of ports) port.close();
  }
});

test("debug locations skip unknown and unmapped stack frames during inspections", () => {
  const debug = createDebugLocations();
  const artifact = { kind: "js", id: "/source.ts", code: "sample()" };

  const map = Buffer.from(
    JSON.stringify({ version: 3, names: [], sources: ["/source.ts"], mappings: "AAAA" }),
  ).toString("base64");

  debug.register(1, artifact, { sourceMap: "data:application/json;base64," + map });
  debug.alias(1, "blob:null/mapped", () => {});
  const text = "at blob:null/unknown:1:1\nat blob:null/mapped:20:1\nat blob:null/mapped:1:1";

  const result = debug.inspect({
    diagnostics: [],
    tests: [{ file: "/check.ts", ok: false, diagnostics: [{ text }] }],
  });

  assert.deepEqual(result.tests[0].diagnostics[0], {
    text,
    file: "/source.ts",
    line: 1,
    column: 0,
    revision: 0,
  });
  debug.dispose();
});

test("debug source leases retain active factories, bound history and release every URL", () => {
  const debug = createDebugLocations();
  const compiler = createProjectCompiler(createEngine(module), config);
  const released = [];
  for (let revision = 0; revision < 80; revision++) {
    const program = compiler.compile({ "/main.ts": `export const value=${revision}` });
    debug.update(program, revision);
    debug.register(revision, program.modules["/main.ts"], program.debug["/main.ts"]);
    debug.alias(revision, `blob:null/${revision}`, () => released.push(revision));
    debug.commit(program);
    assert.equal(released.includes(revision), false);
  }
  assert.equal(released.length, 47);
  debug.dispose();
  assert.equal(new Set(released).size, 80);
  assert.equal(released.length, 80);
  compiler.dispose();
});

test("optional validation bounds concurrency and removes cancelled queued work", async () => {
  const lane = createValidationLane();
  const lifetime = new AbortController();
  const cancelled = new AbortController();
  let finish;
  let active = 0;
  let peak = 0;

  const first = lane(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => {
      finish = resolve;
    });
    active--;
    return 1;
  }, lifetime.signal);

  const second = lane(async () => {
    throw Error("Cancelled job executed");
  }, cancelled.signal);

  const rejected = assert.rejects(second, { name: "AbortError" });
  cancelled.abort();

  const third = lane(async () => {
    peak = Math.max(peak, ++active);
    active--;
    return 3;
  }, lifetime.signal);

  await new Promise((resolve) => setImmediate(resolve));
  finish();
  assert.deepEqual(await Promise.all([first, third]), [1, 3]);
  await rejected;
  assert.equal(peak, 1);
});
