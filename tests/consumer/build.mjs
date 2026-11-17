import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { defineProject, ProjectSession } from "@yongsk0066/reploom";
import { createBrowserPlatform } from "@yongsk0066/reploom/browser";
import { prepareProjects } from "@yongsk0066/reploom-build";

const require = createRequire(import.meta.url);
for (const name of [
  "@codemirror/state",
  "@lezer/common",
  "react",
  "acorn",
  "oxc-transform",
  "magic-string",
])
  assert.throws(() => require.resolve(name), { code: "MODULE_NOT_FOUND" });

// Both public runtime entries must import in Node without browser globals.
assert.equal(typeof ProjectSession, "function");
const inert = createBrowserPlatform({ manifestUrl: "https://fixture.invalid/manifest.json" });
inert.dispose();

const files = {
  "/main.js": `export function mount(root, { state }) {
    state.count ??= 0;
    root.innerHTML = '<h2>Original</h2><button></button>';
    const button = root.querySelector('button');
    const show = () => button.textContent = 'Count ' + state.count;
    button.onclick = () => { state.count++; show(); };
    show();
    return () => { button.onclick = null; };
  }`,
};

const project = defineProject({
  id: "same-id",
  title: "Headless",
  runtime: "dom",
  entry: "/main.js",
  files,
});

for (const name of ["one", "two"])
  await prepareProjects({
    projects: [project],
    outDir: `dist/${name}/assets`,
    publicBase: `/headless/${name}/assets/`,
  });

const result = await build({
  entryPoints: ["main.mjs"],
  outfile: "dist/main.js",
  bundle: true,
  format: "esm",
  splitting: false,
  platform: "browser",
  target: "es2022",
  metafile: true,
});

assert.equal(
  Object.keys(result.metafile.inputs).some((name) =>
    /node_modules\/(react|react-dom|@codemirror)\//.test(name),
  ),
  false,
);
await mkdir("dist", { recursive: true });
await writeFile(
  "dist/index.html",
  '<!doctype html><meta charset="utf-8"><title>Headless consumer</title><div id="one"></div><div id="two"></div><button id="edit-one">Edit one</button><button id="edit-two">Edit two</button><button id="dispose-one">Dispose one</button><script type="module" src="/headless/main.js"></script>',
);

const editor = await build({
  entryPoints: ["editor.mjs"],
  outdir: "dist/editor",
  bundle: true,
  format: "esm",
  splitting: true,
  platform: "browser",
  target: "es2022",
  metafile: true,
});

assert.equal(
  Object.keys(editor.metafile.inputs).some((name) =>
    /node_modules\/(react|react-dom)\//.test(name),
  ),
  false,
);
assert.ok(
  Object.keys(editor.metafile.inputs).some((name) => name.endsWith("dist/worker-source.js")),
);
await writeFile(
  "dist/editor/index.html",
  '<!doctype html><meta charset="utf-8"><title>Packed editor</title><div id="editor"></div><script type="module" src="/headless/editor/editor.js"></script>',
);

const combined = await build({
  stdin: {
    contents:
      "export { Playground } from '@yongsk0066/reploom-ui/react'; export { createEditor } from '@yongsk0066/reploom-ui/codemirror';",
    resolveDir: process.cwd(),
  },
  outdir: "dist/combined",
  write: false,
  bundle: true,
  format: "esm",
  splitting: true,
  platform: "browser",
  metafile: true,
  external: ["react"],
});

let editorImplementations = 0;
for (const filename of Object.keys(combined.metafile.inputs))
  if (filename !== "<stdin>" && (await readFile(filename, "utf8")).includes("@codemirror/view@"))
    editorImplementations++;
assert.equal(
  editorImplementations,
  1,
  "React and direct editor imports share one bundled CodeMirror implementation",
);
