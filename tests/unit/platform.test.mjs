import {
  PROTOCOL,
  MODULE_ABI,
  PROGRAM_SCHEMA,
} from "../../packages/runtime/src/shared/protocol.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAssetRepository } from "../../packages/runtime/src/shared/assets.ts";
import { createCompilerClient } from "../../packages/runtime/src/browser/compiler-client.ts";
import { createBrowserPlatform } from "../../packages/runtime/src/browser/platform.ts";

const asset = { url: "entry.js", sha256: createHash("sha256").update("hello").digest("hex") };

test(
  "manifest resources start before program and vendor downloads finish",
  { timeout: 2000 },
  async (t) => {
    const contents = new Map();

    const declare = (url, body) => {
      contents.set(url, body);
      return { url, sha256: createHash("sha256").update(body).digest("hex") };
    };

    const binary = { ...declare("image", "pixels"), type: "image/png" };

    const program = declare(
      "program",
      JSON.stringify({
        schema: PROGRAM_SCHEMA,
        abi: MODULE_ABI,
        resources: { assets: { "/image.png": binary } },
      }),
    );

    const sources = declare("sources", JSON.stringify({ "/a.js": "export{}" }));
    const vendor = declare("vendor", "dependency");
    const bootstrap = declare("bootstrap", "bootstrap");
    const vendorGate = Promise.withResolvers();
    const programGate = Promise.withResolvers();
    const binaryRequested = Promise.withResolvers();
    let vendorFinished = false;

    const manifest = {
      schema: 2,
      protocol: PROTOCOL,
      moduleABI: MODULE_ABI,
      bootstrap,
      projects: {
        example: { sources, program, assets: { "/image.png": binary }, vendor: [vendor] },
      },
    };

    const platform = createBrowserPlatform({
      manifestUrl: "https://test.invalid/runtime/manifest.json",
      fetch: async (url) => {
        const name = new URL(url).pathname.split("/").at(-1);
        if (name === "manifest.json") return Response.json(manifest);
        if (name === "vendor") {
          await vendorGate.promise;
          vendorFinished = true;
        }
        if (name === "program") await programGate.promise;
        if (name === "image") binaryRequested.resolve(vendorFinished);
        return new Response(contents.get(name));
      },
    });

    t.after(() => {
      vendorGate.resolve();
      programGate.resolve();
      platform.dispose();
    });
    const loading = platform.services.loadProject("example");
    assert.equal(await binaryRequested.promise, false);
    vendorGate.resolve();
    programGate.resolve();
    const result = await loading;
    assert.equal(new TextDecoder().decode(result.assets["/image.png"].bytes), "pixels");
    assert.deepEqual(result.files, { "/a.js": "export{}" });
  },
);

