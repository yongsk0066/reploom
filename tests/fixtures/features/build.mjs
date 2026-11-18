import { build } from "esbuild";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prepareProjects } from "@yongsk0066/reploom-build";
import { projects } from "./projects.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const site = path.join(root, "artifacts/browser-site/features");
await mkdir(site, { recursive: true });
await prepareProjects({
  projects,
  projectRoot: fileURLToPath(new URL("../../", import.meta.url)),
  outDir: path.join(site, "assets"),
  publicBase: "/features/assets/",
  publicDir: path.join(root, "apps/demo/examples"),
  typecheck: { compilerOptions: { checkJs: false } },
});
await build({
  entryPoints: [fileURLToPath(new URL("./main.ts", import.meta.url))],
  outdir: path.join(site, "app"),
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
await writeFile(
  path.join(site, "index.html"),
  '<!doctype html><html><meta charset="utf-8"><title>Revision contracts</title><style>iframe{width:600px;height:240px}#editor{max-height:400px;overflow:auto}</style><div id="editor"></div><div id="preview"></div><script type="module" src="/features/app/main.js"></script></html>',
);
