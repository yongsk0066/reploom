import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { compilerEngine as oxc } from "../fixtures/compiler/engine.mjs";

import { defineProject } from "../../packages/runtime/src/project/definition.ts";
import { createProjectCompiler } from "../../packages/runtime/src/compiler/project-compiler.ts";
import { createModuleRuntime } from "../../packages/runtime/src/execution/module-runtime.ts";
import { createModulePolicy } from "../../packages/runtime/src/execution/adapters/policy.ts";
import { applyProgramPatch, diffProgram } from "../../packages/runtime/src/shared/protocol.ts";
import { compileFunction } from "node:vm";
import { createHash } from "node:crypto";
import { createAssetRepository } from "../../packages/runtime/src/shared/assets.ts";

const { TraceMap, originalPositionFor } = createRequire(
  import.meta.resolve("@jridgewell/remapping"),
)("@jridgewell/trace-mapping");

const config = {
  key: "dom-fixture",
  runtime: "dom",
  entry: "/src/main.ts",
  styles: [],
  imports: {},
  dependencyFiles: {},
};

test("project declarations freeze owned data and reject invalid paths, entries and unpinned dependencies", () => {
  const files = { "/src/main.ts": "export const value = 1" };

  const project = defineProject({
    id: "example",
    title: "Example",
    runtime: "dom",
    entry: "/src/main.ts",
    files,
  });

  files["/src/main.ts"] = "changed externally";
  assert.equal(project.files["/src/main.ts"], "export const value = 1");
  assert.equal(project.updateDelayMs, undefined);
  assert.throws(() => defineProject({ ...project, entry: "/missing.ts" }), /Entry file/);
  assert.throws(
    () => defineProject({ ...project, files: { ...files, "/../secret.js": "" } }),
    /normalized/,
  );
  assert.throws(
    () =>
      defineProject({
        ...project,
        dependencies: { clsx: { version: "latest" } },
      }),
    /exact versions/,
  );
  assert.throws(() => defineProject({ ...project, styles: ["/missing.css"] }), /Style/);
});

test("metadata-only edits update source maps without evaluating code or losing live exports", async () => {
  const compiler = createProjectCompiler(oxc, config);

  const runtime = createModuleRuntime(createModulePolicy({}), ({ code }) =>
    compileFunction(`return (${code})`)(),
  );

  const files = {
    "/src/main.ts":
      "globalThis.__generalLoads = (globalThis.__generalLoads || 0) + 1; export const token = {};",
  };

  try {
    const first = { revision: 0, program: compiler.compile(files) };
    const original = await runtime.apply(first.program, () => {});

    const next = {
      revision: 1,
      program: compiler.compile({
        "/src/main.ts": files["/src/main.ts"] + "\n",
      }),
    };

    const a = first.program.modules[config.entry];
    const b = next.program.modules[config.entry];

    assert.equal(a.code, b.code);
    assert.notEqual(
      first.program.debug[config.entry].sourceMap,
      next.program.debug[config.entry].sourceMap,
    );
    assert.deepEqual(Object.keys(diffProgram(first, next).changed), []);
    const patch = diffProgram(first, next);
    const decoded = applyProgramPatch(first, patch);
    const result = await runtime.apply(decoded.program, () => {});
    assert.deepEqual(result.evaluated, []);
    assert.equal(result.entry.token, original.entry.token);
    assert.equal(globalThis.__generalLoads, 1);
  } finally {
    await runtime.dispose();
    compiler.dispose();
    delete globalThis.__generalLoads;
  }
});

test("compiler seeds and runtime commits cannot cross a project's dependency configuration", async () => {
  const files = { "/src/main.ts": "export const token = {};" };
  const first = createProjectCompiler(oxc, config);
  const seed = { files, output: first.compile(files) };
  const other = createProjectCompiler(oxc, { ...config, key: "different-dependencies" }, seed);
  const output = other.compile(files);
  assert.deepEqual(output.transformed, [config.entry]);

  const runtime = createModuleRuntime(createModulePolicy({}), ({ code }) =>
    compileFunction(`return (${code})`)(),
  );

  try {
    await runtime.apply(seed.output, () => {});
    await assert.rejects(
      runtime.apply(output, () => {}),
      (error) => error.requiresRestart === true,
    );
  } finally {
    await runtime.dispose();
    first.dispose();
    other.dispose();
  }
});

test("boundary source maps retain original Unicode source locations and native/fallback base64 agree", () => {
  const compiler = createProjectCompiler(oxc, config);
  const source = `const 한글: string = '값';\nexport function fail() {\n  throw new Error(한글);\n}`;
  const output = compiler.compile({ [config.entry]: source });
  const artifact = output.modules[config.entry];

  const map = JSON.parse(
    Buffer.from(output.debug[config.entry].sourceMap.split(",")[1], "base64").toString(),
  );

  assert.equal(map.sourcesContent[0], source);
  const index = artifact.code.indexOf("new Error");
  assert.ok(index >= 0);
  const prefix = artifact.code.slice(0, index).split("\n");

  const position = originalPositionFor(new TraceMap(map), {
    line: prefix.length + 2,
    column: prefix.at(-1).length,
  });

  assert.equal(position.line, 3);
  assert.equal(position.source, config.entry);
  const native = Uint8Array.prototype.toBase64;
  try {
    Uint8Array.prototype.toBase64 = undefined;
    const fallback = createProjectCompiler(oxc, config);
    assert.equal(
      fallback.compile({ [config.entry]: source }).debug[config.entry].sourceMap,
      output.debug[config.entry].sourceMap,
    );
    fallback.dispose();
  } finally {
    Uint8Array.prototype.toBase64 = native;
    compiler.dispose();
  }
});

test("the asset cache coalesces requests and bounds retained project source text", async () => {
  const repository = createAssetRepository({
    manifestUrl: "https://fixture.test/playground-generated/manifest.json",
  });

  const { loadAsset } = repository;
  const fetch = globalThis.fetch;

  const bodies = new Map();
  const counts = new Map();

  const assets = Array.from({ length: 10 }, (_, index) => {
    const text = String(index).repeat(600_000);

    const asset = {
      url: `/playground-generated/cache-${index}.txt`,
      sha256: createHash("sha256").update(text).digest("hex"),
    };

    bodies.set(asset.url, text);
    return asset;
  });

  globalThis.fetch = async (url) => {
    url = new URL(url).pathname;
    counts.set(url, (counts.get(url) || 0) + 1);
    return new Response(bodies.get(url));
  };
  try {
    const first = loadAsset(assets[0]);
    const second = loadAsset(assets[0]);
    assert.equal(await first, await second);
    assert.equal(counts.get(assets[0].url), 1);
    for (const asset of assets.slice(1)) await loadAsset(asset);
    await loadAsset(assets.at(-1));
    assert.equal(counts.get(assets.at(-1).url), 1);
    await loadAsset(assets[0]);
    assert.equal(counts.get(assets[0].url), 2);
  } finally {
    repository.dispose();
    globalThis.fetch = fetch;
  }
});
