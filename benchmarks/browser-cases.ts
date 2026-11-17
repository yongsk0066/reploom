import { Text } from "@codemirror/state";
import { documentChange } from "../packages/ui/src/codemirror/document-change.ts";
import { createEngine } from "../crates/compiler/engine.mjs";
import { createBrowserPlatform } from "../packages/runtime/src/browser/platform.ts";
import { createAssetRepository } from "../packages/runtime/src/shared/assets.ts";

async function compilerComparison(current: WebAssembly.Module) {
  const previous = await WebAssembly.compile(
    await (await fetch("/compiler-before.wasm")).arrayBuffer(),
  );

  const worker = new Worker("/compiler-bench.js");
  try {
    return await new Promise((resolve, reject) => {
      worker.onerror = reject;
      worker.onmessage = ({ data }) =>
        data.error ? reject(new Error(data.error)) : resolve(data.results);
      worker.postMessage({ before: previous, after: current });
    });
  } finally {
    worker.terminate();
  }
}

async function initialLoading() {
  const contents = new Map<string, string>();

  const declare = async (url: string, body: string) => {
    contents.set(url, body);
    const bytes = new TextEncoder().encode(body);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return { url, sha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("") };
  };

  const binary = { ...(await declare("image", "pixels")), type: "image/png" };
  const assets = { "/image.png": binary };

  const program = await declare(
    "program",
    JSON.stringify({ schema: 8, abi: 4, resources: { assets } }),
  );

  const sources = await declare("sources", JSON.stringify({ "/a.js": "export{}" }));
  const vendor = await declare("vendor", "dependency");
  const bootstrap = await declare("bootstrap", "bootstrap");

  const manifest = {
    schema: 2,
    protocol: 7,
    moduleABI: 4,
    bootstrap,
    projects: { example: { sources, program, assets, vendor: [vendor] } },
  };

  const options = {
    manifestUrl: `${location.origin}/runtime/manifest.json`,
    fetch: async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const name = new URL(url).pathname.split("/").at(-1)!;
      return name === "manifest.json" ? Response.json(manifest) : new Response(contents.get(name));
    },
  };

  const results = {};
  for (const strategy of ["program-discovery", "manifest-discovery"]) {
    const samples = [];
    for (let i = 0; i < 9; i++) {
      const start = performance.now();
      if (strategy === "manifest-discovery") {
        const platform = createBrowserPlatform(options);
        try {
          await platform.services.loadProject("example");
        } finally {
          platform.dispose();
        }
      } else {
        const repository = createAssetRepository(options);
        try {
          const index = await repository.loadManifest();
          const item = index.projects.example;

          const [source, text] = await Promise.all([
            repository.loadAsset(item.sources),
            repository.loadAsset(item.program),
            ...item.vendor.map(repository.loadAsset),
            repository.loadAsset(index.bootstrap),
          ]);

          JSON.parse(source);
          const output = JSON.parse(text);
          await Promise.all(
            Object.values(output.resources.assets).map((asset) =>
              repository.loadBinaryAsset(asset),
            ),
          );
        } finally {
          repository.dispose();
        }
      }
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    results[strategy] = { medianMs: samples[4], samplesMs: samples };
  }
  return results;
}

function measure(run: () => unknown, iterations = 50, rounds = 7) {
  for (let i = 0; i < 10; i++) run();
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) run();
    samples.push((performance.now() - start) / iterations);
  }
  samples.sort((a, b) => a - b);
  return { medianMs: samples[Math.floor(rounds / 2)], samplesMs: samples };
}

