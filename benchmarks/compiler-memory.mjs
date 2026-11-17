import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createEngine } from "../crates/compiler/engine.mjs";
import { compilerWorkloads } from "./compiler-workloads.mjs";

const filename = process.argv[2] || "crates/compiler/artifacts/compiler.wasm";
const label = process.argv[3] || "compiler-memory";
const binary = await readFile(filename);
const wasm = await WebAssembly.compile(binary);
const results = {};
for (const [name, [id, runtime, source]] of Object.entries(compilerWorkloads)) {
  const checkpoints = [];

  const engine = createEngine(wasm, {
    yieldTask: () => Promise.resolve(),
    onCheckpoint: (phase) => checkpoints.push({ phase, time: performance.now() }),
  });

  const samples = [];
  const iterations = source.length < 10000 ? 50 : 1;
  let output;
  for (let i = 0; i < 27; i++) {
    const start = performance.now();
    for (let n = 0; n < iterations; n++) output = engine.compileModule(id, source, runtime);
    if (i >= 6) samples.push((performance.now() - start) / iterations);
  }
  samples.sort((a, b) => a - b);
  const phaseSamples = Array.from({ length: 6 }, () => []);
  for (let i = 0; i < 7; i++) {
    checkpoints.length = 0;
    const start = performance.now();
    await engine.compileModuleAsync(id, source, runtime, () => false);
    checkpoints.forEach(({ phase, time }, index) =>
      phaseSamples[phase - 1].push(time - (index ? checkpoints[index - 1].time : start)),
    );
  }
  results[name] = {
    sourceCharacters: source.length,
    memoryBytes: engine.memoryBytes(),
    medianMs: samples[10],
    samplesMs: samples,
    stageIntervalsMs: phaseSamples.map((values) => values.sort((a, b) => a - b)[3]),
    outputSha256: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
  };
}
const result = { wasmSha256: createHash("sha256").update(binary).digest("hex"), results };
await mkdir("artifacts/benchmarks", { recursive: true });
await writeFile(`artifacts/benchmarks/${label}.json`, JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(results).map(([name, value]) => [
        name,
        { memoryMiB: value.memoryBytes / 1048576, medianMs: value.medianMs },
      ]),
    ),
    null,
    2,
  ),
);