test("asset repositories isolate cache/fetch ownership and reject late responses after disposal", async () => {
  let settle;
  let signal;
  let calls = 0;

  const first = createAssetRepository({
    manifestUrl: "https://test.invalid/first/manifest.json",
    fetch: (_url, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  });

  const second = createAssetRepository({
    manifestUrl: "https://test.invalid/second/manifest.json",
    fetch: async (url) => {
      calls++;
      assert.equal(url, "https://test.invalid/second/entry.js");
      return new Response("hello");
    },
  });

  const pending = first.loadAsset(asset);
  await Promise.resolve();
  first.dispose();
  assert.equal(signal.aborted, true);
  settle(new Response("hello"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.throws(() => first.loadAsset(asset), { name: "AbortError" });
  assert.equal(await second.loadAsset(asset), "hello");
  assert.equal(await second.loadAsset(asset), "hello");
  assert.equal(calls, 1);
  assert.throws(() => second.loadAsset({ ...asset, url: "../first/entry.js" }), /outside/);
  assert.throws(
    () => second.loadAsset({ ...asset, url: "https://elsewhere.invalid/second/entry.js" }),
    /outside/,
  );
  second.dispose();
});

test("compiler clients with matching project IDs own separate workers and settle pending disposal", async (t) => {
  const workers = [];

  const factory = () => {
    const worker = {
      messages: [],
      postMessage(message) {
        this.messages.push(message);
      },
      terminate() {
        this.terminated = true;
      },
    };

    workers.push(worker);
    return worker;
  };

  const one = createCompilerClient(factory);
  const two = createCompilerClient(factory);

  t.after(() => {
    one.dispose();
    two.dispose();
  });
  const controller = new AbortController();
  one.prepare("same", asset, controller.signal);
  two.prepare("same", asset, controller.signal);
  assert.equal(workers.length, 2);

  const pending = one.compile(
    {
      projectId: "same",
      revision: 1,
      files: { "/a.js": "export{}" },
      config: {},
      compiler: asset,
      seed: { files: {}, output: {} },
    },
    controller.signal,
  );

  one.dispose();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[1].terminated, undefined);
  one.dispose();
  two.release("same");
  assert.equal(workers[1].terminated, true);
  two.dispose();
});

test("disposing a platform while its compiler chunk loads prevents worker creation", async () => {
  let created = 0;

  const platform = createBrowserPlatform({
    manifestUrl: "https://test.invalid/assets/manifest.json",
    createWorker: () => {
      created++;
      throw new Error("must not run");
    },
  });

  const pending = platform.services.compiler.prepare("late", asset, new AbortController().signal);
  platform.dispose();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(created, 0);
  assert.throws(() => platform.loadManifest(), { name: "AbortError" });
});

test("registering a preview does not download or create the compiler before editing", async () => {
  let requests = 0;

  const platform = createBrowserPlatform({
    manifestUrl: "https://test.invalid/assets/manifest.json",
    fetch: async () => {
      requests++;
      throw new Error("no compiler fetch expected");
    },
  });

  const connection = await platform.connectCompilerPreview(
    "lazy",
    "generation",
    () => {
      throw new Error("no worker expected");
    },
    new AbortController().signal,
  );

  assert.equal(requests, 0);
  connection.close();
  platform.dispose();
});

test("a queued preview connection cannot register after its platform is disposed", async () => {
  const platform = createBrowserPlatform({
    manifestUrl: "https://test.invalid/assets/manifest.json",
    createWorker: () => {
      throw Error("not needed");
    },
  });

  const signal = new AbortController().signal;

  const initial = await platform.connectCompilerPreview(
    "initial",
    "first",
    () => {
      throw Error("not needed");
    },
    signal,
  );

  initial.close();

  const late = platform.connectCompilerPreview(
    "late",
    "second",
    () => {
      throw Error("not needed");
    },
    signal,
  );

  platform.dispose();
  await assert.rejects(late, { name: "AbortError" });

  const client = createCompilerClient(() => {
    throw Error("not needed");
  });

  client.dispose();
  assert.throws(
    () =>
      client.connectPreview("late", "first", () => {
        throw Error("not needed");
      }),
    { name: "AbortError" },
  );
});

test("empty verified assets obey the cache entry limit instead of looking perpetually pending", async () => {
  let calls = 0;

  const repository = createAssetRepository({
    manifestUrl: "https://test.invalid/assets/manifest.json",
    fetch: async () => {
      calls++;
      return new Response(new Uint8Array());
    },
  });

  const sha256 = createHash("sha256").update("").digest("hex");
  try {
    for (let index = 0; index < 40; index++)
      await repository.loadBinaryAsset({
        url: "empty",
        sha256,
        type: `application/x-empty-${index}`,
      });
    await repository.loadBinaryAsset({ url: "empty", sha256, type: "application/x-empty-0" });
    assert.equal(calls, 41);
  } finally {
    repository.dispose();
  }
});

test("a failed project load cancels its sibling downloads while another project keeps its shared lease", async (t) => {
  const contents = new Map();
  const signals = new Map();
  const gates = new Map();

  const declare = (url, text) => {
    contents.set(url, text);
    return { url, sha256: createHash("sha256").update(text).digest("hex") };
  };

  const shared = declare("shared", "vendor");
  const blocked = declare("blocked", "{}");
  const bad = declare("bad", "unused");
  const sources = declare("sources", JSON.stringify({ "/a.js": "export{}" }));
  const program = declare("program", JSON.stringify({ schema: 8, abi: 4 }));
  const bootstrap = declare("bootstrap", "bootstrap");

  const manifest = {
    schema: 2,
    protocol: PROTOCOL,
    moduleABI: MODULE_ABI,
    bootstrap,
    projects: {
      first: { sources: blocked, program: bad, assets: {}, vendor: [shared] },
      second: { sources, program, assets: {}, vendor: [shared] },
    },
  };

  for (const name of ["blocked", "bad", "shared"]) gates.set(name, Promise.withResolvers());

  const platform = createBrowserPlatform({
    manifestUrl: "https://test.invalid/assets/manifest.json",
    fetch: async (url, { signal }) => {
      const name = new URL(url).pathname.split("/").at(-1);
      if (name === "manifest.json") return Response.json(manifest);
      signals.set(name, signal);
      if (gates.has(name)) await gates.get(name).promise;
      return new Response(contents.get(name), { status: name === "bad" ? 500 : 200 });
    },
  });

  t.after(() => {
    for (const gate of gates.values()) gate.resolve();
    platform.dispose();
  });
  const failed = platform.services.loadProject("first");
  const successful = platform.services.loadProject("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.size, 6);
  gates.get("bad").resolve();
  await assert.rejects(failed, /Could not load asset: bad/);
  assert.equal(signals.get("bad").aborted, true);
  assert.equal(signals.get("blocked").aborted, true);
  assert.equal(signals.get("shared").aborted, false);
  gates.get("shared").resolve();
  assert.deepEqual((await successful).vendor, ["vendor"]);
});
