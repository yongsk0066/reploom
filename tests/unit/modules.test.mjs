import { reactConfig, reactPolicy } from "../fixtures/project-fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { compilerEngine as oxc } from "../fixtures/compiler/engine.mjs";

import React from "react";
import RefreshRuntime from "react-refresh/runtime";
import * as JSXDevRuntime from "react/jsx-dev-runtime";
import { createProjectCompiler } from "../../packages/runtime/src/compiler/project-compiler.ts";
import { createModuleRuntime } from "../../packages/runtime/src/execution/module-runtime.ts";

const load = async ({ code }) =>
  (
    await import(
      `data:text/javascript;base64,${Buffer.from("export default " + code).toString("base64")}`
    )
  ).default;

const vendor = { React, RefreshRuntime, JSXDevRuntime };

function setup(t) {
  const compiler = createProjectCompiler(oxc, reactConfig);
  const runtime = createModuleRuntime(reactPolicy(vendor), load);
  let styles;
  t.after(async () => {
    await runtime.dispose();
    compiler.dispose();
    delete globalThis.__moduleTest;
  });
  return {
    compiler,
    runtime,
    apply: (files) =>
      runtime.apply(compiler.compile(files), (value) => {
        styles = value;
      }),
    styles: () => styles,
  };
}

test(
  "removing an unfinished lazy import releases its staged resources without waiting for user promises",
  { timeout: 2000 },
  async (t) => {
    const p = setup(t);
    let started;

    const waiting = new Promise((resolve) => {
      started = resolve;
    });

    globalThis.__moduleTest = { active: 0, pruned: 0, started };

    const files = {
      "/App.js": `globalThis.__moduleTest.pending = import('./lazy.js').catch(() => 'retired'); export default function App(){return 1;}`,
      "/lazy.js": `globalThis.__moduleTest.active++; import.meta.hot.dispose(() => globalThis.__moduleTest.active--); import.meta.hot.prune(() => globalThis.__moduleTest.pruned++); globalThis.__moduleTest.started(); await new Promise(() => {}); export const value=1;`,
    };

    await p.apply(files);
    await waiting;
    await p.apply({ "/App.js": "export default function App(){return 2;}" });
    assert.equal(globalThis.__moduleTest.active, 0);
    assert.equal(globalThis.__moduleTest.pruned, 1);
    assert.equal(await globalThis.__moduleTest.pending, "retired");
  },
);

test("compiler reuses seeded and unchanged modules; a failed edit cannot poison the cache", () => {
  const files = {
    "/App.js": `import { value } from './value.ts'; export default function App() { return value; }`,
    "/value.ts": "export const value: number = 1;",
  };

  const compiler = createProjectCompiler(oxc, reactConfig);
  const initial = compiler.compile(files);

  const seeded = createProjectCompiler(oxc, reactConfig, {
    files,
    output: initial,
  });

  assert.deepEqual(seeded.compile(files).transformed, []);
  const edited = { ...files, "/App.js": files["/App.js"] + "\n// 편집" };
  assert.deepEqual(seeded.compile(edited).transformed, ["/App.js"]);
  assert.throws(() => seeded.compile({ ...edited, "/value.ts": "export const value = ;" }));
  assert.deepEqual(seeded.compile(edited).transformed, []);
  assert.throws(
    () => seeded.compile({ "/App.js": "import 'https://example.com/module.js';" }),
    /Undeclared dependency/,
  );
  assert.throws(() => seeded.compile({ "/App.js": "import './missing.js';" }), /File not found/);
  assert.throws(() => seeded.compile({ ...files, "/../bad.js": "" }), /normalized paths/);
  compiler.dispose();
  seeded.dispose();
});

test("refresh reset reads real comments without treating strings or template text as directives", () => {
  const compiler = createProjectCompiler(oxc, reactConfig);
  const check = (source) => compiler.compile({ "/App.js": source }).modules["/App.js"].forceReset;
  assert.equal(check(`export default function App() {} // @refresh reset`), true);
  assert.equal(check(`/* @refresh reset */ export default function App() {}`), true);
  assert.equal(check(`export default function App() { return '// @refresh reset'; }`), false);
  assert.equal(check("export default function App() { return `\n// @refresh reset\n`; }"), false);
  compiler.dispose();
});

