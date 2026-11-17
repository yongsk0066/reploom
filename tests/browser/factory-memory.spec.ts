import { test, expect } from "@playwright/test";
import { writeCode } from "./editor-helpers";

test("detached script elements release text while factories and their error sources remain usable", async ({
  page,
  context,
}) => {
  const external: string[] = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4331" || ["data:", "blob:"].includes(url.protocol))
      return route.continue();
    external.push(url.href);
    return route.abort();
  });
  await page.goto("/regression/");

  const article = page.locator('[data-project="react-effect-events"]');
  const preview = article.frameLocator("iframe");

  await expect(article).toHaveAttribute("data-phase", "ready");
  const editor = article.getByRole("textbox", { name: "/App.js code" });

  const source = (revision: number) => `import {useState} from 'react';
globalThis.__factoryDebug=()=>new Error('debug probe').stack;
export default function App(){const [count,setCount]=useState(0);return <><h1>revision ${revision}</h1><button onClick={()=>setCount(count+1)}>count {count}</button></>;}`;

  await writeCode(editor, source(0));
  await expect(preview.locator("h1")).toHaveText("revision 0");
  await preview.getByRole("button").click();
  // A debugger/inspector may keep the originating element after a script is
  // detached. Model that owner explicitly rather than relying on GC timing.
  await preview.locator("body").evaluate(() => {
    const saved = ((globalThis as any).__scriptOrigins = []);
    const append = document.head.append;
    const bytes = new Map<string, number>();
    const create = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      const url = create.call(this, blob);
      if (blob instanceof Blob) bytes.set(url, blob.size);
      return url;
    };
    document.head.append = function (...nodes) {
      for (const node of nodes)
        if (node instanceof HTMLScriptElement)
          saved.push({
            node,
            inputBytes: node.src ? (bytes.get(node.src) ?? 0) : node.textContent.length,
          });
      return append.apply(this, nodes);
    };
  });
  const large = `const rows=[${Array.from({ length: 3000 }, (_, i) => `{id:${i},label:"row ${i}"}`).join(",")}];\n`;
  for (let revision = 1; revision <= 3; revision++) {
    await writeCode(editor, large + source(revision));
    await expect(preview.locator("h1")).toHaveText(`revision ${revision}`);
    await expect(article).toHaveAttribute("data-phase", "ready");
    await expect(preview.getByRole("button")).toHaveText("count 1");
  }

  const origins = await preview.locator("body").evaluate(() =>
    (globalThis as any).__scriptOrigins.map(
      ({ node, inputBytes }: { node: HTMLScriptElement; inputBytes: number }) => ({
        inputBytes,
        retainedText: node.textContent?.length,
        connected: node.isConnected,
      }),
    ),
  );

  expect(origins.length).toBeGreaterThanOrEqual(3);
  expect(origins.reduce((sum: number, origin: any) => sum + origin.inputBytes, 0)).toBeGreaterThan(
    300_000,
  );
  expect(origins.every((origin: any) => origin.retainedText === 0 && !origin.connected)).toBe(true);
  await preview.getByRole("button").click();
  await expect(preview.getByRole("button")).toHaveText("count 2");
  await writeCode(editor, source(4));
  await expect(preview.locator("h1")).toHaveText("revision 4");
  await expect(preview.getByRole("button")).toHaveText("count 2");

  const debug = await preview.locator("body").evaluate(() => ({
    source: (globalThis as any).__factoryDebug.toString(),
    stack: (globalThis as any).__factoryDebug(),
  }));

  expect(debug.source).toContain("debug probe");
  expect(debug.stack).toMatch(/playground:\/App\.js|blob:null\//);
  expect(external).toEqual([]);
});
