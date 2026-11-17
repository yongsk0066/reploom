# Performance

Reploom prepares dependencies and initial programs at build time. A page can display a preview before downloading the compiler, while edits compile locally and update the running module graph. The [architecture](architecture.md) describes resource ownership and the revision protocol; [supported projects](support.md) defines execution and resource limits.

## Work on the critical path

The editor passes incremental UTF-16 spans across the language and compiler Worker boundaries. It retains CodeMirror's persistent text tree, undo history, and input handling. Large-document syntax analysis runs in a separate Worker; a completed tree is published after checking the active document and revision. Status-only synchronization does not read scroll geometry.

Compilation reuses unchanged transforms and resolved artifacts. Changed executable modules travel directly to the preview through a MessagePort, while debug-only changes follow their own channel. Acknowledgements establish the base revision for subsequent deltas, and superseded work never publishes a partial graph.

The parser batches character runs that follow a stable lexical transition. The linker uses semantic identifiers, an import index, and direct AST construction. These paths reduce repeated work while retaining scope, live-binding, source-map, and cleanup semantics.

Remaining costs include editor layout and paint, parsing a large individual token, the first WASM compilation and call, decoding initial assets, and framework execution. Compiler and language Workers have independent queues and idle retirement. Cache limits bound optional retention; active source graphs, framework state, editor history, and WASM capacity remain separate working sets.

## Run measurements

Build first and install the three Playwright browsers. Workloads write JSON to ignored output directories; keep raw samples with the exact source revision, dependency lockfile, browser versions, and hardware description when comparing runs.

| Command | Measures |
| --- | --- |
| `pnpm audit:packages` | Host bundle sizes, gzip totals, dependency boundaries, and runtime import cycles |
| `pnpm bench:runtime` | Module evaluation, replacement, and reusable runtime work |
| `pnpm bench:browser` | Browser runtime and compiler workloads; optional `REPLOOM_BASELINE_WASM` comparison |
| `pnpm bench:bindings` | Mutable named-import execution against native browser ESM, including repeated updates |
| `pnpm bench:editor ordinary-tsx,string-900k` | Synchronous editor work and natural syntax publication in normal and forced-Worker modes |
| `pnpm bench:syntax` | Encoding, transfer cloning, decoding, and retained syntax-node counts |
| `node benchmarks/lexer.mjs` | Scalar and batched scanner comparison plus structural conformance |
| `node benchmarks/lexer-worker.mjs` | Scanner variants inside the minified language Worker |
| `node benchmarks/editor-sync.mjs` | Status synchronization, layout-read counts, and document lifecycle checks |
| `pnpm bench:typecheck` | Cold versus reused type-check Workers |

`pnpm bench:parser <baseline.wasm>` compares a compatible host-ABI-3 compiler against the committed compiler. It checks output, diagnostics, recovery, and WASM capacity. The `--bounded-baseline` option enables resource-intensive cases on both versions; use it only when the baseline supports the same speculation and nesting policies.

After `pnpm test:prepare`, `pnpm bench:compiler-startup <baseline.wasm>` compares the first programmatic edit in React and DOM projects. Each trial launches a fresh browser, preserves counter state, and blocks external services. The timer includes debounce, compiler startup, and preview acknowledgement.

## Interpret timing

Keep these measurements separate:

- Synchronous input work measures how long an editor operation occupies the calling thread.
- Syntax availability includes asynchronous analysis and publication. The editor harness observes after two animation frames and then polls; this imposes an observation floor and does not represent native keyboard or IME latency.
- Edit-to-preview timing includes scheduling, compilation, transport, and rendering.
- Compiler microbenchmarks isolate transformation work and exclude the editor and preview.

Run comparisons with the same inputs, dependency graph, browser configuration, and observation method. Alternate variants when possible, distinguish cold startup from warm execution, and inspect distributions rather than only the best sample. Parser and codec experiments assert semantic equivalence before interpreting timing differences. Native ESM is a binding-path reference, not a complete development-environment comparison.

## Inspect memory

`node benchmarks/editor-memory.mjs` measures the current editor over repeated edits, Worker retirement, reseeding, and disposal. `REPLOOM_MEMORY_GC=1` enables a separate weak-reference diagnostic. `pnpm bench:typecheck-memory` measures type-check Worker policies. These process-RSS harnesses use macOS process accounting, including detached WebKit services; they should run without other browser automation.

RSS measures process and allocator retention. A weak-reference check after GC measures object liveness. Heap snapshots may themselves trigger collection, and Rust deallocation does not shrink the WASM linear-memory high-water mark. Use owner-level checks for Workers, message ports, object URLs, syntax graphs, and Views to distinguish retained resources from reusable capacity.

## Bundle boundaries

`artifacts/audit/packages.json` contains minified and gzip sizes for all emitted host JavaScript chunks, including lazy chunks. It excludes prepared preview dependencies, WASM, CSS, and browser memory. Headless imports exclude React and CodeMirror; React examples still load their prepared framework bundle inside the preview.

Browser tests verify that the compiler Worker and WASM are not requested before editing. Packed-consumer tests validate the same package boundaries outside the workspace. Re-run those checks when changing loading, transport, or bundling, alongside state preservation, cancellation, and disposal tests.