test("an edited utility invalidates its importers without evaluating an unrelated module", async (t) => {
  const p = setup(t);
  globalThis.__moduleTest = { app: 0, utility: 0, stable: 0 };

  const files = {
    "/App.js": `import { value } from './utility.js'; import { token } from './stable.js'; globalThis.__moduleTest.app++; export default function App() { return [value, token]; }`,
    "/utility.js": `globalThis.__moduleTest.utility++; export const value = 1;`,
    "/stable.js": `globalThis.__moduleTest.stable++; export const token = {};`,
  };

  const first = await p.apply(files);
  const token = first.entry.default()[1];

  const next = await p.apply({
    ...files,
    "/utility.js": files["/utility.js"].replace("= 1", "= 2"),
  });

  assert.deepEqual(new Set(next.evaluated), new Set(["/utility.js", "/App.js"]));
  assert.equal(next.entry.default()[0], 2);
  assert.equal(next.entry.default()[1], token);
  assert.deepEqual(globalThis.__moduleTest, { app: 2, utility: 2, stable: 1 });
});

test("dynamic namespace identity survives evaluation and metadata edits without pinning a replaced record", async (t) => {
  const p = setup(t);

  const files = {
    "/App.js": `export const load = () => import('./lazy.js'); export default function App(){}`,
    "/lazy.js": `export let value=1; export function bump(){value++}`,
  };

  const first = await p.apply(files);

  const left = await first.entry.load();
  const right = await first.entry.load();

  assert.equal(left, right);
  left.bump();
  assert.equal(right.value, 2);

  const metadata = await p.apply({
    ...files,
    "/App.js": files["/App.js"] + "\n// no execution change",
  });

  assert.equal(await metadata.entry.load(), left);

  const replacement = await p.apply({
    ...files,
    "/lazy.js": files["/lazy.js"].replace("value=1", "value=5"),
  });

  const fresh = await replacement.entry.load();
  assert.notEqual(fresh, left);
  assert.equal(fresh, await replacement.entry.load());
  assert.equal(fresh.value, 5);
});

test("retired component cleanup can still call a pruned dependency", async (t) => {
  const p = setup(t);

  const first = await p.apply({
    "/App.js": `import { cleanup } from './old.js'; export default function App() { return () => cleanup(); }`,
    "/old.js": `export function cleanup() { return 'cleaned'; }`,
  });

  const cleanup = first.entry.default();
  await p.apply({ "/App.js": `export default function App() {}` });
  assert.equal(cleanup(), "cleaned");
});

test("retired cleanup keeps old imports when an export disappears from a retained dependency", async (t) => {
  const p = setup(t);

  const first = await p.apply({
    "/App.js": `import { cleanup } from './value.js'; export default function App() { return () => cleanup(); }`,
    "/value.js": `export function cleanup() { return 'cleaned'; }`,
  });

  const cleanup = first.entry.default();

  const next = await p.apply({
    "/App.js": `import { value } from './value.js'; export default function App() { return value; }`,
    "/value.js": `export const value = 2;`,
  });

  assert.equal(cleanup(), "cleaned");
  assert.equal(next.entry.default(), 2);
  for (const value of [3, 4, 5]) {
    const latest = await p.apply({
      "/App.js": `import { value } from './value.js'; export default function App() { return value; }`,
      "/value.js": `export const value = ${value}; import.meta.hot.acceptExports(['value']);`,
    });

    assert.equal(latest.entry.default(), value);
    assert.equal(cleanup(), "cleaned");
  }
});

