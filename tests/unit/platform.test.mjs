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
    assert.equal(await result.assets["/image.png"].text(), "pixels");
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

test("a released preview destination cannot close the next session before the first edit", async () => {
  const platform = createBrowserPlatform({ manifestUrl: "https://test.invalid/manifest.json" });

  const connect = (generation) =>
    platform.connectCompilerPreview(
      "example",
      generation,
      () => {
        throw Error("No editing intent");
      },
      new AbortController().signal,
    );

  try {
    const old = await connect("first");
    platform.services.compiler.release("example");
    const current = await connect("second");
    old.close();
    await assert.rejects(connect("duplicate"), /one active preview/);
    current.close();
  } finally {
    platform.dispose();
  }
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

test("oversized verified results share their pending request without evicting settled assets", async () => {
  const contents = { small: "kept", large: new Uint8Array(9 * 1024 * 1024) };
  const calls = { small: 0, large: 0 };

  const repository = createAssetRepository({
    manifestUrl: "https://test.invalid/assets/manifest.json",
    fetch: async (url) => {
      const key = new URL(url).pathname.split("/").at(-1);
      calls[key]++;
      return new Response(contents[key]);
    },
  });

  const asset = (key) => ({
    url: key,
    sha256: createHash("sha256").update(contents[key]).digest("hex"),
    type: "application/octet-stream",
  });

  try {
    await repository.loadAsset(asset("small"));

    const [one, two] = await Promise.all([
      repository.loadBinaryAsset(asset("large")),
      repository.loadBinaryAsset(asset("large")),
    ]);

    assert.equal(one, two);
    assert.equal(await repository.loadAsset(asset("small")), "kept");
    assert.deepEqual(calls, { small: 1, large: 1 });
    await repository.loadBinaryAsset(asset("large"));
    assert.equal(calls.large, 2);
    assert.equal(await repository.loadAsset(asset("small")), "kept");
    assert.equal(calls.small, 1);
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
  const program = declare("program", JSON.stringify({ schema: PROGRAM_SCHEMA, abi: MODULE_ABI }));
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
  assert.deepEqual(await Promise.all((await successful).vendor.map((part) => part.text())), [
    "vendor",
  ]);
});

test("verified JSON is parsed once, immutable across consumers, and isolated from text and binary views", async (t) => {
  const body = JSON.stringify({ files: { "/a.ts": "export const value = 1" }, values: [1, 2] });
  let calls = 0;
  const asset = { url: "project.json", sha256: createHash("sha256").update(body).digest("hex") };

  const repository = createAssetRepository({
    manifestUrl: "https://fixture.test/assets/manifest.json",
    fetch: async () => {
      calls++;
      return new Response(body);
    },
  });

  t.after(() => repository.dispose());

  const [first, second] = await Promise.all([
    repository.loadJSONAsset(asset),
    repository.loadJSONAsset(asset),
  ]);

  assert.equal(first, second);
  assert.equal(await repository.loadJSONAsset(asset), first);
  assert.equal(calls, 1);
  assert.throws(() => {
    first.files["/a.ts"] = "changed";
  }, TypeError);
  assert.throws(() => first.values.push(3), TypeError);
  assert.equal(await repository.loadAsset(asset), body);
  const binary = await repository.loadBinaryAsset({ ...asset, type: "text" });
  assert.equal(new TextDecoder().decode(binary.bytes), body);
  assert.equal(calls, 3);
});

test("JSON decoding failures retire their request and decoded cache entries obey the shared byte bound", async (t) => {
  const bodies = [
    "{",
    ...Array.from({ length: 7 }, (_, i) => JSON.stringify({ value: String(i).repeat(700_000) })),
  ];

  const calls = bodies.map(() => 0);

  const assets = bodies.map((body, i) => ({
    url: String(i),
    sha256: createHash("sha256").update(body).digest("hex"),
  }));

  const repository = createAssetRepository({
    manifestUrl: "https://fixture.test/assets/manifest.json",
    fetch: async (url) => {
      const i = Number(new URL(url).pathname.split("/").at(-1));
      calls[i]++;
      return new Response(bodies[i]);
    },
  });

  t.after(() => repository.dispose());
  for (let i = 0; i < 2; i++)
    await assert.rejects(repository.loadJSONAsset(assets[0]), SyntaxError);
  assert.equal(calls[0], 2);
  for (const asset of assets.slice(1)) await repository.loadJSONAsset(asset);
  await repository.loadJSONAsset(assets.at(-1));
  assert.equal(calls.at(-1), 1);
  await repository.loadJSONAsset(assets[1]);
  assert.equal(calls[1], 2);
});

test("prepared scripts retain immutable bytes and preserve them across structured cloning", async (t) => {
  const body = "globalThis.example = '한글😀';";
  const asset = { url: "runtime.js", sha256: createHash("sha256").update(body).digest("hex") };
  let calls = 0;

  const repository = createAssetRepository({
    manifestUrl: "https://fixture.test/assets/manifest.json",
    fetch: async () => {
      calls++;
      return new Response(body);
    },
  });

  t.after(() => repository.dispose());

  const [one, two] = await Promise.all([
    repository.loadScriptAsset(asset),
    repository.loadScriptAsset(asset),
  ]);

  assert.equal(one, two);
  assert.equal(one.type, "text/javascript");
  assert.equal(one.size, new TextEncoder().encode(body).byteLength);
  const copy = structuredClone(one);
  repository.dispose();
  assert.equal(await copy.text(), body);
  assert.equal(calls, 1);
});

test("a prepared manifest is pinned at acquisition and retains protocol, integrity and disposal checks", async () => {
  const requests = [];
  const input = { schema: 2, protocol: PROTOCOL, moduleABI: MODULE_ABI, projects: { example: {} } };

  const options = {
    manifest: input,
    manifestUrl: "https://test.invalid/pinned/manifest.json",
    fetch: async (url) => {
      requests.push(String(url));
      return new Response("hello");
    },
  };

  const repository = createAssetRepository(options);
  input.protocol = -1;
  input.projects.example.changed = true;
  const snapshot = await repository.loadManifest();
  assert.equal(snapshot.protocol, PROTOCOL);
  assert.deepEqual(snapshot.projects.example, {});
  assert.deepEqual(requests, []);
  assert.equal(await repository.loadAsset(asset), "hello");
  await assert.rejects(repository.loadAsset({ ...asset, sha256: "bad" }), /integrity/);
  assert.deepEqual(requests, Array(2).fill("https://test.invalid/pinned/entry.js"));
  repository.dispose();
  assert.throws(() => repository.loadManifest(), { name: "AbortError" });
  const incompatible = createAssetRepository(options);
  await assert.rejects(incompatible.loadManifest(), /Incompatible project manifest/);
  incompatible.dispose();
});

test("verified resource Blobs share the immutable script representation and reject a digest mismatch", async (t) => {
  const bytes = new TextEncoder().encode("original");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let calls = 0;

  const repository = createAssetRepository({
    manifestUrl: "https://example.test/manifest.json",
    fetch: async () => {
      calls++;
      return new Response(bytes);
    },
  });

  t.after(() => repository.dispose());
  const asset = { url: "resource.js", type: "TEXT/JAVASCRIPT", sha256 };

  const [script, blob] = await Promise.all([
    repository.loadScriptAsset(asset),
    repository.loadBlobAsset(asset),
  ]);

  assert.equal(blob, script);
  assert.equal(await blob.text(), "original");
  assert.equal(calls, 1);
  await assert.rejects(repository.loadBlobAsset({ ...asset, sha256: "bad" }), /integrity/);
});
