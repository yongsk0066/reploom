import { execFileSync } from "node:child_process";
import { cp, rm, mkdir, writeFile, readFile, readdir, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import path from "node:path";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const stateRoot = path.join(root, "packages/ui/vendor/codemirror-state");
const stateManifest = JSON.parse(await readFile(path.join(stateRoot, "manifest.json"), "utf8"));
const uiPackage = JSON.parse(await readFile(path.join(root, "packages/ui/package.json"), "utf8"));
if (stateManifest.version !== uiPackage.devDependencies["@codemirror/state"])
  throw Error("Worker document source must match the installed CodeMirror version");
for (const [file, expected] of Object.entries(stateManifest.files)) {
  const actual = createHash("sha256")
    .update(await readFile(path.join(stateRoot, file)))
    .digest("hex");

  if (actual !== expected) throw Error(`Unrecorded worker document source change: ${file}`);
}

await rm(new URL("../packages/ui/dist/", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("../packages/ui/dist/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../packages/ui/dist/worker-source.d.ts", import.meta.url),
  "export declare const source: string;\n",
);

const worker = await build({
  absWorkingDir: root,
  entryPoints: ["packages/ui/src/codemirror/language/worker.ts"],
  bundle: true,
  format: "iife",
  minify: true,
  write: false,
  legalComments: "inline",
  metafile: true,
  alias: { "@codemirror/state": path.join(stateRoot, "index.ts") },
});

execFileSync("pnpm", ["exec", "tsc", "-p", "packages/ui/tsconfig.json", "--emitDeclarationOnly"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  stdio: "inherit",
});

// Bundle the version-pinned parser patches into the published adapter. Consumer
// package managers do not inherit this workspace's patchedDependencies setting.
const editor = await build({
  absWorkingDir: root,
  entryPoints: {
    editor: "packages/ui/src/editor.ts",
    react: "packages/ui/src/react.ts",
    "prepare-reader": "packages/ui/src/reader/prepare.ts",
  },
  outdir: "packages/ui/dist",
  chunkNames: "chunks/[name]-[hash]",
  splitting: true,
  bundle: true,
  format: "esm",
  minify: true,
  legalComments: "inline",
  metafile: true,
  loader: { ".css": "text" },
  external: ["@yongsk0066/reploom", "@yongsk0066/reploom-ui/language-worker", "react", "react-dom"],
});

const notices = new Map();

async function packageNotice(directory) {
  if (notices.has(directory)) return notices.get(directory);
  const info = JSON.parse(await readFile(path.join(root, directory, "package.json"), "utf8"));

  const names = (await readdir(path.join(root, directory)))
    .filter((name) => /^(?:licen[sc]e|copying|notice)(?:$|[._-])/i.test(name))
    .sort();

  if (!names.length) throw Error(`Missing bundled UI license: ${info.name}`);

  const texts = await Promise.all(
    names.map((name) => readFile(path.join(root, directory, name), "utf8")),
  );

  const notice = `${info.name}@${info.version}\n${texts.join("\n")}`;
  notices.set(directory, notice);
  return notice;
}

async function bundleNotices(inputs) {
  const directories = new Set();
  for (const input of Object.keys(inputs)) {
    const directory = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1];
    if (directory) directories.add(directory);
  }
  const included = await Promise.all([...directories].sort().map(packageNotice));
  if (Object.keys(inputs).some((input) => input.startsWith("packages/ui/vendor/codemirror-state/")))
    included.push(
      `@codemirror/state@${stateManifest.version}\n${await readFile(path.join(stateRoot, "LICENSE"), "utf8")}`,
    );
  return included.length ? `\n/*!\n${included.join("\n\n").replaceAll("*/", "* /")}\n*/\n` : "";
}

for (const [filename, output] of Object.entries(editor.metafile.outputs))
  await appendFile(path.join(root, filename), await bundleNotices(output.inputs));
const workerNotice = await bundleNotices(worker.metafile.inputs);
await writeFile(
  new URL("../packages/ui/dist/worker-source.js", import.meta.url),
  `export const source = ${JSON.stringify(worker.outputFiles[0].text + workerNotice)};\n`,
);
await writeFile(
  new URL("../packages/ui/dist/THIRD_PARTY_NOTICES.txt", import.meta.url),
  [...notices.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => text)
    .join("\n\n"),
);
const palette = await readFile(path.join(root, "packages/ui/src/reader/palette.css"), "utf8");
await writeFile(path.join(root, "packages/ui/dist/reader.css"), palette);
await writeFile(
  path.join(root, "packages/ui/dist/styles.css"),
  (await readFile(path.join(root, "packages/ui/src/styles.css"), "utf8")) + palette,
);

await cp(
  new URL("../packages/ui/src/styles.d.ts", import.meta.url),
  new URL("../packages/ui/dist/styles.d.ts", import.meta.url),
);

// Public declarations retain their type graph, without exposing editor internals
// that would force consumers to install a second CodeMirror/Lezer distribution.
const output = path.join(root, "packages/ui/dist");

const entries = Object.values(uiPackage.exports)
  .map((entry) => entry.types)
  .filter(Boolean);

const declarations = new Set(
  execFileSync(
    "pnpm",
    [
      "exec",
      "tsc",
      "--ignoreConfig",
      "--listFilesOnly",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      ...entries,
    ],
    { cwd: path.join(root, "packages/ui"), encoding: "utf8" },
  )
    .trim()
    .split(/\r?\n/)
    .map((filename) => path.resolve(filename)),
);

for (const filename of await readdir(output, { recursive: true }))
  if (filename.endsWith(".d.ts") && !declarations.has(path.join(output, filename)))
    await rm(path.join(output, filename));
