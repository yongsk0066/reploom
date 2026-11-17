import { build as bundle } from "esbuild";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const runtimeEntry = (name) =>
  fileURLToPath(import.meta.resolve(`@yongsk0066/reploom/internal/${name}`));

// Publication-time packaging only. Each iframe gets its own registry/adapter;
// projects share immutable downloaded bytes, never React roots or mutable state.
export function createVendorBuilder({ root, asset, reactModules }) {
  const licenseRoots = new Map();
  const metadata = new Map();

  async function build(options) {
    const result = await bundle({ ...options, absWorkingDir: root, metafile: true });
    for (const filename of Object.keys(result.metafile.inputs)) {
      if (/^(dependency|shared-runtime|prepared-asset):/.test(filename) || filename === "<stdin>")
        continue;
      let directory = path.dirname(path.resolve(root, filename));
      const visited = [];
      let info;
      while (path.dirname(directory) !== directory) {
        if (metadata.has(directory)) {
          info = metadata.get(directory);
          break;
        }
        visited.push(directory);
        try {
          const pkg = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
          if (pkg.name) {
            info = { directory, name: pkg.name, version: pkg.version };
            break;
          }
        } catch {}
        directory = path.dirname(directory);
      }
      for (const directory of visited) metadata.set(directory, info);
      if (info && info.name !== "@yongsk0066/reploom") licenseRoots.set(info.directory, info);
    }
    return result;
  }

  const runtimes = new Map();
  const packs = new Map();

  let computeWorker;

  const options = {
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    legalComments: "inline",
    define: { "process.env.NODE_ENV": '"development"' },
  };

  function namespaces(modules, shared = []) {
    const singletons = new Set(shared.map(([name]) => name));
    return {
      name: "playground-dependencies",
      setup(builder) {
        builder.onResolve({ filter: /^playground-dependency:/ }, ({ path }) => ({
          path,
          namespace: "dependency",
        }));
        builder.onLoad({ filter: /.*/, namespace: "dependency" }, ({ path }) => ({
          contents: `export * as namespace from ${JSON.stringify(modules[Number(path.split(":")[1])][0])};`,
          loader: "js",
          resolveDir: root,
        }));
        // The pinned React entry points are CJS. Preserve default/named/CJS
        // interop while ensuring packages use the renderer's very same React.
        builder.onResolve({ filter: /.*/ }, ({ path }) =>
          singletons.has(path) ? { path, namespace: "shared-runtime" } : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: "shared-runtime" }, ({ path }) => ({
          contents: `const ns = globalThis.__PLAYGROUND_VENDOR__.dependencies[${JSON.stringify(path)}]; module.exports = ns.default ?? ns;`,
          loader: "js",
        }));
      },
    };
  }

  const registry = (modules) =>
    `{${modules.map(([name], index) => `${JSON.stringify(name)}: require('playground-dependency:${index}').namespace`).join(",")}}`;

  return {
    bundle: build,
    licenseRoots,
    get size() {
      return runtimes.size + packs.size + (computeWorker ? 1 : 0);
    },
    async prepare(kind, modules) {
      const react = kind === "react";
      const compute = kind === "compute";
      const core = react ? reactModules : [];
      const shared = new Set(core.map(([name]) => name));
      const extras = modules.filter(([name]) => !shared.has(name));

      if (!runtimes.has(kind)) {
        const bundle = await build({
          ...options,
          stdin: {
            // require order installs the Refresh hook before loading ReactDOM.
            contents: `
              ${react ? `const refresh = require(${JSON.stringify(require.resolve("react-refresh/runtime"))}); refresh.injectIntoGlobalHook(globalThis);` : ""}
              ${
                compute
                  ? `const { createComputeExecution } = require(${JSON.stringify(runtimeEntry("execution/compute/host"))});`
                  : `const { createWindowExecution } = require(${JSON.stringify(runtimeEntry("execution/window"))});
                   const { ${react ? "createReactAdapter" : "createDomAdapter"} } = require(${JSON.stringify(runtimeEntry(react ? "execution/adapters/react" : "execution/adapters/dom"))});`
              }
              const dependencies = ${registry(core)};
              const kind = ${JSON.stringify(kind)};
              const createExecution = (container, environment) => ${compute ? "createComputeExecution(container, environment)" : `createWindowExecution(${react ? "createReactAdapter(container, dependencies, refresh, environment.reportError)" : "createDomAdapter(container, dependencies)"}, environment)`};
              export { kind, dependencies, createExecution };
            `,
            resolveDir: root,
          },
          plugins: [namespaces(core)],
          globalName: "__PLAYGROUND_VENDOR__",
          footer: {
            js: "globalThis.__PLAYGROUND_VENDOR__ = __PLAYGROUND_VENDOR__;",
          },
        });

        runtimes.set(kind, await asset(`runtime-${kind}`, bundle.outputFiles[0].text, "js"));
      }

      const vendor = [runtimes.get(kind)];
      const worker = [];

      if (compute) {
        if (!computeWorker) {
          const bundle = await build({
            ...options,
            entryPoints: [runtimeEntry("execution/compute/worker")],
            banner: {
              js: "globalThis.__PLAYGROUND_VENDOR__ = { dependencies: Object.create(null) };",
            },
          });

          computeWorker = await asset("compute-worker", bundle.outputFiles[0].text, "js");
        }
        worker.push(computeWorker);
      }
      if (extras.length) {
        const key = JSON.stringify({ kind, extras });
        if (!packs.has(key)) {
          const bundle = await build({
            ...options,
            stdin: {
              contents: `Object.assign(globalThis.__PLAYGROUND_VENDOR__.dependencies, ${registry(extras)});`,
              resolveDir: root,
            },
            plugins: [namespaces(extras, core)],
          });

          packs.set(key, await asset("dependencies", bundle.outputFiles[0].text, "js"));
        }
        (compute ? worker : vendor).push(packs.get(key));
      }
      return { vendor, ...(compute ? { worker } : {}) };
    },
  };
}
