import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const consumer = fileURLToPath(new URL("../", import.meta.url));

const entries = {
  headless: `export {ProjectSession,defineProject} from '@yongsk0066/reploom'; export {createBrowserPlatform,attachPreview} from '@yongsk0066/reploom/browser';`,
  codemirror: `export {createEditor} from '@yongsk0066/reploom-ui/codemirror';`,
  reactUI: `export {Playground} from '@yongsk0066/reploom-ui/react';`,
};

const results = {};
for (const [name, contents] of Object.entries(entries)) {
  const result = await build({
    absWorkingDir: root,
    stdin: { contents, resolveDir: consumer },
    bundle: true,
    write: false,
    outdir: "artifacts/audit",
    splitting: true,
    format: "esm",
    platform: "browser",
    minify: true,
    metafile: true,
  });

  const inputs = Object.keys(result.metafile.inputs);
  const react = inputs.some((input) => /(?:^|\/)node_modules\/react(?:-dom)?\//.test(input));

  const codemirror = inputs.some((input) =>
    /@codemirror\/|(?:packages\/ui|reploom-ui)\/dist\/codemirror\/editor\.js$/.test(input),
  );

  if (name === "headless") {
    assert.equal(react, false);
    assert.equal(codemirror, false);
  }
  if (name === "codemirror") assert.equal(react, false);
  // Check runtime import edges, not type-only references, for package cycles.
  const own = new Set(inputs.filter((input) => input.startsWith("packages/")));

  const visiting = new Set();
  const done = new Set();

  function visit(input) {
    assert.ok(!visiting.has(input), `Runtime import cycle at ${input}`);
    if (done.has(input)) return;
    visiting.add(input);
    for (const dependency of result.metafile.inputs[input].imports)
      if (own.has(dependency.path)) visit(dependency.path);
    visiting.delete(input);
    done.add(input);
  }

  for (const input of own) visit(input);

  const files = result.outputFiles.map((file) => ({
    name: path.basename(file.path),
    bytes: file.contents.byteLength,
    gzipBytes: gzipSync(file.contents).byteLength,
  }));

  results[name] = {
    files,
    totalBytes: files.reduce((n, file) => n + file.bytes, 0),
    gzipBytes: files.reduce((n, file) => n + file.gzipBytes, 0),
    react,
    codemirror,
    runtimeImportCycles: 0,
  };
}

const manifest = JSON.parse(
  await readFile(path.join(root, "apps/demo/dist/reploom/manifest.json"), "utf8"),
);

const compiler = await readFile(path.join(root, "apps/demo/dist") + manifest.compilerWorker.url);
results.compilerWorker = {
  bytes: compiler.byteLength,
  gzipBytes: gzipSync(compiler).byteLength,
  initialDownloadBytes: 0,
  evidence: "gallery.spec.ts checks no compiler-worker or WASM request before first edit",
};
results.source = {
  lockSha256: createHash("sha256")
    .update(await readFile(path.join(root, "pnpm-lock.yaml")))
    .digest("hex"),
  node: process.version,
};
await mkdir(path.join(root, "artifacts/audit"), { recursive: true });
await writeFile(
  path.join(root, "artifacts/audit/packages.json"),
  JSON.stringify(results, null, 2) + "\n",
);
console.log(JSON.stringify(results, null, 2));
