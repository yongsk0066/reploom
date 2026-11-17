import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileFunction } from "node:vm";
import { createEngine } from "../../crates/compiler/engine.mjs";
import { createProjectCompiler } from "../../packages/runtime/src/compiler/project-compiler.ts";
import { createModuleRuntime } from "../../packages/runtime/src/execution/module-runtime.ts";
import { createModulePolicy } from "../../packages/runtime/src/execution/adapters/policy.ts";

const wasm = await WebAssembly.compile(
  await readFile(new URL("../../crates/compiler/artifacts/compiler.wasm", import.meta.url)),
);

async function evaluate(files, check) {
  const compiler = createProjectCompiler(createEngine(wasm), {
    key: "lowering",
    entry: "/main.ts",
    runtime: "dom",
    imports: {},
    styles: [],
    dependencyFiles: {},
  });

  const runtime = createModuleRuntime(createModulePolicy({}), ({ code }) =>
    compileFunction(`return (${code})`)(),
  );

  try {
    const result = await runtime.apply(compiler.compile(files), () => {});
    await check(result.entry, { compiler, runtime });
  } finally {
    await runtime.dispose();
    compiler.dispose();
  }
}

test("generated helpers reserve decoded names, nested bindings, unresolved references and derived slots", async () => {
  for (const suffix of [
    "module",
    "checkpoint",
    "register",
    "signature",
    "module_default",
    "module_import0",
    "module_import0_slot0",
  ]) {
    const name = "__playground_" + suffix;
    const escaped = name.replace("y", String.raw`\u0079`);
    await evaluate(
      {
        "/main.ts": `import {value} from './dep.ts'; const ${escaped}=3; export const local=${escaped}; export const imported=()=>value; export default 9;`,
        "/dep.ts": "export const value=7;",
      },
      (entry) => {
        assert.equal(entry.local, 3, name);
        assert.equal(entry.imported(), 7, name);
        assert.equal(entry.default, 9, name);
      },
    );
    await evaluate(
      {
        "/main.ts": `import {value} from './dep.ts'; export const missing=typeof ${escaped}; export const read=(${escaped})=>value;`,
        "/dep.ts": "export const value=7;",
      },
      (entry) => {
        assert.equal(entry.missing, "undefined", name);
        assert.equal(entry.read(100), 7, name);
      },
    );
  }
});

test("typed import lowering preserves live reads, receiver unbinding and namespace receivers", async () => {
  const files = {
    "/main.ts": `export {value as forwarded}; import {value, bump, receiver, tag} from './dep.ts'; import * as ns from './dep.ts';
      export const read=()=>value; export const increment=()=>bump();
      export const calls=()=>[receiver(),receiver?.(),tag\`text\`,ns.receiver()===ns];
      export const object=()=>({value});`,
    "/dep.ts":
      "export let value=1; export function bump(){value++} export function receiver(){return this} export function tag(){return this}",
  };

  await evaluate(files, async (entry, { compiler, runtime }) => {
    const retained = entry.read;
    assert.deepEqual(entry.calls(), [undefined, undefined, undefined, true]);
    entry.increment();
    assert.equal(entry.read(), 2);
    assert.equal(entry.forwarded, 2);
    assert.deepEqual(entry.object(), { value: 2 });

    const updated = await runtime.apply(
      compiler.compile({ ...files, "/dep.ts": files["/dep.ts"].replace("value=1", "value=7") }),
      () => {},
    );

    assert.equal(updated.entry.read(), 7);
    assert.equal(updated.entry.forwarded, 7);
    // Retired evaluations keep their old view for cleanup; active imports see the new graph.
    assert.equal(retained(), 2);
    assert.equal(entry.forwarded, 2);
  });
});

test("derived names are individually reserved even when a shorter helper name is available", async () => {
  await evaluate(
    {
      "/main.ts": String.raw`import {value} from './dep.ts'; const __pla\u0079ground_module_import0_slot0=10; const __pla\u0079ground_module_import0_slot0_=11; export const result=()=>value+__pla\u0079ground_module_import0_slot0+__pla\u0079ground_module_import0_slot0_;`,
      "/dep.ts": "export const value=7;",
    },
    (entry) => assert.equal(entry.result(), 28),
  );
});
