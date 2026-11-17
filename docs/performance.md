# Performance

Reploom prepares dependencies and initial programs at build time. A page can display a preview before downloading the compiler, while edits compile locally and update the running module graph. The [architecture](architecture.md) describes resource ownership and the revision protocol; [supported projects](support.md) defines execution and resource limits.

## Work on the critical path

The editor passes incremental UTF-16 spans across the language and compiler Worker boundaries. It retains CodeMirror's persistent text tree, undo history, and input handling. Large-document syntax analysis runs in a separate Worker; the first visible prefix can publish before the full tree completes. The client rejects obsolete revisions before decoding, and acknowledgement-based graph deltas retain only the accepted base and newest pending result. A persistent Worker-side text cursor avoids repeated line-by-line tree seeks. Status-only synchronization does not read scroll geometry. The default language configuration includes syntax, indentation, and JSX closing tags while leaving unused completion data out of the editor bundle.

Compilation reuses unchanged transforms and resolved artifacts. Changed executable modules travel directly to the preview through a MessagePort, while debug-only changes follow their own channel. Idle first edits enter the next task; continued typing coalesces according to input cadence and observed update cost. Named-binding publication follows a dependency-to-importer index. Acknowledgements establish the base revision for subsequent deltas, and superseded work never publishes a partial graph.

The parser batches character runs that follow a stable lexical transition. The linker uses semantic identifiers, an import index, and direct AST construction. These paths reduce repeated work while retaining scope, live-binding, source-map, and cleanup semantics.

Optional type checks reuse exact diagnostic results for unchanged sources and incremental file signatures for larger projects. A memory-pressure retirement separates the old WASM execution memory from a short-lived checkpoint of reusable code and metadata, avoiding a complete restart of checker preparation. Checkpoint initialization reuses the compiled Module without another WASM download. Indexed file layers and checker-provided diagnostic coordinates avoid exception-driven fallback and repeated scans of source prefixes. First checks still build incremental metadata, so small projects use ordinary checking by default.

Progressive syntax publication can add an intermediate tree and delivery, so compare process memory as well as first-highlight latency. Remaining costs include editor layout and paint, parsing a large individual token, the first WASM compilation and call, decoding initial assets, and framework execution. Compiler and language Workers have independent queues and idle retirement. Cache limits bound optional retention; active source graphs, framework state, editor history, and WASM capacity remain separate working sets.

## Run measurements

Build first and install the three Playwright browsers. Workloads write JSON to ignored output directories; keep raw samples with the exact source revision, dependency lockfile, browser versions, and hardware description when comparing runs.

| Command | Measures |
| --- | --- |
| `pnpm audit:packages` | Host bundle sizes, gzip totals, dependency boundaries, and runtime import cycles |
| `pnpm bench:runtime` | Module evaluation, replacement, and reusable runtime work |
| `pnpm bench:browser` | Browser runtime and compiler workloads; optional `REPLOOM_BASELINE_WASM` comparison |
| `pnpm bench:bindings` | Mutable named-import execution against native browser ESM, including repeated updates |
| `pnpm bench:editor ordinary-tsx,string-900k` | Synchronous editor work and natural syntax publication in normal and forced-Worker modes |
| `pnpm bench:interaction` | Trusted browser key events, concurrent compilation, and input after compiler retirement; optional `REPLOOM_INTERACTION_BASELINE` prepared site |
| `pnpm bench:syntax` | Encoding, transfer cloning, decoding, and retained syntax-node counts |
| `node benchmarks/lexer.mjs` | Scalar and batched scanner comparison plus structural conformance |
| `node benchmarks/lexer-worker.mjs` | Scanner variants inside the minified language Worker |
| `node benchmarks/editor-sync.mjs` | Status synchronization, layout-read counts, and document lifecycle checks |
| `pnpm bench:typecheck` | Cold checks, exact-result reuse, and idle Worker ownership |
| `node benchmarks/update-delay.mjs` | First, adjacent, idle, and burst edits; optional `REPLOOM_DELAY_BASELINE` site |
| `node benchmarks/startup-phases.mjs` | Compiler startup stages; optional `REPLOOM_STARTUP_PREPARE=1` separates preparation from first-edit timing |