test("component boundaries stop propagation; changed export shape invalidates the parent", async (t) => {
  const p = setup(t);
  globalThis.__moduleTest = { app: 0, child: 0 };

  const files = {
    "/App.js": `import { Child } from './child.jsx'; globalThis.__moduleTest.app++; export default function App() { return Child(); }`,
    "/child.jsx": `globalThis.__moduleTest.child++; export function Child() { return 'before'; }`,
  };

  const first = await p.apply(files);
  files["/child.jsx"] = files["/child.jsx"].replace("before", "after");
  const next = await p.apply(files);
  assert.deepEqual(next.evaluated, ["/child.jsx"]);
  assert.equal(first.entry.default, next.entry.default);
  assert.equal(first.entry.default(), "after");
  files["/child.jsx"] += "\nexport const version = 2;";
  const mixed = await p.apply(files);
  assert.deepEqual(new Set(mixed.evaluated), new Set(["/child.jsx", "/App.js"]));
  assert.deepEqual(globalThis.__moduleTest, { app: 2, child: 3 });
});

test("live exports, reexports and cyclic function imports remain live", async (t) => {
  const p = setup(t);

  const files = {
    "/App.js": `import { value, increment, other } from './barrel.js'; export default function App() { increment(); return [value, other()]; }`,
    "/barrel.js": `export * from './value.js';`,
    "/value.js": `import { other } from './other.js'; export { other }; export let value = 0; export function increment() { value++; }`,
    "/other.js": `import { value } from './value.js'; export function other() { return value * 2; }`,
  };

  const result = await p.apply(files);
  assert.deepEqual(result.entry.default(), [1, 2]);
  assert.deepEqual(result.entry.default(), [2, 4]);
  // This is a real TDZ, unlike merely inspecting a cyclic module's exports.
  await assert.rejects(
    p.apply({
      "/App.js": `import './a.js'; export default function App() {}`,
      "/a.js": `import { b } from './b.js'; export const a = b;`,
      "/b.js": `import { a } from './a.js'; export const b = a;`,
    }),
    (error) => error.cause instanceof ReferenceError && /before initialization/.test(error.message),
  );
});

test("self acceptance, persistent hot.data, dispose and pruning have distinct lifetimes", async (t) => {
  const p = setup(t);
  globalThis.__moduleTest = { active: 0, disposed: 0, pruned: 0, accepted: 0 };

  const files = {
    "/App.js": `import { version } from './resource.js'; export default function App() { return version; }`,
    "/resource.js": `const state = globalThis.__moduleTest; state.active++; export const version = (import.meta.hot.data.version || 0) + 1;
      import.meta.hot.accept(() => { state.accepted++; });
      import.meta.hot.dispose(data => { data.version = version; state.active--; state.disposed++; });
      import.meta.hot.prune(() => { state.pruned++; });`,
  };

  const first = await p.apply(files);
  files["/resource.js"] += "\n// edit";
  const next = await p.apply(files);
  assert.deepEqual(next.evaluated, ["/resource.js"]);
  assert.equal(first.entry.default, next.entry.default);
  assert.equal(next.entry.default(), 2);
  assert.deepEqual(globalThis.__moduleTest, {
    active: 1,
    disposed: 1,
    pruned: 0,
    accepted: 1,
  });
  await p.apply({
    "/App.js": "export default function App() { return null; }",
  });
  assert.deepEqual(globalThis.__moduleTest, {
    active: 0,
    disposed: 2,
    pruned: 1,
    accepted: 1,
  });
});

test("CSS changes update styles without reevaluating JS, and removed imports remove their styles", async (t) => {
  const p = setup(t);

  const files = {
    "/App.js": `import './child.css'; export default function App() {}`,
    "/child.css": "body { color: red; }",
    "/styles.css": "p { color: blue; }",
  };

  await p.apply(files);

  const next = await p.apply({
    ...files,
    "/child.css": "body { color: green; }",
  });

  assert.deepEqual(next.evaluated, []);
  assert.equal(p.styles().find((item) => item.id === "/child.css").code, "body { color: green; }");
  await p.apply({ ...files, "/App.js": "export default function App() {}" });
  assert.deepEqual(
    p.styles().map((item) => item.id),
    ["/styles.css"],
  );
});

