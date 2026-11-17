import { createEngine } from "../crates/compiler/engine.mjs";
import { compilerWorkloads } from "./compiler-workloads.mjs";

const yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0));

async function compare({ before, after }) {
  const results = {};
  for (const [name, [id, runtime, source]] of Object.entries(compilerWorkloads)) {
    const engines = { before: createEngine(before), after: createEngine(after) };
    const samples = { before: [], after: [] };
    const iterations = name === "small" ? 100 : 3;
    const compile = (version) => engines[version].compileModule(id, source, runtime);
    for (let i = 0; i < 20; i++) {
      compile("before");
      compile("after");
      if (i % 5 === 4) await yieldTask();
    }
    for (let round = 0; round < 9; round++) {
      for (const version of round % 2 ? ["after", "before"] : ["before", "after"]) {
        const start = performance.now();
        for (let i = 0; i < iterations; i++) compile(version);
        samples[version].push((performance.now() - start) / iterations);
      }
      await yieldTask();
    }
    const outputs = [];
    for (const version of ["before", "after"]) {
      const output = JSON.stringify(compile(version));
      outputs.push(output);

      const hash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(output)),
      );

      const times = samples[version].sort((a, b) => a - b);
      results[`${name}:${version}`] = {
        timing: { medianMs: times[4], samplesMs: times },
        sourceCharacters: source.length,
        memoryBytes: engines[version].memoryBytes(),
        outputSha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      };
    }
    if (outputs[0] !== outputs[1]) throw new Error(`Compiler output changed: ${name}`);
    await yieldTask();
  }
  return results;
}

self.onmessage = ({ data }) => {
  compare(data).then(
    (results) => postMessage({ results }),
    (error) => postMessage({ error: error.message }),
  );
};
