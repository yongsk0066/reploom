# Development

Use the Node and pnpm versions in `.nvmrc` and `package.json`. Rust is pinned in `rust-toolchain.toml`. Direct dependencies use exact versions; the pnpm and Cargo lockfiles define a checkout.

## Local checks

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm audit:publication
pnpm compiler:verify
pnpm build
pnpm check
pnpm test
pnpm audit:packages
pnpm test:prepare
pnpm --filter @reploom/tests exec playwright install chromium firefox webkit
pnpm test:browser
pnpm format:rust:check
pnpm lint:rust
pnpm test:rust
```

`pnpm format` applies Oxfmt and the Oxlint spacing rules. CI checks formatting and lint separately. Runtime and UI functions have a modified cyclomatic-complexity ceiling of 20, with switch alternatives counted as one decision. Import rules enforce package ownership and prevent runtime cycles.

Organize procedures around validation, staging, commit, and notification. Keep related state in its owner; extract an operation when it has a useful input/output contract. Prefer explicit service interfaces over forwarding wrappers or a global service container.

`pnpm build` prepares the gallery in `apps/demo/dist`; `pnpm demo` serves it. `pnpm test:prepare` builds a separate verification site in `artifacts/browser-site` and installs package archives into a temporary external consumer directory. The browser suite exercises React effects, DOM and compute lifecycles, revision transactions, state restoration, errors, cancellation, optional type checking, and packed-package isolation.

## Workspace layout

```text
packages/runtime/   Headless sessions, transport, compilation, and execution
packages/ui/        React view, CodeMirror adapter, and styles
packages/build/     Node preparation API and CLI
crates/compiler/    Rust compiler and distributable WASM artifact
vendor/             Pinned upstream compiler sources and verified patches
patches/            Pinned JavaScript dependency patches
apps/demo/          Example gallery and its self-contained examples/
tests/              Private validation workspace
  unit/             Compiler, runtime, lifecycle, and editor contracts
  browser/          Three-engine integration tests
  reference/        Independent compiler and source-map reference implementations
  fixtures/         Shared inputs, lexer conformance, and verification sites
  packaging/        Bundle audits and packed-consumer preparation
  consumer/         Source for the external package consumer
benchmarks/         Private performance-measurement workspace
scripts/            Shared build, artifact, package, and publication tooling
```

The root owns shared formatting, linting, TypeScript, and build orchestration. Each workspace declares the libraries it imports. Acorn, eslint-scope, MagicString, and the native `oxc-transform` reference compiler belong to `@reploom/tests`; measurement dependencies belong to `@reploom/benchmarks`. The demo owns its example dependencies. Public runtime, UI, and build packages have no dependency on either private verification workspace.

Benchmarks reuse conformance inputs through the test workspace's fixture exports. Tests remain independent of benchmark code. The packed consumer is deliberately installed from `.tgz` files in a temporary directory outside the workspace, so workspace links cannot conceal missing package dependencies.

Root `test:*`, `audit:packages`, and `bench:*` commands delegate to their owning workspace. They remain the entry points for local work and CI; for example, `pnpm test` runs `@reploom/tests` and `pnpm bench:runtime` runs `@reploom/benchmarks`.

Generated output belongs in `artifacts/`. Local notes, profiles, old source snapshots, and audit reports belong in `.local/`. Both are ignored by Git. Keep implementation rationale in the relevant source or architecture document; record machine-specific measurements outside the source tree.

## Compiler sources and build

The committed WASM artifact lets JavaScript contributors work without Rust. `pnpm compiler:verify` checks its source inventory and hashes, including the build recipe. It also reverses the recorded vendor patches in a temporary copy and verifies the upstream inventory. See [vendor](../vendor/README.md) for dependency origins, licenses, patches, and upgrade steps.

To rebuild after a compiler or build-recipe change, install the wasm-bindgen CLI version recorded in the artifact manifest and Binaryen, then run:

```sh
pnpm compiler:build
pnpm compiler:verify
```

`REPLOOM_WASM_BINDGEN` selects a specific executable. The build remaps workspace, Cargo, Rust toolchain, and temporary paths before compilation so panic-location strings in the distributed WASM do not expose a contributor's home directory. The manifest records logical remap destinations and tool versions. Dependency notices are generated from the locked Cargo graph.

The UI build bundles its pinned CodeMirror/Lezer closure with license notices. Public entries share one emitted editor implementation, and TypeScript's declaration graph determines which `.d.ts` files ship. The external packed consumer checks these types with `skipLibCheck: false`, builds both UI entries together, and verifies that no separate CodeMirror/Lezer installation is required. Workspace patches supply reverse sibling indexing and grammar-preserving character-run scanning; packed consumers receive these without configuring their own package manager. When upgrading, run the lexer differential corpus, editor tests, and three-engine Worker benchmark. The small Text/ChangeSet sources used by the language Worker have a separate hash-checked upstream manifest.

## Measurements

[Performance](performance.md) describes the workloads and their denominators. Run timing and memory experiments separately on an otherwise idle machine. Public harnesses use the current source tree; compiler comparisons accept a compatible baseline WASM explicitly. A source archive or shallow checkout is sufficient for the normal build, tests, and current-version benchmarks.

## Publication boundaries

`pnpm audit:publication` checks tracked files, including compressed and binary content, for local paths, private-key material, generated reports, and development-only directories. CI runs the same check. Preserve upstream authors, license notices, dependency revisions, and package repository metadata: these identify the software's origin and distribution contract.

Deleting a tracked file does not remove it from earlier Git commits. Before changing repository visibility, inspect reachable history, author metadata, release assets, and CI artifacts as well as the current tree. History replacement changes commit IDs and requires coordinating with anyone using the repository. Keep a local Git bundle before such a change.

## GitHub Actions and packages

The source repository is public. Clone it over HTTPS and run `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm pack:all` to produce the three package archives locally. Pin a commit when preparing packages for a consuming application's CI.

CI runs JavaScript and Rust checks, verifies packed consumers, and tests Chromium, Firefox, and WebKit. Clippy runs for the native host and `wasm32-unknown-unknown`. Actions are pinned to immutable revisions.

A successful quality job uploads matching package archives. Download them from a successful CI run and install the three archives together:

```sh
gh run download RUN_ID --repo yongsk0066/reploom --name packages --dir ./reploom-packages
```

The manual **Publish private packages** workflow runs from `main`, reruns CI, and verifies the requested version before publishing to GitHub Packages with `GITHUB_TOKEN`. Registry consumers need package read access. First-party packages currently declare `UNLICENSED`; selecting an open-source license is a separate release decision. Third-party licenses accompany the distributed assets.
