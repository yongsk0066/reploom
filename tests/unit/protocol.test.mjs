import { reactConfig } from "../fixtures/project-fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { compilerEngine as oxc } from "../fixtures/compiler/engine.mjs";

import { createProjectCompiler } from "../../packages/runtime/src/compiler/project-compiler.ts";
import {
  applyProgramPatch,
  diffProgram,
  errorDiagnostics,
} from "../../packages/runtime/src/shared/protocol.ts";
import { ProjectSession } from "../../packages/runtime/src/project/session.ts";

test("immutable editor revisions serialize only the latest compile, reuse untouched files and release on reset", async () => {
  const files = {
    "/App.js": "export default function App(){return <h1>ready</h1>}",
    "/styles.css": "body{}",
  };

  const compiler = createProjectCompiler(oxc, reactConfig);
  const output = compiler.compile(files);

  let scheduled;
  let resourcesReady;
  let id = 0;

  const requests = [];
  const reads = new Map();

  const resources = new Promise((resolve) => (resourcesReady = resolve));

  const source = (label) =>
    Object.freeze({
      length: label.length,
      toString() {
        reads.set(label, (reads.get(label) || 0) + 1);
        return label;
      },
    });

  const session = new ProjectSession("fixture", {
    newId: () => String(++id),
    schedule(task) {
      scheduled = task;
      return () => {
        scheduled = undefined;
      };
    },
    loadProject: async () => ({
      files,
      output,
      vendor: [],
      bootstrap: "",
      updateDelayMs: 120,
      compilerResources: () => resources,
    }),
    compiler: {
      compile: async (input) => {
        requests.push(input);
        return { ok: true, output };
      },
      release() {},
    },
  });

  const tick = () => new Promise((resolve) => setImmediate(resolve));
  await session.start();
  session.change("/App.js", source("superseded keystroke"));
  const composed = source("composing");
  session.change("/App.js", composed, true);
  assert.equal(scheduled, undefined);
  assert.equal(session.getSnapshot().files["/App.js"], composed);
  assert.equal(reads.size, 0);
  session.change("/App.js", composed);
  scheduled();
  await tick();
  // A newer edit arrives while the first compiler resources are loading.
  const latest = source("latest");
  session.change("/App.js", latest);
  scheduled();
  resourcesReady({ compiler: { url: "/unused", sha256: "unused" }, config: reactConfig });
  await tick();
  assert.deepEqual([...reads], [["latest", 1]]);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].files, { ...files, "/App.js": "latest" });
  assert.equal(session.getSnapshot().files["/App.js"], latest);
  session.change("/styles.css", "body {color:red}");
  scheduled();
  await tick();
  assert.deepEqual([...reads], [["latest", 1]]);
  assert.equal(requests[1].files["/styles.css"], "body {color:red}");
  session.rerun();
  scheduled();
  await tick();
  assert.equal(requests.length, 2);
  session.reset();
  assert.equal(session.getSnapshot().files, files);
  session.rerun();
  scheduled();
  await tick();
  assert.equal(requests.length, 2);
  session.change("/App.js", latest);
  scheduled();
  await tick();
  assert.deepEqual([...reads], [["latest", 2]]);
  session.dispose();
  assert.deepEqual(session.getSnapshot().files, {});
  compiler.dispose();
});

test("diagnostics retain messages with engine-specific stacks and remain cloneable", () => {
  const error = new Error("cleanup failed");
  error.stack = "@playground:/App.js:1:1";
  assert.match(errorDiagnostics(error)[0].text, /^Error: cleanup failed\n@/);
  error.stack = "Error: cleanup failed\n    at playground:/App.js:1:1";
  assert.equal(errorDiagnostics(error)[0].text, error.stack);
  assert.deepEqual(
    structuredClone(
      errorDiagnostics({
        diagnostics: [{ text: "failure", file() {}, column: () => 1 }],
      }),
    ),
    [
      {
        text: "failure",
        file: undefined,
        line: undefined,
        column: undefined,
        revision: undefined,
        phase: undefined,
      },
    ],
  );
  for (const revision of [3, -1, NaN, () => 3]) {
    const diagnostic = errorDiagnostics({ diagnostics: [{ text: "failure", revision }] })[0];
    assert.equal(diagnostic.revision, revision === 3 ? 3 : undefined);
    assert.doesNotThrow(() => structuredClone(diagnostic));
  }
  assert.deepEqual(
    errorDiagnostics({
      toString() {
        throw new Error("hidden");
      },
    }),
    [
      {
        text: "Could not read error details.",
        phase: undefined,
        file: undefined,
      },
    ],
  );
});

