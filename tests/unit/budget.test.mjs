import test from "node:test";
import assert from "node:assert/strict";
import { createContext, Script } from "node:vm";
import { compilerEngine as oxc } from "../fixtures/compiler/engine.mjs";

import { createProjectCompiler } from "../../packages/runtime/src/compiler/project-compiler.ts";
import { createModuleRuntime } from "../../packages/runtime/src/execution/module-runtime.ts";
import { createModulePolicy } from "../../packages/runtime/src/execution/adapters/policy.ts";
import { createExecutionBudget } from "../../packages/runtime/src/execution/budget.ts";
import { defineProject } from "../../packages/runtime/src/project/definition.ts";
import { displayValue } from "../../packages/runtime/src/execution/compute/protocol.ts";

const config = {
  key: "budget",
  runtime: "dom",
  entry: "/main.js",
  styles: [],
  imports: {},
  dependencyFiles: {},
};

const sources = [
  `export function value() { const a=[]; outer: for(let i=0;i<5;i++) { for(let j=0;j<4;j++) { if(j===1) continue outer; a.push(i+j); } } return a; }`,
  `export function value() { let n=0; outer: do { n++; if(n<3) continue outer; break; } while(true); for(;n<6;n++); while(n<8) n++; return n; }`,
  `export function value() { const a=[]; for(const key in {a:1,b:2}) a.push(key); for(const [x,y] of [[1,2],[3,4]]) { a.push(x+y); } return a; }`,
  `export function value(){ let closed=0; function* values(){try {yield 1; yield 2;}finally{closed++}} for(const n of values()) break; return closed; }`,
  `export function value(){ const arrows=[()=>()=>({x:1}),()=>typeof arguments]; return [arrows[0]()(), arrows[1]()]; }`,
  `export function value(){ "use strict"; const f=function(a=2,...rest){return [this,a,rest]}; const o={x:4,get y(){return this.x+1},f(){return this.x}}; return [f.call(3,4,5),o.y,o.f()]; }`,
  `export function value(){ class A { constructor(x){this.x=x} value(){return this.x} } class B extends A { constructor(x){super(x+1)} value(){return super.value()+1} } return new B(2).value(); }`,
  `export async function value(){ const result=[]; for await (const n of [Promise.resolve(1),2]) result.push(n); try { throw 3; } catch({toString}) { result.push(typeof toString); } finally { result.push(4); } return result; }`,
  `export function value(){ const f=(x=()=>({n:4}))=>x(); function* g(){yield* [1,2]} return [f(),[...g()]]; }`,
  `export function value(){ const o={x:1}; let n=0; a: b: for(;;) { if(++n<3)continue a; break b; } return [o?.x,n]; }`,
];

test("budget instrumentation preserves native JS control flow, receivers, directives, closures, generators and async iteration", async () => {
  for (const source of sources) {
    const native = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );

    const realm = createContext({});
    const compiler = createProjectCompiler(oxc, config);
    let checks = 0;

    const runtime = createModuleRuntime(
      createModulePolicy({}),
      ({ code }) => new Script(`(${code})`).runInContext(realm),
      undefined,
      undefined,
      {
        budgetMs: 8,
        yieldTask: async () => {},
        checkpoint: () => checks++,
      },
    );

    try {
      const compiled = compiler.compile({ [config.entry]: source });
      const { entry } = await runtime.apply(compiled, () => {});

      const a = await native.value();
      const b = await entry.value();

      assert.equal(JSON.stringify(b), JSON.stringify(a), source);
      assert.ok(checks > 1);
    } finally {
      await runtime.dispose();
      compiler.dispose();
    }
  }
});

