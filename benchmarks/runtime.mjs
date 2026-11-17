import { performance } from "node:perf_hooks";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { createProjectCompiler } from "../packages/runtime/src/compiler/project-compiler.ts";
import { composeTextPatch } from "../packages/runtime/src/shared/source-patch.ts";
import { diffProgram } from "../packages/runtime/src/shared/protocol.ts";
import { createEngine } from "../crates/compiler/engine.mjs";

const results = {};

function measure(name, run, iterations = 1000, rounds = 9) {
  for (let i = 0; i < Math.min(iterations, 200); i++) run(i);
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) run(i);
    samples.push((performance.now() - start) / iterations);
  }
  samples.sort((a, b) => a - b);
  results[name] = {
    medianMs: samples[Math.floor(rounds / 2)],
    maxMs: samples.at(-1),
    iterations,
    samplesMs: samples,
  };
}

const files = Object.fromEntries(
  Array.from({ length: 32 }, (_, i) => [`/m${i}.js`, `export const value = ${i};`]),
);

const config = {
  key: "benchmark",
  runtime: "dom",
  entry: "/m0.js",
  imports: {},
  styles: [],
  dependencyFiles: {},
};

const engine = {
  compilerVersion: "benchmark",
  compileModule(id, source) {
    return {
      id,
      kind: "js",
      code: source,
      specifiers: Object.keys(files).filter((path) => path !== id),
      dynamic: [],
    };
  },
};

const compiler = createProjectCompiler(engine, config);
const initial = compiler.compile(files);
measure("unchangedDenseGraph32", () => compiler.compile(files));
measure("oneChangedDenseGraph32", (i) =>
  compiler.compile({ ...files, "/m0.js": `export const value = ${i};` }),
);
const equivalent = structuredClone(initial);
measure("diffSameGraph32", () =>
  diffProgram({ revision: 1, program: initial }, { revision: 2, program: initial }),
);
measure("diffEquivalentGraph32", () =>
  diffProgram({ revision: 1, program: initial }, { revision: 2, program: equivalent }),
);
compiler.dispose();

for (const count of [1, 32, 128]) {
  const previous = {
    baseLength: 1_000_000,
    edits: Array.from({ length: count }, (_, i) => ({
      from: i * 7000,
      to: i * 7000 + 1,
      insert: "x",
    })),
  };

  const edits = previous.edits.map(({ from, to }) => ({ from: from + 2, to: to + 2, insert: "y" }));
  measure(`compose${count}Cursors`, () => composeTextPatch(previous, edits), 3000);
}

const wasm = await WebAssembly.compile(
  await readFile(new URL("../crates/compiler/artifacts/compiler.wasm", import.meta.url)),
);

const real = createEngine(wasm);
for (const count of [10, 1000]) {
  const source = Array.from(
    { length: count },
    (_, i) => `export function f${i}(a: number) { return a + ${i}; }`,
  ).join("\n");

  measure(
    `wasmTransform${count}Functions`,
    () => real.compileModule("/large.ts", source, "dom"),
    count === 10 ? 100 : 10,
    7,
  );
}

const output = {
  date: new Date().toISOString(),
  node: process.version,
  cpu: cpus()[0].model,
  results,
};

await mkdir(new URL("../artifacts/benchmarks/", import.meta.url), { recursive: true });
await writeFile(
  new URL(`../artifacts/benchmarks/${process.argv[2] || "runtime"}.json`, import.meta.url),
  JSON.stringify(output, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value.medianMs])),
    null,
    2,
  ),
);