test("artifact deltas support skipped revisions, removals, mismatch rejection and full resynchronization", () => {
  const compiler = createProjectCompiler(oxc, reactConfig);

  const files = {
    "/App.js": `import './old.css'; export default function App(){return 'A';}`,
    "/old.css": "body{color:red}",
  };

  const first = { revision: 0, program: compiler.compile(files) };
  const initial = diffProgram(undefined, first);
  const decoded = applyProgramPatch(undefined, initial);

  const latest = {
    revision: 5,
    program: compiler.compile({
      "/App.js": `export default function App(){return 'B';}`,
    }),
  };

  const delta = diffProgram(first, latest);
  assert.deepEqual(delta.removed, ["/old.css"]);
  assert.deepEqual(Object.keys(delta.changed), ["/App.js"]);
  assert.equal(delta.baseRevision, 0);
  assert.deepEqual(applyProgramPatch(decoded, delta), latest);
  assert.throws(() => applyProgramPatch({ ...decoded, revision: 1 }, delta), /revision/);
  assert.deepEqual(applyProgramPatch(undefined, diffProgram(undefined, latest)), latest);
  assert.throws(() => applyProgramPatch(undefined, { ...initial, abi: 99 }), /revision/);
  compiler.dispose();
});

test("cancelled compilation salvages completed transforms without publishing a partial graph", async () => {
  const compiler = createProjectCompiler(oxc, reactConfig);

  const files = {
    "/App.js": "export default function App(){}",
    "/a.js": "export const a=1;",
    "/b.js": "export const b=1;",
  };

  compiler.compile(files);

  const edited = Object.fromEntries(
    Object.entries(files).map(([id, code]) => [id, code + "\n// changed"]),
  );

  let cancelled = false;
  await assert.rejects(
    compiler.compileAsync(edited, {
      budgetMs: 0,
      cancelled: () => cancelled,
      yieldTask: async () => {
        cancelled = true;
      },
    }),
    { name: "AbortError" },
  );
  const result = compiler.compile(edited);
  assert.deepEqual(result.transformed, ["/a.js", "/b.js"]);
  const clean = createProjectCompiler(oxc, reactConfig);
  assert.deepEqual(result.modules, clean.compile(edited).modules);
  clean.dispose();
  compiler.dispose();
});

test("session owns revision cancellation and restart policy through injected services", async () => {
  const compiler = createProjectCompiler(oxc, reactConfig);

  const files = Object.freeze({
    "/App.js": `export default function App(){return 'original';}`,
  });

  const output = compiler.compile(files);
  const requests = [];
  const releases = [];

  let id = 0;
  let scheduled;

  const services = {
    newId: () => String(++id),
    schedule(task) {
      scheduled = task;
      return () => {
        scheduled = undefined;
      };
    },
    loadProject: async () => ({
      files,
      output,
      updateDelayMs: 120,
      vendor: ["vendor"],
      bootstrap: "bootstrap",
      compilerResources: async () => ({
        compiler: { url: "/unused", sha256: "unused" },
        config: reactConfig,
      }),
    }),
    compiler: {
      compile(input, signal) {
        return new Promise((resolve) => requests.push({ input, signal, resolve }));
      },
      release(projectId) {
        releases.push(projectId);
      },
    },
  };

  const session = new ProjectSession("fixture", services);
  await session.start();
  const first = session.getSnapshot().snapshot;
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  session.change("/App.js", files["/App.js"] + "\n// first");
  scheduled();
  await tick();
  session.change("/App.js", files["/App.js"] + "\n// second");
  scheduled();
  await tick();
  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(Object.keys(requests[1].input.seed).sort(), ["files", "output"]);
  requests[0].resolve({ ok: true, output });
  await tick();
  assert.equal(session.getSnapshot().snapshot.revision, first.revision);
  requests[1].resolve({ ok: true, output });
  await tick();
  const current = session.getSnapshot().snapshot;
  assert.equal(current.generation, first.generation);
  session.onEvent({
    type: "restart-required",
    generation: first.generation,
    revision: first.revision,
  });
  const restarted = session.getSnapshot().snapshot;
  assert.notEqual(restarted.generation, first.generation);
  session.onEvent({
    type: "restart-required",
    generation: first.generation,
    revision: first.revision,
  });
  assert.equal(session.getSnapshot().snapshot, restarted);
  session.onEvent({
    type: "runtime-error",
    revision: current.revision,
    diagnostics: [{ text: "retired resources" }],
    requiresRestart: true,
  });
  session.change("/App.js", files["/App.js"] + "\n// recovered");
  scheduled();
  await tick();
  requests[2].resolve({ ok: true, output });
  await tick();
  assert.notEqual(session.getSnapshot().snapshot.generation, restarted.generation);
  session.dispose();
  session.dispose();
  assert.deepEqual(releases, [session.projectId]);
  assert.equal(session.getSnapshot().state.phase, "disposed");
  assert.equal(session.getSnapshot().snapshot, undefined);
  compiler.dispose();
});

