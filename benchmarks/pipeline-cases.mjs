import { createEngine } from "../crates/compiler/engine.mjs";

async function compilePhases(inputs) {
  const module = await WebAssembly.compile(await (await fetch("/compiler.wasm")).arrayBuffer());
  const results = [];
  const payloads = [];
  for (const input of inputs) {
    let points;

    const engine = createEngine(module, {
      now: () => 0,
      onCheckpoint(phase) {
        points.push({ phase, time: performance.now() });
      },
    });

    let artifact;
    const iterations = input.source.length < 12000 ? 20 : 1;
    const samples = [];
    for (let round = 0; round < 8; round++) {
      const phases = Array(10).fill(0);
      for (let iteration = 0; iteration < iterations; iteration++) {
        points = [];
        const start = performance.now();
        artifact = engine.compileModule(input.path, input.source, input.runtime);
        points.push({ phase: 9, time: performance.now() });
        let previous = start;
        for (const point of points) {
          phases[point.phase] += (point.time - previous) / iterations;
          previous = point.time;
        }
      }
      samples.push({ phases, total: phases.reduce((a, b) => a + b, 0) });
    }
    const original = await import("/original-engine.mjs");

    const control = original
      .createEngine(module)
      .compileModule(input.path, input.source, input.runtime);

    if (JSON.stringify(control) !== JSON.stringify(artifact))
      throw Error("Instrumented output differs");
    const program = JSON.stringify({ modules: { [input.path]: artifact } });
    const sources = JSON.stringify({ [input.path]: input.source });
    results.push({
      name: input.name,
      characters: input.source.length,
      iterations,
      samples,
      memoryBytes: engine.memoryBytes(),
      codeCharacters: artifact.code.length,
      mapCharacters: artifact.sourceMap.length,
    });
    payloads.push({ name: input.name, program, sources });
  }
  return { results, payloads };
}

const workerReply = (worker, data, transfer = []) =>
  new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = reject;
    worker.postMessage(data, transfer);
  });

async function decodeCosts(payloads) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const workerCode = `onmessage=({data})=>{
    if(data.ready){postMessage(null);return;}
    const start=performance.now();
    const values=data.bytes.map(b=>JSON.parse(new TextDecoder().decode(b)));
    postMessage({parseMs:performance.now()-start,values});
  }`;

  const url = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
  const worker = new Worker(url);
  const results = [];
  try {
    await workerReply(worker, { ready: true });
    for (const payload of payloads) {
      const bytes = [encoder.encode(payload.program), encoder.encode(payload.sources)];
      const main = [];
      const warmWorker = [];
      const coldWorker = [];
      for (let round = 0; round < 7; round++) {
        const started = performance.now();
        const values = bytes.map((value) => JSON.parse(decoder.decode(value)));
        main.push(performance.now() - started);
        for (const cold of [false, true]) {
          const inputs = bytes.map((value) => value.slice());
          const start = performance.now();
          const target = cold ? new Worker(url) : worker;
          try {
            const result = await workerReply(
              target,
              { bytes: inputs },
              inputs.map((value) => value.buffer),
            );

            const elapsed = performance.now() - start;
            if (JSON.stringify(result.values) !== JSON.stringify(values))
              throw Error("Worker JSON differs");
            (cold ? coldWorker : warmWorker).push({ elapsedMs: elapsed, parseMs: result.parseMs });
          } finally {
            if (cold) target.terminate();
          }
        }
      }
      results.push({
        name: payload.name,
        bytes: bytes.map((value) => value.length),
        main,
        warmWorker,
        coldWorker,
      });
    }
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
  return results;
}

if (typeof document === "undefined") {
  onmessage = async ({ data }) => {
    try {
      postMessage(await compilePhases(data));
    } catch (error) {
      postMessage({ error: error.stack });
    }
  };
} else {
  globalThis.runPipelineCosts = async (inputs) => {
    const worker = new Worker("/cases.js");
    try {
      const result = await workerReply(worker, inputs);
      if (result.error) throw Error(result.error);
      return { compiler: result.results, decoding: await decodeCosts(result.payloads) };
    } finally {
      worker.terminate();
    }
  };
}
