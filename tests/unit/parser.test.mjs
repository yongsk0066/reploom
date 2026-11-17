import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createEngine } from "../../crates/compiler/engine.mjs";
import { comparisons, computedKeys, nestedGenerics } from "../fixtures/compiler/parser-cases.mjs";

const module = await WebAssembly.compile(
  await readFile(new URL("../../crates/compiler/artifacts/compiler.wasm", import.meta.url)),
);

test("speculation caches release per parse without repeated WASM high-water growth", () => {
  const engine = createEngine(module);
  const sources = [comparisons(2048), computedKeys(20), computedKeys(24)];
  const expected = sources.map((source) => engine.compileModule("/main.tsx", source, "dom"));
  const capacity = engine.memoryBytes();
  assert.ok(capacity < 8 * 1024 * 1024, `WASM capacity: ${capacity}`);
  for (let round = 0; round < 40; round++)
    for (let index = 0; index < sources.length; index++)
      assert.deepEqual(engine.compileModule("/main.tsx", sources[index], "dom"), expected[index]);
  assert.equal(engine.memoryBytes(), capacity);
});

test("type depth diagnostics preserve the WASM instance and UTF-16 source location", () => {
  const engine = createEngine(module);
  const source = "const emoji='😀';\n" + nestedGenerics(140);
  for (let round = 0; round < 20; round++) {
    assert.throws(
      () => engine.compileModule("/deep.tsx", source, "dom"),
      (error) => {
        assert.notEqual(error.fatal, true);

        const diagnostic = error.diagnostics.find((item) =>
          item.text.includes("nesting budget (32)"),
        );

        assert.equal(diagnostic.file, "/deep.tsx");
        assert.equal(diagnostic.line, 2);
        assert.ok(diagnostic.column > 0);
        return true;
      },
    );
    assert.ok(engine.compileModule("/valid.tsx", "export const recovered=1;", "dom").code);
  }
  assert.ok(engine.memoryBytes() < 2 * 1024 * 1024);
});

test("resource diagnostics and parse caches respect the cooperative compiler lifetime", async () => {
  let cancel = false;

  const engine = createEngine(module, {
    now: () => 100,
    yieldTask: async () => {},
    onCheckpoint: (phase) => {
      if (phase === 1) cancel = true;
    },
  });

  await assert.rejects(
    engine.compileModuleAsync("/main.tsx", nestedGenerics(140), "dom", () => false),
    (error) =>
      error.fatal !== true &&
      error.diagnostics.some((item) => item.text.includes("nesting budget")),
  );
  if (engine.supportsJSPI) {
    await assert.rejects(
      engine.compileModuleAsync("/main.tsx", computedKeys(24), "dom", () => cancel),
      { name: "AbortError" },
    );
    cancel = false;
  }
  assert.ok(engine.compileModule("/main.tsx", comparisons(128), "dom").code);
});
