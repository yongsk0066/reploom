# Reploom

Reploom runs editable React, plain DOM, and Worker computation examples in the browser, with an optional code editor and React wrapper.

A build step bundles project dependencies and compiles the initial program into static files. The first preview uses these prepared modules, deferring compiler loading until editing begins. An Oxc compiler running as WebAssembly in a Worker then compiles changed modules locally, with no runtime calls to package CDNs or remote build services.

The headless session API supports atomic file changes, source archives, explicit state restoration, and revision-aware error navigation. Optional test and type-check services run separately from the live preview; the React view exposes these operations through its Project tools panel. See [integration](docs/integration.md) for setup and API examples.

The packages are in alpha at `0.1.0-alpha.0`. First-party code currently uses `UNLICENSED`; see [development](docs/development.md) for distribution and licensing details.

## Try the examples

Use the Node version in `.nvmrc` and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm demo
```

Open `http://127.0.0.1:4331` to browse nine examples covering forms, React Effect Events, lazy modules, Canvas, local assets, module cleanup, and two Worker computations. The gallery mounts one example at a time.

## Packages

| Package                     | Responsibility                                                          |
| --------------------------- | ----------------------------------------------------------------------- |
| `@yongsk0066/reploom`       | Project declarations, headless sessions and browser preview integration |
| `@yongsk0066/reploom-ui`    | Optional React view, CodeMirror adapter and CSS                         |
| `@yongsk0066/reploom-build` | Build-time dependency bundling and static asset preparation             |

The headless entry points exclude React and CodeMirror, and all three packages share a version number during the alpha.

- [Integration](docs/integration.md): configure projects, serve static assets, and mount headless or React views.
- [Supported projects](docs/support.md): source syntax, runtime contracts, resource limits, and isolation.
- [Architecture](docs/architecture.md): resource ownership, incremental compilation, and module lifecycle.
- [Performance](docs/performance.md): bundle measurements and remaining costs.
- [Development](docs/development.md): local checks, compiler rebuilds, and CI artifacts.