// Baseline from 56bb516. This intentionally measures the old flatten-and-scan path.
function flattenedChange(before: Text, after: Text) {
  const a = before.toString();
  const b = after.toString();
  let from = 0;
  let oldEnd = a.length;
  let newEnd = b.length;
  while (from < oldEnd && from < newEnd && a.charCodeAt(from) === b.charCodeAt(from)) from++;
  while (oldEnd > from && newEnd > from && a.charCodeAt(oldEnd - 1) === b.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  return { from, to: oldEnd, insert: after.slice(from, newEnd) };
}

async function transport() {
  const url = URL.createObjectURL(
    new Blob(
      [
        `
    const decoder = new TextDecoder();
    onmessage = ({data}) => {
      const value = data.mode === 'clone' ? data.value : JSON.parse(decoder.decode(data.value));
      postMessage(value.changed['/main.js'].code.length);
    };
  `,
      ],
      { type: "text/javascript" },
    ),
  );

  const worker = new Worker(url);
  const encoder = new TextEncoder();
  const results = {};
  try {
    for (const bytes of [4096, 262144, 2097152]) {
      const value = {
        revision: 2,
        baseRevision: 1,
        changed: {
          "/main.js": { kind: "js", code: "x".repeat(bytes), imports: {}, dependencies: [] },
        },
        removed: [],
      };

      for (const mode of ["clone", "transfer"]) {
        const samples = [];
        const sender = [];
        const batch = 100;
        for (let round = 0; round < 8; round++) {
          const batchStart = performance.now();
          let senderTime = 0;
          for (let i = 0; i < batch; i++) {
            value.revision = round * batch + i + 2;
            value.changed["/main.js"].code =
              "x".repeat(bytes - 8) + String(value.revision).padStart(8, " ");

            const reply = new Promise<number>((resolve, reject) => {
              worker.onmessage = (event) => resolve(event.data);
              worker.onerror = reject;
            });

            const start = performance.now();
            if (mode === "clone") worker.postMessage({ mode, value });
            else {
              const buffer = encoder.encode(JSON.stringify(value));
              worker.postMessage({ mode, value: buffer }, [buffer.buffer]);
            }
            const sent = performance.now();
            if ((await reply) !== bytes) throw new Error("Transport corrupted the payload");
            senderTime += sent - start;
          }
          if (round) {
            samples.push((performance.now() - batchStart) / batch);
            sender.push(senderTime / batch);
          }
        }
        samples.sort((a, b) => a - b);
        sender.sort((a, b) => a - b);
        results[`${bytes}:${mode}`] = {
          medianMs: samples[3],
          senderMedianMs: sender[3],
          samplesMs: samples,
        };
      }
    }
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
  return results;
}

async function preparedJSON(artifact, source: string) {
  const program = JSON.stringify({ modules: { "/large.ts": artifact } });
  const sources = JSON.stringify({ "/large.ts": source });
  const bytes = new TextEncoder().encode(program);
  const decoder = new TextDecoder();
  const local = measure(() => JSON.parse(decoder.decode(bytes)), 15);

  const url = URL.createObjectURL(
    new Blob(["onmessage=({data})=>postMessage(JSON.parse(new TextDecoder().decode(data)))"], {
      type: "text/javascript",
    }),
  );

  const samples = [];
  try {
    for (let i = 0; i < 7; i++) {
      const input = bytes.slice();
      const start = performance.now();
      const worker = new Worker(url);
      try {
        const reply = new Promise((resolve, reject) => {
          worker.onmessage = ({ data }) => resolve(data);
          worker.onerror = reject;
        });

        worker.postMessage(input, [input.buffer]);
        const output = await reply;
        if (output.modules["/large.ts"].code !== artifact.code)
          throw new Error("JSON round trip corrupted the program");
        samples.push(performance.now() - start);
      } finally {
        worker.terminate();
      }
    }
  } finally {
    URL.revokeObjectURL(url);
  }
  samples.sort((a, b) => a - b);
  return {
    programBytes: bytes.byteLength,
    sourcesBytes: new TextEncoder().encode(sources).byteLength,
    decodeParseMain: local,
    coldWorkerDecodeClone: { medianMs: samples[3], samplesMs: samples },
  };
}

async function run(compare = false) {
  const results = {};
  for (const shape of ["lines", "single-line"]) {
    const text =
      shape === "lines"
        ? "const value = 'abcdefghijklmnopqrstuvwxyz';\n".repeat(22000)
        : "a".repeat(946000);

    const before = Text.of(text.split("\n"));
    const offset = Math.floor(text.length / 2);
    const after = Text.of((text.slice(0, offset) + "X" + text.slice(offset + 1)).split("\n"));
    for (const [name, find] of [
      ["flatten", flattenedChange],
      ["tree", documentChange],
    ] as const) {
      const change = find(before, after);
      if (!before.replace(change.from, change.to, change.insert).eq(after))
        throw new Error("Invalid document edit");
      results[`editor:${shape}:${name}`] = measure(() => find(before, after), 30);
    }
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  for (const alphabet of ["ascii", "unicode"]) {
    const source = (
      alphabet === "ascii" ? "export const x = 1;\n" : "const 이름 = '한글😀';\n"
    ).repeat(20000);

    const memory = new WebAssembly.Memory({ initial: Math.ceil((source.length * 3) / 65536) });
    const destination = new Uint8Array(memory.buffer);
    results[`input:${alphabet}:encode-copy`] = measure(() =>
      destination.set(encoder.encode(source)),
    );
    results[`input:${alphabet}:encode-into`] = measure(() =>
      encoder.encodeInto(source, destination),
    );
    results[`input:${alphabet}:checked-into`] = measure(() =>
      /^\p{ASCII}*$/u.test(source)
        ? encoder.encodeInto(source, destination.subarray(0, source.length))
        : destination.set(encoder.encode(source)),
    );
    const json = JSON.stringify({ modules: { "/main.js": { code: source, sourceMap: source } } });
    const encoded = encoder.encode(json);
    results[`initial:${alphabet}:decode-parse`] = measure(() =>
      JSON.parse(decoder.decode(encoded)),
    );
  }

  const wasm = await WebAssembly.compile(await (await fetch("/compiler.wasm")).arrayBuffer());
  if (compare) results.compilerComparison = await compilerComparison(wasm);
  const phases = [];

  const engine = createEngine(wasm, {
    onCheckpoint: (phase) => phases.push({ phase, time: performance.now() }),
    yieldTask: () => new Promise((resolve) => setTimeout(resolve, 0)),
  });

  const source = Array.from(
    { length: 10000 },
    (_, i) => `export function f${i}(a: number) { return a + ${i}; }`,
  ).join("\n");

  results.wasm = {
    sourceCharacters: source.length,
    timing: measure(() => engine.compileModule("/large.ts", source, "dom"), 5),
    memoryBytes: engine.memoryBytes(),
    jspi: engine.supportsJSPI,
  };
  phases.length = 0;
  const start = performance.now();
  await engine.compileModuleAsync("/large.ts", source, "dom", () => false);
  results.checkpoints = phases.map((value, i) => ({
    phase: value.phase,
    precedingMs: value.time - (i ? phases[i - 1].time : start),
  }));
  results.preparedJSON = await preparedJSON(
    engine.compileModule("/large.ts", source, "dom"),
    source,
  );
  results.transport = await transport();
  results.initialLoading = await initialLoading();
  return results;
}

Object.assign(globalThis, { runBenchmarks: run });
