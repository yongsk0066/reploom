import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { chromium, firefox, webkit } from "@playwright/test";

const require = createRequire(new URL("../packages/ui/package.json", import.meta.url));

const alias = Object.fromEntries(
  ["view", "commands", "state"].map((name) => [
    `@codemirror/${name}`,
    require.resolve(`@codemirror/${name}`).replace(/\.cjs$/, ".js"),
  ]),
);

const bundles = {};
const hashes = {};
for (const variant of ["current"]) {
  const built = await build({
    stdin: {
      contents: `import {createEditor} from './packages/ui/src/codemirror/editor.ts'; import {EditorView} from '@codemirror/view'; import {undo} from '@codemirror/commands'; window.api={createEditor,EditorView,undo};`,
      resolveDir: process.cwd(),
    },
    alias,
    bundle: true,
    write: false,
    format: "iife",
  });

  hashes[variant] = createHash("sha256").update(built.outputFiles[0].contents).digest("hex");

  bundles[variant] = built.outputFiles[0].text;
}

const server = createServer((req, res) => {
  const variant = req.url.slice(1);
  res.setHeader("content-type", "text/html");
  res.end(
    `<!doctype html><style>#editor{width:800px;height:200px}.cm-editor{height:100%}.cm-scroller{overflow:auto}#layout{display:grid;grid-template-columns:repeat(8,1fr)}</style><div id="status"></div><div id="layout">${"<div>flow</div>".repeat(800)}</div><div id="editor"></div><script>${bundles[variant]}</script>`,
  );
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const results = {};
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await launcher.launch();
    results[engine] = { version: browser.version(), samples: [] };
    try {
      for (let round = 0; round < 5; round++)
        for (const variant of ["current"]) {
          const page = await browser.newPage();
          await page.goto(`http://127.0.0.1:${server.address().port}/${variant}`);

          const observation = await page.evaluate(async () => {
            const { createEditor, EditorView, undo } = window.api;
            let files = {
              "/one.js": "const first=1;",
              "/two.js": "const second=2;",
              "/long.js": "const value = 1;\n".repeat(500),
            };
            let active = "/one.js";
            let changes = 0;

            const editor = createEditor(
              document.querySelector("#editor"),
              (path, source) => {
                files = { ...files, [path]: source };
                changes++;
                editor.sync(files, active, {}, false);
              },
              { language: false },
            );

            const sync = (reset = false, attrs = {}) => editor.sync(files, active, attrs, reset);

            const check = (value, message) => {
              if (!value) throw Error(message);
            };

            const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
            sync();
            const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
            view.dispatch({
              changes: { from: view.state.doc.length, insert: "\n// 한글😀" },
              selection: { anchor: 5 },
              userEvent: "input.type",
            });
            const saved = view.state;
            sync(false, { "aria-invalid": "true" });
            sync();
            check(view.state.selection.main.head === 5, "Selection changed on status sync");
            check(!view.contentDOM.hasAttribute("aria-invalid"), "Removed attributes persisted");
            active = "/two.js";
            sync();
            files = { ...files, "/one.js": files["/one.js"].toString() + "\n// external" };
            active = "/one.js";
            sync();
            check(
              view.state.doc.toString().endsWith("// external"),
              "Inactive replacement missing",
            );
            check(undo(view), "File history lost");
            check(!view.state.doc.toString().includes("한글"), "Undo failed");
            active = "/long.js";
            sync();
            await frame();
            await frame();
            view.scrollDOM.scrollTop = 400;
            await frame();
            await frame();
            const top = view.scrollDOM.scrollTop;
            active = "/two.js";
            sync();
            active = "/long.js";
            sync();
            check(Math.abs(view.scrollDOM.scrollTop - top) < 2, "File scroll not restored");
            active = "/one.js";
            sync(true);
            check(!undo(view), "Reset retained undo");
            files = { ...files, "/two.js": "const replacement=3;" };
            active = "/two.js";
            sync();
            check(view.state.doc.toString() === files[active], "Reset retained inactive state");
            await frame();
            await frame();
            let reads = 0;
            for (const key of ["scrollTop", "scrollLeft"]) {
              let prototype = view.scrollDOM;
              while (!Object.getOwnPropertyDescriptor(prototype, key))
                prototype = Object.getPrototypeOf(prototype);
              const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
              Object.defineProperty(view.scrollDOM, key, {
                configurable: true,
                get() {
                  reads++;
                  return descriptor.get.call(this);
                },
                set(value) {
                  descriptor.set.call(this, value);
                },
              });
            }

            const measure = (count, dirty) => {
              reads = 0;
              const start = performance.now();
              for (let i = 0; i < count; i++) {
                if (dirty) document.querySelector("#status").style.height = `${(i % 2) + 10}px`;
                sync();
              }
              return { ms: performance.now() - start, scrollReads: reads, count };
            };

            const clean = measure(1000, false);
            const invalidated = measure(100, true);
            check(view.state.doc.toString() === files[active], "Status sync changed document");
            check(
              changes >= 2 && saved.doc.toString().endsWith("한글😀"),
              "Edit callback/history mismatch",
            );
            editor.destroy();
            editor.sync(files, active, {}, false);
            check(!document.querySelector(".cm-editor"), "Disposed editor remains mounted");
            return { clean, invalidated, contracts: true };
          });

          if (variant === "after") {
            assert.equal(observation.clean.scrollReads, 0);
            assert.equal(observation.invalidated.scrollReads, 0);
          }
          results[engine].samples.push({ variant, round, ...observation });
          console.log(engine, variant, round, observation.clean.ms, observation.invalidated.ms);
          await page.close();
        }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  const output = process.argv[2] ?? "artifacts/editor-sync.json";
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        hashes,
        scope:
          "Five trials per engine. Same dependencies, language disabled, 1000 status-only synchronizations and 100 synchronizations interleaved with host layout invalidation. The latter deliberately exposes forced layout and is not typing latency. Selection, undo, inactive changes, reset, scroll, attributes and disposal asserted.",
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
