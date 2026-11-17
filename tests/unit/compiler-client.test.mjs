import test from "node:test";
import assert from "node:assert/strict";
import { createCompilerClient } from "../../packages/runtime/src/browser/compiler-client.ts";

const { compile, prepare, release, connectPreview } = createCompilerClient(
  () => new Worker("compiler"),
);

test("editor operations avoid flattening stable bases and recover snapshots/ports after idle", async (t) => {
  const original = globalThis.Worker;
  const instances = [];
  const ports = [];

  t.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.Worker = class {
    messages = [];

    constructor() {
      instances.push(this);
    }

    postMessage(message) {
      this.messages.push(message);
    }

    terminate() {}
  };

  const reference = {
    delivery: "worker",
    schema: 8,
    abi: 4,
    compilerVersion: "test",
    projectKey: "same",
    entry: "/a.js",
    runtime: "dom",
    execution: { mode: "window", taskMs: 32 },
    styles: [],
    transformed: [],
  };

  let reads = 0;

  const source = (text) => ({
    length: text.length,
    toString() {
      reads++;
      return text;
    },
  });

  const request = {
    projectId: "ops",
    revision: 1,
    files: { "/a.js": source("abc") },
    compiler: { url: "/test", sha256: "test" },
    config: {},
    seed: { files: {}, output: {} },
  };

  const connection = connectPreview("ops", "generation", () => {
    const { port1, port2 } = new MessageChannel();
    ports.push(port1, port2);
    return port1;
  });

  const reply = () => {
    const instance = instances.at(-1);
    const command = instance.messages.findLast((m) => m.type === "compile");

    instance.onmessage({
      data: {
        protocol: command.protocol,
        projectId: "ops",
        id: command.id,
        ok: true,
        reference,
      },
    });
    return command;
  };

  try {
    let result = compile(request, new AbortController().signal);
    assert.equal(reply().delivery, "reference");
    await result;
    assert.equal(reads, 1);
    result = compile(
      {
        ...request,
        revision: 2,
        files: { "/a.js": source("a😀c") },
        edits: {
          baseRevision: 1,
          changes: {
            "/a.js": {
              baseLength: 3,
              edits: [{ from: 1, to: 2, insert: "😀" }],
            },
          },
        },
      },
      new AbortController().signal,
    );
    assert.equal(reply().changes["/a.js"].edits[0].insert, "😀");
    await result;
    assert.equal(reads, 1);
    t.mock.timers.tick(30_000);
    result = compile(
      {
        ...request,
        revision: 3,
        files: { "/a.js": source("a😀c!") },
        edits: {
          baseRevision: 2,
          changes: {
            "/a.js": {
              baseLength: 4,
              edits: [{ from: 4, to: 4, insert: "!" }],
            },
          },
        },
      },
      new AbortController().signal,
    );
    const restored = reply();
    await result;
    assert.equal(restored.baseRevision, null);
    assert.equal(restored.changes["/a.js"], "a😀c!");
    assert.equal(reads, 2);
    assert.equal(instances.length, 2);
    assert.equal(instances[1].messages[0].type, "connect-preview");
  } finally {
    connection.close();
    release("ops");
    for (const port of ports) port.close();
    globalThis.Worker = original;
  }
});

test("warming sessions share a Worker lease and the final release terminates it before any compile", () => {
  const original = globalThis.Worker;
  const instances = [];

  globalThis.Worker = class {
    messages = [];
    terminated = false;

    constructor() {
      instances.push(this);
    }

    postMessage(message) {
      this.messages.push(message);
    }

    terminate() {
      this.terminated = true;
    }
  };
  const asset = { url: "/compiler.js", sha256: "test" };
  try {
    prepare("aborted", asset, AbortSignal.abort());
    assert.equal(instances.length, 0);
    prepare("one", asset, new AbortController().signal);
    prepare("two", asset, new AbortController().signal);
    assert.equal(instances.length, 1);
    assert.deepEqual(
      instances[0].messages.map((m) => m.type),
      ["prepare"],
    );
    release("one");
    assert.equal(instances[0].terminated, false);
    release("two");
    assert.equal(instances[0].terminated, true);
    prepare("late", asset, AbortSignal.abort());
    assert.equal(instances.length, 1);
    prepare("next", asset, new AbortController().signal);
    assert.equal(instances.length, 2);
  } finally {
    for (const id of ["one", "two", "next", "late", "aborted"]) release(id);
    globalThis.Worker = original;
  }
});

