# Integrating Reploom

Integrating Reploom takes two steps: a Node build that bundles dependencies and precompiles each project into static files, and a browser client that mounts the initial preview and compiles edits locally.

## Declare a project

Install matching package archives as described in [private distribution](development.md#github-actions), then create `reploom.config.mjs` next to the consumer's `package.json`:

```js
import { defineProject } from "@yongsk0066/reploom";

export default {
  outDir: "./public/reploom",
  publicBase: "/reploom/",
  projects: [
    defineProject({
      id: "counter",
      title: "A DOM counter",
      runtime: "dom",
      entry: "/main.js",
      files: {
        "/main.js": `export function mount(root, { state, signal }) {
        state.count ??= 0;
        const button = document.createElement('button');
        const paint = () => { button.textContent = 'Count ' + state.count; };
        button.addEventListener('click', () => { state.count++; paint(); }, { signal });
        root.append(button);
        paint();
      }`,
      },
    }),
  ],
};
```

```sh
pnpm exec reploom prepare ./reploom.config.mjs
```

You can also run preparation programmatically with `prepareProjects(options)`. Relative output paths resolve against `projectRoot`, which also selects the consumer's installed dependencies. In the CLI, it defaults to the config file's directory. `publicDir` sets the root for declared binary assets, and `publicBase` must be a root-relative URL directory ending in `/`.

Publish the entire generated directory, including `manifest.json`, hashed assets, and license notices, at `/reploom/` on the page's origin. Serve `.wasm` files with `application/wasm` and `.mjs` files with a JavaScript MIME type, and exclude the directory from SPA HTML fallbacks.

Regenerate these assets when upgrading Reploom packages. The current contract uses manifest schema 2, protocol 8, program schema 8, and module ABI 4. Deploy the matching runtime and prepared directory together.

## Use a headless session

```js
import { ProjectSession } from "@yongsk0066/reploom";
import { createBrowserPlatform, attachPreview } from "@yongsk0066/reploom/browser";

const platform = createBrowserPlatform({ manifestUrl: "/reploom/manifest.json" });
const session = new ProjectSession("counter", platform.services);
const preview = attachPreview(session, document.querySelector("#preview"), "Counter", platform);
const unsubscribe = session.subscribe(() => {
  const view = session.getSnapshot();
  document.querySelector("#status").textContent = view.state.phase;
});
await session.start();

// Connect this to your editor. Paths identify existing project files.
function edit(source) {
  session.change("/main.js", source);
}

async function dispose() {
  unsubscribe();
  await preview.dispose();
  session.dispose();
  platform.dispose();
}
```

A platform manages the shared compiler Worker and verified asset cache across multiple sessions. Separate platforms keep their caches and Workers isolated even when project IDs match. Each session supports one active preview; during teardown, dispose previews and sessions before their shared platform. The `/internal/*` exports serve the build package and are not a supported integration API.

`createBrowserPlatform` accepts `compilerLifetime: { maxMemoryBytes, minLifetimeMs, idleMs }`. Defaults are 64 MiB, 30 seconds, and 30 seconds. Memory pressure requests replacement at the next compile after the minimum lifetime, once pending work and artifact acknowledgements settle. The preview keeps running; only the compiler's sources and caches are reseeded. See [lifecycle](architecture.md#memory-and-lifecycle) for the ownership boundary.

String-based editors can call `change(path, source)`. Editors backed by persistent text trees can supply `change(path, source, composing, edits)` with incremental UTF-16 edit spans to avoid serializing the full document on every keystroke. The CodeMirror adapter supplies these operations automatically.

Projects use adaptive update admission by default: an idle first edit starts on the next task; closely spaced input and continuing work use a 40–120 ms trailing wait based on input intervals and observed execution cost, with a requested pending-edit deadline of 240 ms. Completion preserves the input timestamp so fast compiles still coalesce typing bursts. Set `updateDelayMs` in the project declaration for a fixed delay. These are scheduling targets; Worker startup, compilation, rendering, and browser throttling contribute additional time. Custom session hosts can inject `createAdmission` and a monotonic `now` clock through `SessionServices`.

`session.prepare()` optionally warms compiler resources without changing source or preview state. Concurrent calls share one task; successful preparation waits for engine readiness. Preparation is best-effort, and the next compilation reports loading failures and retries. Session or platform disposal releases its preparation consumer.

## Use the React view

The React view connects to the same session API described below.

```tsx
import { createRoot } from "react-dom/client";
import { createBrowserPlatform } from "@yongsk0066/reploom/browser";
import { Playground } from "@yongsk0066/reploom-ui/react";
import "@yongsk0066/reploom-ui/styles.css";

export function mountExample(host: HTMLElement) {
  const platform = createBrowserPlatform({ manifestUrl: "/reploom/manifest.json" });
  const root = createRoot(host);
  root.render(<Playground project="counter" title="Counter" platform={platform} />);
  return () => {
    root.unmount();
    platform.dispose();
  };
}
```

`Playground` manages its session and preview lifecycle, while the caller owns the platform. Create the platform inside an explicit mount function or a mounting effect. The wrapper supports React Strict Mode's development setup, cleanup, and setup cycle.

By default, `Playground` mounts the full editor eagerly. Setting `editorActivation="interaction"` shows a read-only source preview and an Edit code button; clicking it loads CodeMirror. If the editor fails to load, an editable textarea provides a fallback.

Set `compilerActivation="interaction"` to start compiler preparation on editor focus or pointer input; its default, `"edit"`, keeps read-only sessions free of compiler downloads. This option moves startup work before the first edit and may download resources for an interaction that never becomes an edit.

Customize the host UI through the `labels` prop; the React entry exports `defaultLabels` and `PlaygroundLabels`. Compiler diagnostics and compute output have separate text. Styles use the `reploom-` class prefix and read `--reploom-background`, `--reploom-text`, and `--reploom-border` from `.reploom`.

The view's Project tools panel exposes file operations, JSON download/upload, restoration of the last saved archive, and prepared checks. State capture is an explicit checkbox. New UI strings are part of `PlaygroundLabels`.

For a custom UI using CodeMirror, import `createEditor` from `@yongsk0066/reploom-ui/codemirror`. It takes a container element and a change callback, returning `sync(files, active, attributes, reset)`, `reveal(line, column)`, and `destroy()` without importing React. A different editor can connect directly to the headless session API.

An optional third argument configures syntax analysis:

```js
const editor = createEditor(container, onChange, {
  language: { minCharacters: 64_000, idleMs: 30_000, onError: reportError },
});
```

At the threshold, parsing moves to an editor-owned Worker; smaller files use the local parser. The default factory lazily imports the prepared `@yongsk0066/reploom-ui/language-worker` source and creates a Blob Worker, requiring the host's `worker-src` policy to permit `blob:`. Hosts can supply `language.createWorker(signal)` to load that same prepared source through their own deployment path. The signal cancels pending creation, and the adapter terminates a Worker returned after cancellation. Setting `language: false` selects local parsing for every file. In React, pass these options through `editorOptions`; they are captured when the editor mounts.

Syntax queries for large files become complete asynchronously. Integrations that require the full syntax tree should observe CodeMirror's `syntaxTreeAvailable`; a synchronous parse request cannot wait for a Worker response. Text edits, selection, composition, and undo remain available while analysis runs.

## File transactions and project archives

Apply related file changes together so compilation sees one complete source revision:

```js
session.transaction([
  { type: "move", from: "/helper.ts", to: "/format.ts" },
  { type: "write", path: "/main.js", source: updatedEntrySource },
  { type: "remove", path: "/unused.ts" },
]);
```

The complete result is validated before the session publishes it. Update import strings in the same transaction when moving a referenced file. The prepared entry, explicit styles, and declared check modules remain required; dependency and execution settings belong to build preparation.

`session.exportProject()` returns a source archive immediately. `await session.save({ state: true, signal })` also captures explicitly registered state from the settled preview. Store the result as JSON in your preferred storage, then pass it to `session.restore(archive)`. Restore validates the prepared project identity and starts a fresh preview. Archives contain sources, the selected file, and optional managed state; executable artifacts are rebuilt locally from those sources.

Within example code, register portable state by module path and key:

```ts
const count = import.meta.state("count", 0);
export function increment() {
  return ++count.value;
}
```

Read `count.value` when mounting a DOM view or initializing a React hook. This makes the restoration decision explicit in the example. See the [state contract](support.md#state-and-cleanup) for supported values and limits. [The task-list example](../examples/dom-todos/main.ts) demonstrates this alongside form handling.

## Optional checks

Declare test modules in the project with `checks: ["/check.ts"]`. Each module exports a sync or async `test({ container, signal, assert })` function. `await session.check("tests")` prepares the current source revision and runs these modules in a separate preview. DOM and React checks receive the preview's root container; Compute checks execute in its Worker. Tests start from the example's initial state, so they can exercise interactions without modifying the live preview.

Enable the optional type checker during preparation:

```js
await prepareProjects({
  projects,
  projectRoot,
  outDir: "public/reploom",
  typecheck: { compilerOptions: { strict: true } },
});
```

Install `@tsrs/wasm@0.25.0-ts7.1.0-beta` in `projectRoot`, together with declaration packages needed by the examples. React projects need `@types/react` and `@types/react-dom`. Preparation collects declarations from installed dependencies; `typecheck.packages` can name additional type packages. The default checker settings include `strict: false`, `checkJs: true`, and `skipLibCheck: true`; supplied compiler options override them, while emission and composite builds remain disabled. Incremental checking is enabled automatically at 128,000 UTF-16 source code units; set `compilerOptions.incremental` explicitly to override this threshold. Its private in-memory build information is capped at 1 MiB and ends with the checker lease.

Call `await session.check("types")` to run the checker in an on-demand Worker. Editing cancels checks for the old revision. Results appear under `view.checks.tests` or `view.checks.types`, tagged with their source revision. The platform allows one active job of each kind and eight waiting jobs per kind, and reuses the checker Worker briefly after success. Failure, timeout, or cancellation retires it immediately. A headless host may instead inject either validation service through `SessionServices`.

Set `typecheck: { idleMs, timeoutMs, maxMemoryBytes, createWorker }` on `createBrowserPlatform` to control the checker lease. Defaults are 5,000 ms idle, 30,000 ms per initialization/check, and a 128 MiB observed per-check WASM threshold. Setting `idleMs: 0` retires the Worker and diagnostic cache after every check and disables automatic incremental checking. The threshold is a retirement policy, not a hard allocation limit. The optional factory receives the verified Worker script URL.

Otherwise, the same idle period bounds an exact source/result cache, which can serve an unchanged project even after a memory-pressure retirement. Such a retirement also preserves immutable compiler code and bounded incremental metadata for the next Worker, while releasing the old execution memory.

`downloadTimeoutMs` controls the platform's asset-download timeout, defaulting to 30,000 ms. Shared requests remain active while another consumer needs them. Custom `SessionServices.loadProject` and `LoadedProject.compilerResources` implementations receive an optional AbortSignal and should honor it through their I/O.

`session.reveal(diagnostic)` selects the diagnostic's file and publishes a selection request. Locations use one-based lines and zero-based UTF-16 columns; stale revision locations are rejected. The React view handles these requests automatically. Custom CodeMirror views can call `editor.reveal(line, column)` after synchronizing the selected file.
