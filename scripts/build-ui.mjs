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
if (stateManifest.version !== uiPackage.dependencies["@codemirror/state"])
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

await writeFile(
  new URL("../packages/ui/dist/worker-source.js", import.meta.url),
  `export const source = ${JSON.stringify(worker.outputFiles[0].text)};\n`,
);
execFileSync("pnpm", ["exec", "tsc", "-p", "packages/ui/tsconfig.json"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  stdio: "inherit",
});

// Bundle the version-pinned parser patches into the published adapter. Consumer
// package managers do not inherit this workspace's patchedDependencies setting.
const editor = await build({
  absWorkingDir: root,
  entryPoints: ["packages/ui/src/codemirror/editor.ts"],
  outfile: "packages/ui/dist/codemirror/editor.js",
  bundle: true,
  format: "esm",
  minify: true,
  legalComments: "inline",
  metafile: true,
  external: ["@yongsk0066/reploom", "@yongsk0066/reploom-ui/language-worker"],
});

const dependencies = new Set();
for (const input of [
  ...Object.keys(editor.metafile.inputs),
  ...Object.keys(worker.metafile.inputs),
]) {
  const directory = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1];
  if (directory) dependencies.add(directory);
}
const notices = [];
for (const directory of [...dependencies].sort()) {
  const info = JSON.parse(await readFile(path.join(root, directory, "package.json"), "utf8"));

  const names = (await readdir(path.join(root, directory)))
    .filter((name) => /^(?:licen[sc]e|copying|notice)(?:$|[._-])/i.test(name))
    .sort();

  if (!names.length) throw Error(`Missing bundled UI license: ${info.name}`);

  const texts = await Promise.all(
    names.map((name) => readFile(path.join(root, directory, name), "utf8")),
  );

  notices.push(`${info.name}@${info.version}\n${texts.join("\n")}`);
}
const notice = notices.join("\n\n");
const banner = `\n/*!\n${notice.replaceAll("*/", "* /")}\n*/\n`;
await writeFile(new URL("../packages/ui/dist/THIRD_PARTY_NOTICES.txt", import.meta.url), notice);
await appendFile(new URL("../packages/ui/dist/codemirror/editor.js", import.meta.url), banner);
await writeFile(
  new URL("../packages/ui/dist/worker-source.js", import.meta.url),
  `export const source = ${JSON.stringify(worker.outputFiles[0].text + banner)};\n`,
);
await cp(
  new URL("../packages/ui/src/styles.css", import.meta.url),
  new URL("../packages/ui/dist/styles.css", import.meta.url),
);

await cp(
  new URL("../packages/ui/src/styles.d.ts", import.meta.url),
  new URL("../packages/ui/dist/styles.d.ts", import.meta.url),
);