test("idle compilation releases WASM ownership, reseeds on wake and never retires a pending request", async (t) => {
  const original = globalThis.Worker;
  const instances = [];

  t.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.Worker = class {
    messages = [];

    constructor() {
      instances.push(this);
    }

    postMessage(message) {
      this.messages.push(message);
    }

    terminate() {
      this.terminated = true;
    }
  };
  const asset = { url: "/compiler.js", sha256: "test" };

  const output = {
    schema: 8,
    abi: 4,
    compilerVersion: "test",
    projectKey: "same",
    entry: "/a.js",
    runtime: "react",
    execution: {},
    styles: [],
    transformed: [],
    modules: {},
  };

  const input = {
    projectId: "idle",
    revision: 1,
    files: { "/a.js": "one" },
    compiler: asset,
    config: {},
    seed: { files: {}, output },
  };

  const reply = (instance, revision) => {
    const request = instance.messages.findLast((m) => m.type === "compile");
    instance.onmessage({
      data: {
        protocol: request.protocol,
        projectId: request.projectId,
        id: request.id,
        ok: true,
        patch: {
          ...output,
          revision,
          baseRevision: null,
          changed: {},
          removed: [],
        },
      },
    });
  };

  try {
    prepare("idle", asset, new AbortController().signal);
    let result = compile(input, new AbortController().signal);
    t.mock.timers.tick(31_000);
    assert.equal(instances[0].terminated, undefined);
    reply(instances[0], 1);
    assert.equal((await result).ok, true);
    t.mock.timers.tick(29_000);
    assert.equal(instances[0].terminated, undefined);
    t.mock.timers.tick(1_000);
    assert.equal(instances[0].terminated, true);
    prepare("idle", asset, new AbortController().signal);
    assert.equal(instances.length, 2);
    result = compile({ ...input, revision: 2 }, new AbortController().signal);
    const command = instances[1].messages.find((m) => m.type === "compile");
    assert.equal(command.baseRevision, null);
    assert.deepEqual(command.seed, input.seed);
    reply(instances[1], 2);
    assert.equal((await result).ok, true);
    release("idle");
    assert.equal(instances[1].terminated, true);
  } finally {
    release("idle");
    globalThis.Worker = original;
  }
});

test("Worker failure drops warming leases and a later compile acquires a fresh Worker", async () => {
  const original = globalThis.Worker;
  const instances = [];

  globalThis.Worker = class {
    constructor() {
      instances.push(this);
    }

    postMessage() {}

    terminate() {
      this.terminated = true;
    }
  };
  const asset = { url: "/compiler.js", sha256: "test" };
  try {
    prepare("one", asset, new AbortController().signal);
    instances[0].onerror();
    assert.equal(instances[0].terminated, true);
    const controller = new AbortController();

    const result = compile(
      {
        projectId: "two",
        revision: 1,
        files: { "/a.js": "" },
        compiler: asset,
        config: {},
        seed: { files: {}, output: {} },
      },
      controller.signal,
    );

    assert.equal(instances.length, 2);
    controller.abort();
    await assert.rejects(result, { name: "AbortError" });
    release("two");
    assert.equal(instances[1].terminated, true);
  } finally {
    release("one");
    release("two");
    globalThis.Worker = original;
  }
});

test("only the verified compiled Module survives idle retirement; final release revokes it", async (t) => {
  const original = globalThis.Worker;
  const instances = [];

  t.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.Worker = class {
    messages = [];

    constructor() {
      instances.push(this);
    }

    postMessage(message) {
      this.messages.push(message);
    }

    terminate() {}
  };

  const asset = { url: "/module-loader.js", sha256: "pinned-loader" };
  const signal = new AbortController().signal;

  const module = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  try {
    prepare("module-owner", asset, signal);
    const protocol = instances[0].messages[0].protocol;
    instances[0].onmessage({
      data: { protocol, type: "module", compiler: asset, module },
    });
    t.mock.timers.tick(30_000);
    prepare("module-owner", asset, signal);
    assert.equal(instances[1].messages[0].module, module);
    release("module-owner");
    prepare("new-owner", asset, signal);
    assert.equal(instances[2].messages[0].module, undefined);
  } finally {
    release("module-owner");
    release("new-owner");
    globalThis.Worker = original;
  }
});

test("preparation awaits engine readiness, isolates cancellation, and ignores retired generations", async () => {
  const instances = [];

  const client = createCompilerClient(() => {
    const worker = {
      messages: [],
      postMessage(message) {
        this.messages.push(message);
      },
      terminate() {
        this.retired = true;
      },
    };

    instances.push(worker);
    return worker;
  });

  const asset = { url: "/compiler.wasm", sha256: "test" };
  const signal = new AbortController().signal;
  try {
    const cancelled = new AbortController();
    const first = client.prepare("one", asset, cancelled.signal);
    let settled = false;

    const second = client.prepare("two", asset, signal).then(() => {
      settled = true;
    });

    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(instances[0].messages.length, 1);
    cancelled.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal(instances[0].retired, undefined);
    const previousReply = instances[0].onmessage;
    const protocol = instances[0].messages[0].protocol;
    previousReply({ data: { protocol, type: "prepared", compiler: asset } });
    await second;
    await client.prepare("two", asset, signal);
    assert.equal(instances[0].messages.length, 1);
    await assert.rejects(
      client.prepare("two", { ...asset, sha256: "changed" }, signal),
      /identity/,
    );
    client.release("one");
    client.release("two");
    assert.equal(instances[0].retired, true);
    assert.equal(instances[0].onmessage, null);
    assert.equal(instances[0].onerror, null);
    settled = false;

    const third = client.prepare("three", asset, signal).then(() => {
      settled = true;
    });

    previousReply({ data: { protocol, type: "prepared", compiler: asset } });
    await Promise.resolve();
    assert.equal(settled, false);
    instances[1].onmessage({
      data: { protocol, type: "prepared", compiler: asset, error: "invalid compiler" },
    });
    await assert.rejects(third, /invalid compiler/);
    assert.equal(instances[1].retired, true);
    const fourth = client.prepare("four", asset, signal);
    client.release("four");
    await assert.rejects(fourth, { name: "AbortError" });
  } finally {
    client.dispose();
  }
});