test("budget violations stop labeled continue loops and cannot be swallowed by a user catch", async () => {
  let clock = 0;
  const budget = createExecutionBudget(8, () => ++clock);
  const realm = createContext({});
  const compiler = createProjectCompiler(oxc, config);

  const runtime = createModuleRuntime(
    createModulePolicy({}),
    ({ code }) => new Script(`(${code})`).runInContext(realm),
    undefined,
    undefined,
    {
      budgetMs: 8,
      yieldTask: async () => {},
      checkpoint: budget.checkpoint,
      beforeCleanup: budget.beforeCleanup,
    },
  );

  try {
    const { entry } = await runtime.apply(
      compiler.compile({
        [config.entry]: `export function value(){try { again: for(;;)continue again; }catch { return 'swallowed'; } }`,
      }),
      () => {},
    );

    realm.value = entry.value;
    assert.throws(
      () => new Script("value()").runInContext(realm, { timeout: 1000 }),
      /Synchronous execution budget of/,
    );
    assert.throws(() => budget.checkpoint("/other.js"), /Synchronous execution budget of/);
    assert.equal(budget.normalizeError("Script error.").name, "ExecutionBudgetError");
    await budget.beforeCleanup();
    assert.equal(budget.normalizeError("unrelated"), "unrelated");
    assert.doesNotThrow(() => budget.checkpoint("/next-task.js"));
  } finally {
    await runtime.dispose();
    budget.dispose();
    compiler.dispose();
  }
});

test("microtask continuations share one budget; a real task gets a fresh one", async () => {
  let clock = 0;
  const budget = createExecutionBudget(8, () => ++clock);
  try {
    await assert.rejects(async () => {
      for (let i = 0; i < 4096; i++) {
        budget.checkpoint("/async.js");
        await Promise.resolve();
      }
    }, /Synchronous execution budget of/);
    await budget.beforeCleanup();
    assert.doesNotThrow(() => budget.checkpoint("/after-task.js"));
  } finally {
    budget.dispose();
  }
});

test("compute execution preserves results without cooperative checks in its hot loop", async () => {
  for (const kind of ["dom", "compute"]) {
    const compiler = createProjectCompiler(oxc, { ...config, runtime: kind });
    let checks = 0;

    const runtime = createModuleRuntime(
      createModulePolicy({}),
      ({ code }) => new Script(`(${code})`).runInNewContext(),
      undefined,
      undefined,
      { budgetMs: 8, yieldTask: async () => {}, checkpoint: () => checks++ },
    );

    try {
      const { entry } = await runtime.apply(
        compiler.compile({
          [config.entry]:
            "export function run(){let sum=0;for(let i=0;i<5000;i++)sum+=i;return sum;}",
        }),
        () => {},
      );

      assert.equal(entry.run(), 12_497_500);
      if (kind === "compute") assert.equal(checks, 0);
      else assert.ok(checks >= 5000);
    } finally {
      await runtime.dispose();
      compiler.dispose();
    }
  }
});

test("registered cleanup receives a fresh bounded turn after an evaluation budget error", async () => {
  let clock = 0;
  const budget = createExecutionBudget(8, () => ++clock);
  const realm = createContext({ cleaned: 0 });
  const compiler = createProjectCompiler(oxc, config);

  const runtime = createModuleRuntime(
    createModulePolicy({}),
    ({ code }) => new Script(`(${code})`).runInContext(realm),
    undefined,
    undefined,
    {
      budgetMs: 8,
      yieldTask: async () => {},
      checkpoint: budget.checkpoint,
      beforeCleanup: budget.beforeCleanup,
    },
  );

  try {
    await assert.rejects(
      runtime.apply(
        compiler.compile({
          [config.entry]: `import.meta.hot.dispose(()=>globalThis.cleaned++); for(let i=0;i<10000;i++){} export const value=1;`,
        }),
        () => {},
      ),
      /Synchronous execution budget of/,
    );
    assert.equal(realm.cleaned, 1);
  } finally {
    await runtime.dispose();
    budget.dispose();
    compiler.dispose();
  }
});

test("project execution limits are validated and result serialization bounds arrays, cycles and getters", () => {
  const p = {
    id: "compute",
    title: "Compute",
    runtime: "compute",
    entry: "/main.js",
    files: { "/main.js": "export function run(){}" },
  };

  assert.deepEqual(defineProject(p).execution, {
    mode: "worker",
    timeoutMs: 2000,
  });
  assert.throws(() => defineProject({ ...p, execution: { taskMs: Infinity } }), /execution budget/);
  assert.throws(() => defineProject({ ...p, execution: { timeoutMs: 0 } }), /Compute timeout/);
  let reads = 0;

  const value = {
    get hidden() {
      reads++;
      return 42;
    },
  };

  value.self = value;

  const text = displayValue({
    value,
    array: new Uint8Array(1_000_000),
    long: "a".repeat(100_000),
    big: 12n,
  });

  assert.equal(reads, 0);
  assert.ok(text.length < 32_001);
  assert.match(text, /Getter/);
});
