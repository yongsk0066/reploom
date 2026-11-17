# Dependencies

Dependencies belong to the workspace that uses them. Exact versions live in each package manifest and the lockfiles. This guide covers direct third-party dependencies; the installed dependency graph also includes their transitive and platform-specific packages.

## Browser runtime and UI

The [runtime package](../packages/runtime/package.json) declares `@jridgewell/trace-mapping` to translate runtime error locations back to source files. Framework execution is supplied by prepared adapters and vendor bundles.

The [UI package](../packages/ui/package.json) supplies the optional editor and React wrapper:

| Dependency | Purpose |
| --- | --- |
| `@codemirror/state` | Persistent documents, selections, transactions, and extension state |
| `@codemirror/view` | Editor DOM, viewport rendering, input, and composition handling |
| `@codemirror/commands` | Editing commands, key bindings, undo, and redo |
| `@codemirror/language` | Syntax integration, indentation, and parser scheduling |
| `@codemirror/lang-javascript`, `lang-css`, `lang-json` | Language support for the corresponding editor modes, including TypeScript and JSX |
| `@codemirror/theme-one-dark` | Default editor theme and highlighting style |
| `@lezer/common` | Syntax trees, fragments, traversal, and shared parser contracts |
| `@lezer/lr` | Incremental LR parser engine |
| `@lezer/javascript`, `css`, `json` | Language grammars used by editor parsing and the language Worker |
| `react` | Optional peer used by the React wrapper |

The UI build bundles its CodeMirror and Lezer dependency closure, including the workspace's verified patches. These are build dependencies: installing the UI package does not install a second copy of those libraries. Both public UI entries share the same editor chunk, and public editor declarations use Reploom-owned interfaces without importing CodeMirror types. The published archive contains the emitted entry graph, its reachable declarations, styles, Worker source, and license notices.

React remains an optional peer supplied by the host. The wrapper does not import ReactDOM; the host renderer owns mounting. Prepared React examples use their declared React and ReactDOM dependencies inside the isolated preview. That realm needs its own framework instance, independently of the host UI. A headless consumer can supply a different view and editor; the headless entry points exclude both React and CodeMirror.

## Asset preparation

The [build package](../packages/build/package.json) uses three external libraries:

| Dependency | Purpose and execution phase |
| --- | --- |
| `esbuild` | Bundles declared dependencies and runtime assets during Node preparation |
| `react-refresh` | Prepared into React preview bundles to register components and preserve compatible component state during updates |
| `@tsrs/wasm` | Optional peer for preparing a local TypeScript checker; the prepared checker runs in a separate browser Worker when enabled |

Browser edits use Reploom's Rust Oxc compiler compiled to WASM. The npm `oxc-transform` package is a separate reference implementation used in tests. TypeScript's `tsc` checks Reploom's own source and emits package declarations; optional example diagnostics use tsrs.

## Rust compiler

The [compiler crate](../crates/compiler/Cargo.toml) uses Oxc components directly, with pinned sources and patches documented under [vendor](../vendor/README.md).

| Dependency | Purpose |
| --- | --- |
| `oxc_allocator` | Arena allocation for syntax and transformation data |
| `oxc_ast`, `oxc_ast_visit` | Typed syntax nodes, direct AST construction, and visitors |
| `oxc_parser` | JavaScript, TypeScript, and JSX parsing |
| `oxc_semantic` | Scopes, symbols, and resolved identifier references |
| `oxc_transformer`, `oxc_traverse` | Syntax lowering and the transformation traversal machinery |
| `oxc_codegen` | Executable JavaScript emission |
| `oxc_sourcemap` | Source-map encoding and composition |
| `oxc_span`, `oxc_syntax`, `oxc_diagnostics` | Source positions and types, syntax definitions, and compiler diagnostics |
| `serde`, `serde_json` | Structured compiler metadata, diagnostics, and JSON handling |
| `base64` | Encoding source-map output in the native compiler CLI |

Cargo, rustfmt, and Clippy build and validate Rust sources. Compiler rebuilds also use wasm-bindgen tooling and Binaryen for WASM processing and optimization; consumers receive the committed compiler artifact.

## Validation and measurements

The private [`@reploom/tests`](../tests/package.json) workspace owns correctness checks, reference implementations, browser fixtures, and packed-consumer validation.

| Dependency | Purpose |
| --- | --- |
| `acorn` | Parse JavaScript for the reference linker |
| `eslint-scope` | Resolve scopes and references in that independent linker |
| `magic-string` | Apply reference source rewrites and generate their source maps |
| `oxc-transform` | Native Node compiler reference for differential tests |
| `@jridgewell/gen-mapping`, `remapping` | Generate and compose expected source maps for comparison with compiler output |
| `@jridgewell/trace-mapping` | Check emitted mappings at source positions |
| `@playwright/test` | Chromium, Firefox, and WebKit automation and assertions |
| `@types/estree` | Types for the reference linker's syntax nodes |

Tests also declare the React, Refresh, CodeMirror, Lezer, tsrs, esbuild, and type packages they exercise. `clsx` covers prepared package imports; `toastify-js` belongs to effect-lifecycle regression fixtures. The reference linker and fixture-only libraries stay within validation builds.

The private [`@reploom/benchmarks`](../benchmarks/package.json) workspace owns browser automation, esbuild harness bundling, and the editor/parser libraries measured directly. It consumes shared conformance inputs through `@reploom/tests/fixtures/*`; the test workspace does not depend on benchmarks.

The [demo](../apps/demo/package.json) declares React and `clsx` for its own UI and examples, plus esbuild and React types for its build. Its examples live under `apps/demo/examples/`.

## Shared development tools

The [workspace root](../package.json) owns tools shared across packages:

| Dependency | Purpose |
| --- | --- |
| `typescript` | Check library source and emit declaration files |
| `turbo` | Order package builds and cache their outputs |
| `oxlint` | Static checks, import boundaries, and complexity rules |
| `oxfmt` | Source and configuration formatting |
| `@stylistic/eslint-plugin` | Oxlint JavaScript plugin for spacing between declarations and class methods |
| `esbuild` | Shared package-build scripts |
| `@types/node` | Node API types |

`@types/react` and `@types/react-dom` are declared by the workspaces that compile React-related code. Type packages supply compile-time information and add no browser execution code. Browser primitives such as Workers, MessagePorts, sandboxed iframes, and optional JSPI come from the platform rather than npm.

Use `pnpm audit:packages` to inspect emitted bundle boundaries and sizes. Workspace installation size and browser download size measure different things: the browser receives prepared assets and the entry points selected by its host.
