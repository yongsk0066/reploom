import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prepareProjects } from "@yongsk0066/reploom-build";
import { projects } from "./projects/projects.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const site = path.join(root, "artifacts/browser-site");
await rm(site, { recursive: true, force: true });
await cp(path.join(root, "apps/demo/dist"), site, { recursive: true });
await prepareProjects({
  projects,
  projectRoot: fileURLToPath(new URL("../../", import.meta.url)),
  outDir: path.join(site, "regression/assets"),
  publicBase: "/regression/assets/",
});
await build({
  entryPoints: [fileURLToPath(new URL("./main.tsx", import.meta.url))],
  outdir: path.join(site, "regression/app"),
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"development"' },
});
await mkdir(path.join(site, "regression"), { recursive: true });
await writeFile(
  path.join(site, "regression/index.html"),
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reploom regression fixtures</title><link rel="stylesheet" href="/regression/app/main.css"><style>body{margin:0;background:#0f172a;color:#e2e8f0;font:16px system-ui}main{max-width:1200px;margin:auto;padding:24px 16px}h1{font-size:24px}</style><div id="app"></div><script type="module" src="/regression/app/main.js"></script></html>',
);