test("a failed evaluation retains committed exports and the same source can recover", async (t) => {
  const p = setup(t);
  globalThis.__moduleTest = { fail: false };

  const files = {
    "/App.js": `import { value } from './value.js'; export default function App() { return value; }`,
    "/value.js": `export const value = 1;`,
  };

  const initial = await p.apply(files);
  files["/value.js"] =
    `export const value = 2; if (globalThis.__moduleTest.fail) throw new Error('failed update');`;
  globalThis.__moduleTest.fail = true;
  await assert.rejects(p.apply(files), /failed update/);
  assert.equal(initial.entry.default(), 1);
  globalThis.__moduleTest.fail = false;
  const result = await p.apply(files);
  assert.equal(result.entry.default(), 2);
});

test("a lazy module is evaluated only on demand and serialized with an overlapping update", async (t) => {
  const p = setup(t);
  let release;
  let started;

  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const loading = new Promise((resolve) => {
    started = resolve;
  });

  globalThis.__moduleTest = { loads: 0, gate, started };

  const files = {
    "/App.js": `export default function App() { return import('./lazy.js'); }`,
    "/lazy.js": `globalThis.__moduleTest.loads++; globalThis.__moduleTest.started(); await globalThis.__moduleTest.gate; export const value = 1;`,
  };

  const initial = await p.apply(files);
  assert.equal(globalThis.__moduleTest.loads, 0);
  const lazy = initial.entry.default();
  await loading;

  const update = p.apply({
    ...files,
    "/lazy.js": files["/lazy.js"].replace("= 1", "= 2"),
  });

  release();
  const namespace = await lazy;
  await update;
  assert.equal(namespace.value, 2);
  assert.equal((await initial.entry.default()).value, 2);
  assert.equal(globalThis.__moduleTest.loads, 2);
});

test("concurrent lazy imports share evaluation after the first continuation releases its graph", async (t) => {
  const p = setup(t);
  globalThis.__moduleTest = { loads: 0 };

  const initial = await p.apply({
    "/App.js":
      "export default function App(){return Promise.all([import('./lazy.js'), import('./lazy.js'), import('./other.js')]);}",
    "/lazy.js":
      "globalThis.__moduleTest.loads++; await Promise.resolve(); export const value = 41;",
    "/other.js": "import {value} from './lazy.js'; export const answer = value + 1;",
  });

  for (let i = 0; i < 2; i++) {
    const [a, b, c] = await initial.entry.default();
    assert.equal(a.value, 41);
    assert.equal(b.value, 41);
    assert.equal(c.answer, 42);
  }
  assert.equal(globalThis.__moduleTest.loads, 1);
});

test("a failed lazy import disposes its staged resources and can retry", async (t) => {
  const p = setup(t);
  globalThis.__moduleTest = { active: 0, fail: true };

  const initial = await p.apply({
    "/App.js": `export default function App() { return import('./lazy.js'); }`,
    "/lazy.js": `const state = globalThis.__moduleTest; state.active++;
      import.meta.hot.dispose(() => { state.active--; });
      if (state.fail) throw new Error('lazy failed'); export const value = 1;`,
  });

  await assert.rejects(initial.entry.default(), /lazy failed/);
  assert.equal(globalThis.__moduleTest.active, 0);
  globalThis.__moduleTest.fail = false;
  assert.equal((await initial.entry.default()).value, 1);
  assert.equal(globalThis.__moduleTest.active, 1);
});

test("the module ABI preserves ESM this, imported call receivers, shadowing and live shorthand exports", async (t) => {
  const p = setup(t);

  const files = {
    "/App.js": `import { value, increment, receiver } from './dep.js';
      export { value as live }; export const moduleThis = this;
      const arrow = () => typeof arguments;
      function shadow(value) { return { value }; }
      export default function App() { increment(); return [moduleThis, receiver(), { value }, shadow(9), arrow(), arguments.length]; }`,
    "/dep.js": `export let value = 0; export function increment() { value++; } export function receiver() { return this; }`,
  };

  const initial = await p.apply(files);
  assert.deepEqual(initial.entry.default(), [
    undefined,
    undefined,
    { value: 1 },
    { value: 9 },
    "undefined",
    0,
  ]);
  assert.deepEqual(initial.entry.default(), [
    undefined,
    undefined,
    { value: 2 },
    { value: 9 },
    "undefined",
    0,
  ]);
  assert.ok(
    !Object.values(p.compiler.compile(files).modules).some((m) => m.code.includes("__vite_")),
  );
});