`pnpm bench:parser <baseline.wasm>` compares a compatible host-ABI-3 compiler against the committed compiler. It checks output, diagnostics, recovery, and WASM capacity. The `--bounded-baseline` option enables resource-intensive cases on both versions; use it only when the baseline supports the same speculation and nesting policies.

After `pnpm test:prepare`, `pnpm bench:compiler-startup <baseline.wasm>` compares the first programmatic edit in React and DOM projects. Each trial launches a fresh browser, preserves counter state, and blocks external services. The timer includes debounce, compiler startup, and preview acknowledgement.

## Interpret timing

Keep these measurements separate:

- Synchronous input work measures how long an editor operation occupies the calling thread.
- Syntax availability includes asynchronous analysis and publication; the editor benchmark reports visible-range and full-document readiness separately. The editor harness observes after two animation frames and then polls; this imposes an observation floor and does not represent native keyboard or IME latency.
- The interaction harness records trusted keyboard events through two animation-frame callbacks and, where available, Event Timing entries. This measures browser scheduling rather than the physical display timestamp. Large-document setup uses the editor paste handler through a synthetic ClipboardEvent; native OS clipboard and IME latency require a separate measurement.
- Edit-to-preview timing includes scheduling, compilation, transport, and rendering.
- Compiler microbenchmarks isolate transformation work and exclude the editor and preview.

Run comparisons with the same inputs, dependency graph, browser configuration, and observation method. Alternate variants when possible, distinguish cold startup from warm execution, and inspect distributions rather than only the best sample. Parser and codec experiments assert semantic equivalence before interpreting timing differences. Native ESM is a binding-path reference, not a complete development-environment comparison. `REPLOOM_EDITOR_BASELINE` selects an editor checkout for the same input harness. `benchmarks/pipeline-costs.mjs` records the first individual compiler call separately from warm samples; engine compilation or tiering can otherwise disappear into an average.

## Inspect memory

`node benchmarks/editor-memory.mjs` measures the current editor over repeated edits, Worker retirement, reseeding, and disposal. `REPLOOM_MEMORY_BASELINE` selects a compatible checkout for alternating comparisons with the same harness; `REPLOOM_MEMORY_ROUNDS` controls repetitions. `REPLOOM_MEMORY_SETTLE_MS` adds a startup settling interval, and every sample records elapsed time so blank-page controls can match browser age. `REPLOOM_MEMORY_GC=1` enables a separate weak-reference diagnostic, records failed collections, and fails after saving every trial. `pnpm bench:typecheck-memory` measures type-check Worker policies. These process-RSS harnesses use macOS process accounting, including detached WebKit services; they should run without other browser automation.

RSS measures process and allocator retention. A weak-reference check after GC measures object liveness. Heap snapshots may themselves trigger collection, and Rust deallocation does not shrink the WASM linear-memory high-water mark. Use owner-level checks for Workers, message ports, object URLs, syntax graphs, and Views to distinguish retained resources from reusable capacity.

## Bundle boundaries

`artifacts/audit/packages.json` contains minified and gzip sizes for all emitted host JavaScript chunks, including lazy chunks. It excludes prepared preview dependencies, WASM, CSS, and browser memory. Headless imports exclude React and CodeMirror; React examples still load their prepared framework bundle inside the preview.

Browser tests verify that the default activation policy requests neither the compiler Worker nor WASM before editing, and that optional preparation preserves the displayed revision. Packed-consumer tests validate the same package boundaries outside the workspace. Re-run those checks when changing loading, transport, or bundling, alongside state preservation, cancellation, and disposal tests.
