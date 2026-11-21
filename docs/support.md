# Supported projects

Reploom targets editable frontend examples in articles, documentation, and small teaching tools. The supported runtimes are React, plain DOM, and computation in a Worker.

## Source and dependencies

Projects can include JavaScript, JSX, TypeScript, TSX, CSS, and JSON. Compilation erases TypeScript syntax; an optional, separately prepared checker provides type diagnostics on request. The compiler and editor use TypeScript grammar for `.ts` and `.mts`, TSX grammar for `.tsx`, and ESM JavaScript for `.mjs`. Module resolution operates over a closed graph of local file paths, string-literal local dynamic imports, and declared package imports.

Local `.txt`, `.md`, `.html`, `.svg`, `.csv`, `.glsl`, and `.wgsl` source files export their exact text as a default import. A text edit updates importers through the same module graph as JavaScript. Applications choose how to render templates, parse rows, or compile shaders. A separately declared binary SVG retains its object URL import.

Dependencies must be installed in the host workspace and declared with exact versions so the build package can bundle them ahead of time. React projects use matching React and ReactDOM versions from that installation; the current workspace tests React 19.3.1. Prepared React bundles execute inside the preview, independently of the host page's React instance.

Each project supports at most 32 source files and 1,000,000 UTF-16 code units. Declared binary assets have a separate budget of 32 assets, 8 MiB each, and 16 MiB total. Nested resource Workers are opt-in, with a limit of eight. See the [demo project declarations](../apps/demo/examples/projects.mjs) for working configurations.

Preparation and browser compilation share a budget of 32 active recursive type parses, including speculative TypeScript paths. Exceeding it produces a source-located compilation diagnostic, preserves the working preview, and leaves the compiler reusable for the next edit. This measures parser nesting, rather than the total number of types or angle brackets; aliases can reduce deeply nested declarations. Other JavaScript recursion and total memory remain subject to engine limits and compiler-failure recovery.

## State and cleanup

- **React:** Compatible component and hook edits preserve state through Fast Refresh. Changed hook signatures or incompatible exports can remount components. Effects refresh when their importing module changes; CSS and source-map-only edits avoid reevaluating JavaScript modules.
- **DOM:** Entry modules export a synchronous `mount(container, { state, signal })`. The state bag survives compatible edits. Attach event listeners with `signal` and return an optional synchronous or async cleanup function for other resources.
- **Compute:** Entry modules export `run({ state, signal, report })`, which may be async. State persists across normal updates within the same Worker and resets if Stop, a timeout, or a fatal failure terminates it.

Modules can manage update boundaries through Reploom's `import.meta.hot`: `data`, self-`accept(callback?)`, selective `acceptExports(names)`, `dispose`, `prune`, and `invalidate`. For a declared asset, `import.meta.resources.asset(path)` returns a realm-owned object URL and `import.meta.resources.blob(path)` returns the verified immutable `Blob`. Use `blob.stream()` for incremental reads, `blob.text()` for text, or `blob.arrayBuffer()` for binary decoders. Window previews and compute Workers share this API. Nested Workers use `import.meta.resources.worker(path, options)`.

React refresh boundaries compare both export versions. Components may share a module with unchanged primitive constants; changing those constants or adding incompatible exports propagates the update to importers. Compound component properties are inspected up to four levels, and accessors force propagation without invoking getters.

For explicit save/restore, `import.meta.state(key, initial)` returns a mutable `{ value }` cell scoped to the module path. It survives compatible module updates and can be included in a project archive. Modules support up to 128 keys, each 1–256 characters. Captured state accepts finite JSON values, plain objects, and dense arrays, bounded to 4,096 visited values, depth 32, and 128 Ki UTF-16 code units across strings and keys. Cycles and accessors are rejected. Examples decide how restored values initialize their DOM, React, or Compute state; automatic serialization of arbitrary framework state is outside this API.

During asynchronous module replacement, input to a registered cell is preserved when the candidate has not read or modified it. If both the running code and candidate depend on a changing cell, the update reports a state conflict and keeps committed values. Read cells at use time rather than capturing their values during module evaluation when live interaction should continue through an update. Candidate mutations remain private until all affected modules pass validation. Recovery after a failed evaluation can restore these committed cells into a fresh realm; arbitrary React hook or DOM state is not part of that snapshot.

Selective acceptance preserves importers that consume only the declared names. The changed dependency still executes. Namespace, dynamic, and explicit side-effect imports continue to propagate. Calling `acceptExports` requires nonempty names of existing exports during module evaluation.

File transactions support writes, removals, and moves in one validated revision, up to 128 operations. Prepared entry, style, and check paths remain required. A move preserves file contents and selection; update references with accompanying writes. Archives restore only into the matching prepared project configuration.

## Optional validation and diagnostics

A project may declare up to 16 local check modules. Each exports `test({ container, signal, assert })`; the test run starts a separate instance from initial state. React and DOM checks run in an isolated iframe, and Compute checks run in its Worker. This provides application assertions without sharing the live preview's state. Window checks use the same cooperative execution boundary described below.

Type checking uses a separately prepared `@tsrs/wasm` Worker, with declarations bundled from the host installation. The current pinned checker is `7.1.0-beta.tsrs4`. Preparation limits declaration inputs to 4,096 files and 16 MiB. It defaults to `strict: false`, `checkJs: true`, and `skipLibCheck: true`; hosts can supply compiler options. The Worker reuses its compiled Module and prepared declaration index for five seconds after a successful check, then terminates. Each invocation uses a fresh WASM instance and file overlay. Completed checks can retain compact metadata with file signatures and diagnostics. Cancellation, failure, or a 30-second initialization/execution timeout terminates it immediately. These optional assets load only when a check is requested. Emission and composite builds are disabled. Large projects can reuse bounded, in-memory incremental build information; the [integration settings](integration.md#optional-checks) describe its threshold and override.

Check results and navigable diagnostics carry source revisions. Locations use one-based lines and zero-based UTF-16 columns; navigation rejects an old revision. Compilation, type checking, and mapped runtime errors can select a location, while errors without a usable source map remain visible as text.

## Execution boundary

Previews run inside a sandboxed iframe with `allow-scripts allow-forms`, omitting `allow-same-origin`, and a restrictive Content Security Policy. This keeps host document and storage access unavailable to preview code and blocks arbitrary network requests. Local `submit` handlers work, while `form-action 'none'` blocks native form navigation. Resources must be declared and prepared by the host.

React and DOM previews execute on a Window event loop. Compiled user functions and loops include cooperative execution checks, with a default budget of 32 ms. These checks can stop instrumented loops but cannot preempt blocking native APIs or uninstrumented dependencies. Compute projects run off the main thread in a Worker without DOM access; a watchdog terminates overdue work, defaulting to two seconds.

These controls support controlled examples and recovery from common authoring mistakes. Hostile multi-tenant execution and hard memory quotas are outside the isolation contract.

## Browser validation and scope

Playwright tests run across Chromium, Firefox, and WebKit, covering live edits, state retention, error recovery, cancellation, idle retirement, resource cleanup, keyboard interaction, and external-service blocking. Unit contracts also cover composition handling. Coverage applies to those engine builds and tested workloads; released Safari versions and individual devices require their own validation. JSPI is feature-detected and optional.

Node APIs, interactive terminals, runtime npm installation, Vite plugins, in-preview SSR, and additional framework adapters are outside the current alpha. Package installation and independent headless consumers are checked in the [development workflow](development.md).