test(
  "a committed loader can await dynamic import during an update and in an accept callback",
  { timeout: 2000 },
  async (t) => {
    const p = setup(t);

    const files = {
      "/App.js": `import { load } from './loader.js'; export default function App() { return load; }`,
      "/loader.js": `export async function load() { await Promise.resolve(); return import('./lazy.js'); }`,
      "/lazy.js": `export const value = 42;`,
    };

    await p.apply(files);

    const result = await p.apply({
      ...files,
      "/App.js": `import { load } from './loader.js'; const { value } = await load(); export default function App() { return value; }`,
    });

    assert.equal(result.entry.default(), 42);
    globalThis.__moduleTest = {};
    files["/loader.js"] +=
      `\nimport.meta.hot.accept(async () => { globalThis.__moduleTest.accepted = (await import('./lazy.js')).value; });`;
    await p.apply(files);
    await p.apply({
      ...files,
      "/loader.js": files["/loader.js"] + "\n// edit",
    });
    assert.equal(globalThis.__moduleTest.accepted, 42);
  },
);

test("all cleanup callbacks run once even when an earlier callback throws, including prune", async (t) => {
  const p = setup(t);
  globalThis.__moduleTest = { active: 0, first: 0, second: 0, pruned: 0 };

  const files = {
    "/App.js": `import './resource.js'; export default function App() {}`,
    "/resource.js": `const s=globalThis.__moduleTest; s.active++;
      import.meta.hot.dispose(() => {s.first++; throw new Error('cleanup failed');});
      import.meta.hot.dispose(() => {s.second++; s.active--;});
      import.meta.hot.prune(() => {throw new Error('prune failed');});
      import.meta.hot.prune(() => {s.pruned++;});`,
  };

  await p.apply(files);

  const result = await p.apply({
    ...files,
    "/resource.js": files["/resource.js"] + "\n// edit",
  });

  assert.equal(result.diagnostics[0].phase, "cleanup");
  assert.deepEqual(globalThis.__moduleTest, {
    active: 1,
    first: 1,
    second: 1,
    pruned: 0,
  });
  await p.runtime.dispose();
  await p.runtime.dispose();
  assert.deepEqual(globalThis.__moduleTest, {
    active: 0,
    first: 2,
    second: 2,
    pruned: 1,
  });
});

test("accept failure reports a post-commit diagnostic while keeping the published resource alive", async (t) => {
  const p = setup(t);
  globalThis.__moduleTest = { active: 0 };

  const files = {
    "/App.js": `import {value} from './resource.js'; export default function App(){return value;}`,
    "/resource.js": `globalThis.__moduleTest.active++; export const value=1;
      import.meta.hot.dispose(()=>{globalThis.__moduleTest.active--;});
      import.meta.hot.accept(()=>{throw new Error('accept failed');});`,
  };

  const first = await p.apply(files);

  const second = await p.apply({
    ...files,
    "/resource.js": files["/resource.js"].replace("value=1", "value=2"),
  });

  assert.equal(first.entry.default(), 2);
  assert.equal(second.entry.default(), 2);
  assert.equal(globalThis.__moduleTest.active, 1);
  assert.equal(second.diagnostics[0].phase, "notification");
  await p.runtime.dispose();
  assert.equal(globalThis.__moduleTest.active, 0);
});

test("a failed evaluation after retiring resources explicitly requires restart", async (t) => {
  const p = setup(t);
  globalThis.__moduleTest = { active: 0 };

  const files = {
    "/App.js": `import './resource.js'; export default function App(){}`,
    "/resource.js": `globalThis.__moduleTest.active++; import.meta.hot.dispose(()=>globalThis.__moduleTest.active--);`,
  };

  await p.apply(files);
  await assert.rejects(
    p.apply({
      ...files,
      "/resource.js": files["/resource.js"] + '\nthrow new Error("failed");',
    }),
    (error) => error.requiresRestart === true,
  );
  assert.equal(globalThis.__moduleTest.active, 0);
});