test("a late repository response cannot resurrect a disposed session", async () => {
  let finish;

  const loaded = new Promise((resolve) => {
    finish = resolve;
  });

  const session = new ProjectSession("fixture", {
    newId: () => "id",
    loadProject: () => loaded,
    compiler: {
      release() {},
      compile() {
        throw new Error("unexpected");
      },
    },
    schedule() {
      throw new Error("unexpected");
    },
  });

  const starting = session.start();
  session.dispose();
  finish({ files: {}, output: {}, vendor: [], bootstrap: "" });
  await starting;
  assert.equal(session.getSnapshot().state.phase, "disposed");
});

for (const knownAsset of [false, true])
  test(`first editing intent prepares once and cancellation survives ${knownAsset ? "parallel" : "deferred"} configuration`, async () => {
    const compiler = createProjectCompiler(oxc, reactConfig);

    const files = Object.freeze({
      "/App.js": "export default function App(){return 'original'}",
    });

    const output = compiler.compile(files);
    const preparations = [];
    const scheduled = [];

    const resources = {
      compiler: { url: "/compiler.js", sha256: "test" },
      config: reactConfig,
    };

    let finish;
    let loads = 0;
    let downloadSignal;

    const services = {
      newId: () => "preparation-session",
      schedule(task) {
        scheduled.push(task);
        return () => {};
      },
      loadProject: async () => ({
        files,
        output,
        vendor: [],
        bootstrap: "",
        updateDelayMs: 120,
        compilerAsset: knownAsset ? resources.compiler : undefined,
        compilerResources(signal) {
          downloadSignal = signal;
          loads++;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      }),
      compiler: {
        async prepare(projectId, asset, signal) {
          preparations.push({ projectId, asset, signal });
        },
        compile() {
          throw new Error("No speculative compilation");
        },
        release() {},
      },
    };

    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const session = new ProjectSession("fixture", services);
    try {
      await session.start();
      assert.equal(loads, 0);
      session.change("/App.js", files["/App.js"] + "\n", true);
      assert.equal(loads, 1);
      assert.equal(scheduled.length, 0);
      await tick();
      assert.equal(preparations.length, knownAsset ? 1 : 0);
      finish(resources);
      await tick();
      session.change("/App.js", files["/App.js"] + "\n// complete");
      assert.equal(preparations.length, 1);
      assert.equal(loads, 1);
      assert.equal(scheduled.length, 1);
      session.dispose();
      assert.equal(preparations[0].signal.aborted, true);
      assert.equal(downloadSignal.aborted, true);

      await session.start();
      session.change("/App.js", files["/App.js"] + "\n", true);
      session.dispose();
      finish(resources);
      await tick();
      assert.equal(preparations.length, 1);
      assert.equal(session.getSnapshot().state.phase, "disposed");
    } finally {
      session.dispose();
      compiler.dispose();
    }
  });
