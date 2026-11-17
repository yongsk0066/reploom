import { createEngine, compilerVersion } from "@yongsk0066/reploom/compiler/engine.mjs";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createProjectCompiler } from "@yongsk0066/reploom/internal/compiler/project-compiler";
import { defineProject } from "@yongsk0066/reploom";
import { MANIFEST_SCHEMA } from "@yongsk0066/reploom/internal/shared/assets";
import { MODULE_ABI, PROTOCOL } from "@yongsk0066/reploom/internal/shared/protocol";
import { createVendorBuilder } from "./vendor.mjs";
import { resourceLimits } from "@yongsk0066/reploom/internal/project/definition";
import { prepareTypecheck } from "./typecheck.mjs";

const runtimeEntry = (name) =>
  fileURLToPath(import.meta.resolve(`@yongsk0066/reploom/internal/${name}`));

const compilerFile = (name) =>
  fileURLToPath(import.meta.resolve(`@yongsk0066/reploom/compiler/${name}`));

export async function prepareProjects({
  projects: input,
  projectRoot = process.cwd(),
  outDir,
  publicBase = "/reploom/",
  publicDir = path.join(projectRoot, "public"),
  typecheck,
}) {
  if (!outDir) throw new Error("outDir is required");
  if (
    !publicBase.startsWith("/") ||
    publicBase.startsWith("//") ||
    !publicBase.endsWith("/") ||
    publicBase.includes("..") ||
    /[?#]/.test(publicBase)
  )
    throw new Error("publicBase must be a root-relative directory URL ending in /");
  const projects = input.map(defineProject);

  const root = path.resolve(projectRoot);
  const out = path.resolve(root, outDir);

  const resourceRoot = path.resolve(publicDir);
  const require = createRequire(path.join(root, "package.json"));
  await mkdir(out, { recursive: true });
  const digest = (data) => createHash("sha256").update(data).digest("hex");
  const compilerManifest = JSON.parse(await readFile(compilerFile("manifest.json"), "utf8"));
  const compilerBytes = await readFile(compilerFile("compiler.wasm"));
  if (digest(compilerBytes) !== compilerManifest.sha256)
    throw new Error("Compiler artifact integrity mismatch");
  const oxc = createEngine(await WebAssembly.compile(compilerBytes));

  async function asset(name, text, ext) {
    const hash = digest(text);
    const filename = `${name}.${hash.slice(0, 16)}.${ext}`;
    await writeFile(path.join(out, filename), text);
    return { url: `${publicBase}${filename}`, sha256: hash };
  }

  const packageRoot = (name) => {
    try {
      return path.dirname(require.resolve(`${name}/package.json`));
    } catch {}
    // Packages may export an entry point without exposing package.json.
    let dir = path.dirname(require.resolve(name));
    while (path.dirname(dir) !== dir) {
      try {
        if (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name === name)
          return dir;
      } catch {}
      dir = path.dirname(dir);
    }
    throw new Error(`Cannot locate package metadata: ${name}`);
  };

  const packageVersion = async (name) =>
    JSON.parse(await readFile(path.join(packageRoot(name), "package.json"), "utf8")).version;

  const dependencies = {};
  const reactModules = [];
  if (projects.some((project) => project.runtime === "react")) {
    for (const name of ["react", "react-dom"]) dependencies[name] = await packageVersion(name);
    if (dependencies.react !== dependencies["react-dom"])
      throw new Error("React and ReactDOM versions must match");
    for (const name of [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ])
      reactModules.push([name, dependencies[name.startsWith("react-dom") ? "react-dom" : "react"]]);
  }
  const vendors = createVendorBuilder({ root, asset, reactModules });

  const packageName = (specifier) =>
    specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];

  async function prepareProject(project) {
    const declared = {
      ...(project.runtime === "react"
        ? Object.fromEntries(reactModules.map(([name, version]) => [name, { version }]))
        : {}),
      ...project.dependencies,
    };

    const imports = Object.create(null);
    const dependencyFiles = Object.create(null);
    const modules = [];

    for (const [specifier, dependency] of Object.entries(declared).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const installed = await packageVersion(packageName(specifier));
      dependencies[packageName(specifier)] = installed;
      if (installed !== dependency.version)
        throw new Error(
          `${project.id}: ${specifier}@${dependency.version} requested; installed ${installed}`,
        );
      if (dependency.kind === "css") {
        const id = `/__dependencies/${digest(specifier).slice(0, 16)}.css`;
        dependencyFiles[id] = await readFile(require.resolve(specifier), "utf8");
        imports[specifier] = id;
      } else {
        modules.push([specifier, installed]);
        imports[specifier] = `vendor:${specifier}`;
      }
    }
    const prepared = await vendors.prepare(project.runtime, modules);
    const assets = Object.create(null);
    let resourceBytes = 0;
    for (const [id, item] of Object.entries(project.resources?.assets || {})) {
      const filename = path.resolve(resourceRoot, "." + item.url);
      if (!filename.startsWith(resourceRoot + path.sep)) throw new Error("Invalid local asset");
      const bytes = await readFile(filename);
      if (bytes.length > 8 * 1024 * 1024) throw new Error("Project asset exceeds 8MiB");
      resourceBytes += bytes.length;
      if (resourceBytes > 16 * 1024 * 1024) throw new Error("Project assets exceed 16MiB");
      assets[id] = {
        ...(await asset("resource", bytes, path.extname(filename).slice(1) || "bin")),
        type: item.type,
      };
    }
    if (Object.keys(assets).length > 32) throw new Error("Too many project assets");

    const configuration = {
      runtime: project.runtime,
      entry: project.entry,
      styles: project.styles,
      imports,
      dependencyFiles,
      execution: project.execution,
      resources: { ...resourceLimits(project.resources), assets },
    };

    // Dependency versions enter the identity even when their import names match.
    configuration.key = digest(JSON.stringify({ configuration, declared }));
    return { configuration, ...prepared };
  }

  const bootstrap = await vendors.bundle({
    entryPoints: [runtimeEntry("execution/bootstrap")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
  });

  const manifest = {
    schema: MANIFEST_SCHEMA,
    protocol: PROTOCOL,
    moduleABI: MODULE_ABI,
    compilerVersion,
    bootstrap: await asset("bootstrap", bootstrap.outputFiles[0].text, "js"),
    dependencies,
    projects: Object.create(null),
  };

  for (const project of projects) {
    if (Object.hasOwn(manifest.projects, project.id))
      throw new Error(`Duplicate project: ${project.id}`);
    const { configuration, vendor, worker } = await prepareProject(project);
    const compiler = createProjectCompiler(oxc, configuration);
    let compiled;
    try {
      compiled = compiler.compile(project.files);
    } finally {
      compiler.dispose();
    }
    manifest.projects[project.id] = {
      title: project.title,
      checks: project.checks,
      updateDelayMs: project.updateDelayMs,
      sources: await asset(`${project.id}-sources`, JSON.stringify(project.files), "json"),
      program: await asset(`${project.id}-modules`, JSON.stringify(compiled), "json"),
      configuration: await asset(`${project.id}-config`, JSON.stringify(configuration), "json"),
      assets: configuration.resources.assets,
      vendor,
      ...(worker ? { worker } : {}),
    };
  }
  // Build a self-hosted browser loader. Pin its WASM URL before hashing the JS;
  // the browser Worker can then verify and import the JS via a Blob URL.
  const wasm = await asset("oxc", compilerBytes, "wasm");

  const loader = await vendors.bundle({
    stdin: {
      contents: `
      import { createEngine as instantiate } from ${JSON.stringify(compilerFile("engine.mjs"))};
      export async function createEngine(cachedModule, options) {
        let module = cachedModule;
        if (!module) {
          const response = await fetch(new URL(${JSON.stringify(wasm.url)}, self.location.origin), { credentials: 'omit' });
          if (!response.ok) throw new Error('Oxc WASM download failed');
          const bytes = response.clone().arrayBuffer();
          const compiled = WebAssembly.compileStreaming && response.headers.get('Content-Type')?.includes('application/wasm')
            ? WebAssembly.compileStreaming(response)
            : bytes.then(value => WebAssembly.compile(value));
          const [code, hash] = await Promise.all([
            compiled, bytes.then(value => crypto.subtle.digest('SHA-256', value)),
          ]);
          const hex = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
          if (hex !== ${JSON.stringify(wasm.sha256)}) throw new Error('Oxc WASM integrity mismatch');
          module = code;
        }
        // No WASM Instance exists before content verification succeeds.
        return instantiate(module, options);
      }
    `,
      resolveDir: root,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    minify: true,
    legalComments: "inline",
    conditions: ["browser"],
  });

  manifest.compiler = await asset("oxc-loader", loader.outputFiles[0].text, "mjs");

  const worker = await vendors.bundle({
    stdin: {
      contents: `
        import { startCompilerWorker } from ${JSON.stringify(runtimeEntry("compiler/worker"))};
        import { createEngine } from "prepared:compiler";
        startCompilerWorker((command, options) => {
          if (command.compiler.sha256 !== ${JSON.stringify(manifest.compiler.sha256)})
            throw new Error('Prepared compiler identity mismatch');
          return createEngine(command.module, options);
        });
      `,
      resolveDir: root,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    minify: true,
    plugins: [
      {
        name: "prepared-compiler",
        setup(builder) {
          builder.onResolve({ filter: /^prepared:compiler$/ }, () => ({
            path: "compiler",
            namespace: "prepared-asset",
          }));
          builder.onLoad({ filter: /.*/, namespace: "prepared-asset" }, () => ({
            contents: loader.outputFiles[0].text,
            loader: "js",
            resolveDir: root,
          }));
        },
      },
    ],
  });

  manifest.compilerWorker = await asset("compiler-worker", worker.outputFiles[0].text, "js");
  if (typecheck)
    manifest.typecheck = await prepareTypecheck({
      options: typecheck === true ? {} : typecheck,
      projects,
      require,
      asset,
      packageRoot,
    });
  manifest.wasm = wasm;
  // Preserve notices for actual bundled transitive packages as well as declared CSS.
  const notices = new Map(vendors.licenseRoots);
  for (const name of Object.keys(dependencies)) {
    const directory = packageRoot(name);
    notices.set(directory, { directory, name, version: dependencies[name] });
  }
  const licenses = [];
  for (const { directory, name, version } of [...notices.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  )) {
    const filenames = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) => entry.isFile() && /^(?:licen[sc]e|copying|notice)(?:$|[._-])/i.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();

    if (!filenames.length) throw new Error(`Missing dependency notice: ${name}@${version}`);

    const notices = await Promise.all(
      filenames.map(
        async (filename) =>
          `${filename}\n${await readFile(path.join(directory, filename), "utf8")}`,
      ),
    );

    licenses.push(`${name}@${version}\n${notices.join("\n\n")}`);
  }
  licenses.push(await readFile(compilerFile("THIRD_PARTY_NOTICES.txt"), "utf8"));
  manifest.licenses = await asset("licenses", licenses.join("\n\n"), "txt");
  manifest.buildId = digest(JSON.stringify(manifest)).slice(0, 16);
  // Publish one complete manifest after every content-addressed asset exists.
  const pendingManifest = path.join(out, `manifest.${randomUUID()}.tmp`);
  try {
    await writeFile(pendingManifest, JSON.stringify(manifest, null, 2) + "\n");
    await rename(pendingManifest, path.join(out, "manifest.json"));
  } finally {
    await rm(pendingManifest, { force: true });
  }
  return manifest;
}
