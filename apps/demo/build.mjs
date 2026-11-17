import { build } from "esbuild";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prepareProjects } from "@yongsk0066/reploom-build";
import { projects } from "./examples/projects.mjs";

const root = fileURLToPath(new URL("./", import.meta.url));
const out = path.join(root, "dist");

await rm(out, { recursive: true, force: true });
await prepareProjects({
  projects,
  projectRoot: root,
  outDir: path.join(out, "reploom"),
  publicBase: "/reploom/",
  publicDir: fileURLToPath(new URL("./examples/", import.meta.url)),
});
await build({
  entryPoints: [path.join(root, "main.tsx")],
  outdir: path.join(out, "app"),
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: true,
});
await mkdir(out, { recursive: true });
await writeFile(
  path.join(out, "index.html"),
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reploom examples</title><link rel="stylesheet" href="/app/main.css"><div id="app"></div><script type="module" src="/app/main.js"></script></html>',
);