test(
  "closing during a pending evaluation settles apply and disposes owned staged resources",
  { timeout: 2000 },
  async (t) => {
    const p = setup(t);
    let started;

    const waiting = new Promise((resolve) => {
      started = resolve;
    });

    globalThis.__moduleTest = { active: 0, started };

    const update = p.apply({
      "/App.js": `globalThis.__moduleTest.active++;
    import.meta.hot.dispose(()=>{globalThis.__moduleTest.active--;});
    globalThis.__moduleTest.started(); await new Promise(()=>{}); export default function App(){}`,
    });

    const rejected = assert.rejects(update, /disposed/);
    await waiting;
    await p.runtime.dispose();
    await rejected;
    assert.equal(globalThis.__moduleTest.active, 0);
  },
);

test("the linker handles destructuring, reexport namespaces, anonymous defaults and lexical shadowing", async (t) => {
  const p = setup(t);

  const files = {
    "/App.js": `import {ns,renamed} from './barrel.js'; import {value, receiver} from './dep.js';
      const obj={value, method(value){return value;}};
      function shadow({value}) { return ()=>value; }
      const tag = receiver\`test\`;
      export default function /* comment ( */ () {return [ns.value,renamed,obj.value,obj.method(8),shadow({value:9})(),tag];}`,
    "/barrel.js": `export * as ns from './dep.js'; export {value as renamed} from './dep.js';`,
    "/dep.js": `export const {value, extra: alias} = {value:4, extra:5}; export function receiver(){return this;}`,
  };

  assert.deepEqual((await p.apply(files)).entry.default(), [4, 4, 4, 8, 9, undefined]);
  assert.equal((await p.apply({ "/App.js": "export default (1 + 2)" })).entry.default, 3);

  const Class = (
    await p.apply({
      "/App.js": "export default class { value(){return this;} }",
    })
  ).entry.default;

  const instance = new Class();
  assert.equal(instance.value(), instance);
});

test("module-level arguments and import writes cannot expose or mutate the ABI context", async (t) => {
  const p = setup(t);
  for (const source of ["arguments", "{arguments}", "(() => ({arguments}))()"])
    await assert.rejects(
      p.apply({
        "/App.js": `const leak=${source}; export default function App(){return leak;}`,
      }),
      (error) => error.cause instanceof ReferenceError,
    );
  assert.throws(
    () =>
      p.compiler.compile({
        "/App.js": `import {value} from './dep.js'; value++; export default function App(){}`,
        "/dep.js": "export let value=1;",
      }),
    /assign/,
  );
});

test(
  "a superseded fire-and-forget import cannot poison an unchanged committed importer",
  { timeout: 2000 },
  async (t) => {
    const p = setup(t);
    let release;
    let started;

    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const waiting = new Promise((resolve) => {
      started = resolve;
    });

    globalThis.__moduleTest = { gate, started, loads: 0 };

    const files = {
      "/App.js": `globalThis.__moduleTest.lazy=import('./lazy.js'); export default function App(){return import('./other.js');}`,
      "/lazy.js": `globalThis.__moduleTest.loads++; globalThis.__moduleTest.started(); await globalThis.__moduleTest.gate; export const value=1;`,
      "/other.js": `export const value=2;`,
      "/styles.css": "body{color:red}",
    };

    const initial = await p.apply(files);
    await waiting;
    await p.apply({ ...files, "/styles.css": "body{color:blue}" });
    release();
    assert.equal((await globalThis.__moduleTest.lazy).value, 1);
    assert.equal((await initial.entry.default()).value, 2);
  },
);

test("cleanup can register another cleanup without losing it", async (t) => {
  const p = setup(t);
  globalThis.__moduleTest = { count: 0 };
  await p.apply({
    "/App.js": `import.meta.hot.dispose(()=>{import.meta.hot.dispose(()=>globalThis.__moduleTest.count++);}); export default function App(){}`,
  });
  await p.runtime.dispose();
  assert.equal(globalThis.__moduleTest.count, 1);
});
