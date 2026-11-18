import { textModuleExtensions } from "@yongsk0066/reploom/internal/project/module-language";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function prepareTypecheck({ options, projects, require, asset, packageRoot }) {
  const checkerRoot = path.dirname(require.resolve("@tsrs/wasm/package.json"));
  const files = Object.create(null);
  const visited = new Set();
  const licenses = [await readFile(path.join(checkerRoot, "NOTICE.txt"), "utf8")];
  let bytes = 0;

  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const location = path.join(directory, entry.name);
      const target = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(location, target);
      else if (
        entry.isFile() &&
        (entry.name === "package.json" || /\.d\.(?:ts|mts|cts)$/.test(entry.name))
      ) {
        const source = await readFile(location, "utf8");
        bytes += Buffer.byteLength(source);
        if (bytes > 16 * 1024 * 1024 || Object.keys(files).length >= 4096)
          throw new Error("Prepared type declarations exceed their budget");
        files[target] = source;
      }
    }
  }

  async function include(name, optional = false) {
    if (visited.has(name)) return;
    visited.add(name);
    let root;
    try {
      root = packageRoot(name);
    } catch (error) {
      if (optional) return;
      throw error;
    }
    await visit(root, `/node_modules/${name}`);
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

    const notices = (await readdir(root, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && /^(?:licen[sc]e|copying|notice)(?:$|[._-])/i.test(entry.name),
    );

    if (!notices.length) throw new Error(`Missing type dependency notice: ${name}`);
    for (const notice of notices)
      licenses.push(
        `${pkg.name}@${pkg.version}\n${await readFile(path.join(root, notice.name), "utf8")}`,
      );
    for (const dependency of Object.keys(pkg.dependencies || {})) await include(dependency, true);
    if (!name.startsWith("@types/"))
      await include(`@types/${name.replace(/^@/, "").replace("/", "__")}`, true);
  }

  for (const project of projects) {
    for (const name of Object.keys(project.dependencies || {}))
      await include(
        name
          .split("/")
          .slice(0, name.startsWith("@") ? 2 : 1)
          .join("/"),
      );
    if (project.runtime === "react") {
      await include("@types/react");
      await include("@types/react-dom");
    }
  }
  for (const name of options.packages || []) await include(name);
  files["/reploom.d.ts"] = `interface ImportMeta {
    state<T>(key: string, initial: T): { value: T };
    hot: { acceptExports(names: readonly string[]): void; data: Record<string, unknown>; accept(callback?: (exports: Record<string, unknown>) => unknown): void; dispose(callback: (data: Record<string, unknown>) => unknown): void; prune(callback: (data: Record<string, unknown>) => unknown): void; invalidate(): void };
    resources: { blob(path: string): Blob; asset(path: string): string; worker(path: string, options?: WorkerOptions): Worker };
  }\ndeclare module '*.css' {}\n${textModuleExtensions.map((ext) => `declare module '*.${ext}' { const text: string; export default text; }`).join("\n")}\n`;

  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./typecheck-worker.mjs", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    alias: { "@tsrs/wasm/core": path.join(checkerRoot, "core.js") },
  });

  const metadata = JSON.parse(await readFile(path.join(checkerRoot, "package.json"), "utf8"));
  return {
    worker: await asset("typecheck-worker", bundle.outputFiles[0].text, "mjs"),
    wasm: await asset("tsrs", await readFile(path.join(checkerRoot, "tsrs.wasm")), "wasm"),
    configuration: await asset(
      "typecheck-config",
      JSON.stringify({ files, compilerOptions: options.compilerOptions || {} }),
      "json",
    ),
    version: metadata.version,
    license: await asset("tsrs-notice", licenses.join("\n\n"), "txt"),
  };
}
