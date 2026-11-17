import { workersNamed } from "./worker-helpers";
import { test, expect, type BrowserContext, type Page, type Locator } from "@playwright/test";
import { readCode, writeCode } from "./editor-helpers";

async function open(page: Page, context: BrowserContext, id: string) {
  const external: string[] = [];
  const requests = new Map<string, number>();
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    requests.set(url.pathname, (requests.get(url.pathname) || 0) + 1);
    if (url.origin === "http://127.0.0.1:4331" || ["blob:", "data:"].includes(url.protocol))
      return route.continue();
    external.push(url.href);
    return route.abort();
  });
  await page.goto("/regression/");
  const article = page.locator(`[data-project="${id}"]`);
  await expect(article).toHaveAttribute("data-phase", "ready");
  return {
    article,
    preview: article.frameLocator("iframe"),
    external,
    requests,
  };
}

async function edit(article: Locator, path: string, source: string) {
  await article.getByRole("tab", { name: path, exact: true }).click();
  await writeCode(article.getByRole("textbox", { name: `${path} code` }), source);
}

test("a declared TSX project uses its own entry, JSON, CSS and npm namespace while retaining React state", async ({
  page,
  context,
}, info) => {
  const { article, preview, external } = await open(page, context, "react-counter");

  const editor = article.getByRole("textbox", {
    name: "/src/Dashboard.tsx code",
  });

  const original = await readCode(editor);
  await preview.getByRole("button").click({ clickCount: 2 });
  await expect(preview.getByRole("button")).toHaveText("count 2");
  await expect(preview.locator("main")).toHaveClass("dashboard active"); // clsx namespace
  await preview.getByRole("textbox", { name: "Note" }).fill("Retained input");
  const marker = await preview.getByLabel("Stable reference").textContent();
  await preview.locator("body").evaluate(() => {
    (window as any).__input = document.querySelector("input");
    (window as any).__frameMarker = "same frame";
  });
  await writeCode(editor, original.replace("{settings.title}", "Edited React {settings.title}"));
  await expect(preview.locator("h1")).toHaveText("Edited React React counter");
  await expect(preview.getByRole("button")).toHaveText("count 2");
  await expect(preview.getByRole("textbox")).toHaveValue("Retained input");
  await expect(preview.getByLabel("Stable reference")).toHaveText(marker!);
  expect(
    await preview
      .locator("body")
      .evaluate(() => (window as any).__input === document.querySelector("input")),
  ).toBe(true);
  await edit(article, "/src/counter.ts", "export const increment = (count: number) => count + 2;");
  await expect(article).toHaveAttribute("data-phase", "ready");
  await preview.getByRole("button").click();
  await expect(preview.getByRole("button")).toHaveText("count 4");
  await edit(article, "/src/settings.json", '{"title":"Updated JSON"}');
  await expect(preview.locator("h1")).toHaveText("Edited React Updated JSON");
  await expect(preview.getByRole("button")).toHaveText("count 4");
  await edit(
    article,
    "/src/Dashboard.tsx",
    "import Toastify from 'toastify-js';\n" + original + "\nconsole.log(Toastify);",
  );
  await expect(article.locator(".reploom-errors")).toContainText("Undeclared dependency");
  await expect(preview.getByRole("button")).toHaveText("count 4");
  await edit(article, "/src/Dashboard.tsx", original);
  await expect(article).toHaveAttribute("data-phase", "ready");
  await expect(preview.getByRole("button")).toHaveText("count 4");
  expect(await preview.locator("body").evaluate(() => (window as any).__frameMarker)).toBe(
    "same frame",
  );
  expect(external).toEqual([]);
  await info.attach("declared-react", {
    body: JSON.stringify({
      external,
      entry: "/src/Dashboard.tsx",
      dependency: "clsx",
      state: "count 4",
      refAndDOMPreserved: true,
    }),
    contentType: "application/json",
  });
});

test("pure DOM mounts preserve explicit state, abort retired listeners and release obsolete functions without React", async ({
  page,
  context,
}, info) => {
  const { article, preview, external } = await open(page, context, "dom-counter");
  const editor = article.getByRole("textbox", { name: "/main.ts code" });
  const original = await readCode(editor);
  expect(
    await preview.locator("body").evaluate(() => ({
      kind: (globalThis as any).__PLAYGROUND_VENDOR__.kind,
      reactHook: typeof (globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__,
    })),
  ).toEqual({ kind: "dom", reactHook: "undefined" });
  await preview.getByRole("button").click({ clickCount: 2 });
  await preview.getByRole("textbox").fill("DOM Note");

  const tracked =
    original.replace(
      "count++;",
      "globalThis.__domClicks = (globalThis.__domClicks || 0) + 1; count++;",
    ) + "\nglobalThis.__mountVersions ??= []; globalThis.__mountVersions.push(new WeakRef(mount));";

  expect(tracked).toContain("__domClicks =");
  await writeCode(editor, tracked.replace("DOM counter", "DOM revision 0"));
  await expect(preview.locator("h1")).toHaveText("DOM revision 0");
  await expect(preview.getByRole("button")).toHaveText("DOM count 2");
  await expect(preview.getByRole("textbox")).toHaveValue("DOM Note");
  await preview.locator("body").evaluate(() => {
    (window as any).__oldButton = document.querySelector("button");
  });
  for (let revision = 1; revision <= 6; revision++) {
    await writeCode(editor, tracked.replace("DOM counter", `DOM revision ${revision}`));
    await expect(preview.locator("h1")).toHaveText(`DOM revision ${revision}`);
    await preview.getByRole("button").click();
    await expect(preview.getByRole("button")).toHaveText(`DOM count ${2 + revision}`);
  }
  expect(
    await preview.locator("body").evaluate(() => {
      const before = (window as any).__domClicks;
      (window as any).__oldButton.click();
      (window as any).__oldButton = undefined;
      return (window as any).__domClicks - before;
    }),
  ).toBe(0);
  await preview.locator("body").evaluate(() => {
    (window as any).__input = document.querySelector("input");
  });
  await edit(article, "/theme.css", "body { background: rgb(220, 240, 230); }");
  await expect(preview.locator("body")).toHaveCSS("background-color", "rgb(220, 240, 230)");
  expect(
    await preview
      .locator("body")
      .evaluate(() => (window as any).__input === document.querySelector("input")),
  ).toBe(true);
  await edit(
    article,
    "/format.ts",
    "export const formatCount = (count: number) => `Updated DOM ${count}`;",
  );
  await expect(preview.getByRole("button")).toHaveText("Updated DOM 8");
  await expect(preview.getByRole("textbox")).toHaveValue("DOM Note");
  let live = 99;
  await expect
    .poll(async () => {
      await page.requestGC();
      return (live = await preview
        .locator("body")
        .evaluate(
          () =>
            (window as any).__mountVersions.filter((ref: WeakRef<object>) => ref.deref()).length,
        ));
    })
    .toBeLessThanOrEqual(2);
  await edit(article, "/main.ts", "export function mount( {");
  await expect(article.locator(".reploom-errors")).toBeVisible();
  await expect(preview.getByRole("button")).toHaveText("Updated DOM 8");
  await edit(article, "/main.ts", original);
  await expect(article).toHaveAttribute("data-phase", "ready");
  await expect(preview.getByRole("button")).toHaveText("Updated DOM 8");
  await article.getByRole("button", { name: "Reset source" }).click();
  await article
    .getByRole("dialog")
    .getByRole("button", { name: "Restore original", exact: true })
    .click();
  await expect(article).toHaveAttribute("data-phase", "ready");
  await expect(preview.getByRole("button")).toHaveText("DOM count 0");
  await expect(preview.getByRole("textbox")).toHaveValue("");
  expect(external).toEqual([]);
  await info.attach("declared-dom", {
    body: JSON.stringify({
      external,
      liveMounts: live,
      retiredListenerCalls: 0,
      stateBeforeReset: 8,
      resetState: 0,
      reactInFrame: false,
    }),
    contentType: "application/json",
  });
});

test("React and DOM projects share one compiler while keeping dependency graphs and sessions independent", async ({
  page,
  context,
}, info) => {
  const {
    article: react,
    preview: reactPreview,
    external,
    requests,
  } = await open(page, context, "react-counter");

  const dom = page.locator('[data-project="dom-counter"]');
  await expect(dom).toHaveAttribute("data-phase", "ready");
  const domPreview = dom.frameLocator("iframe");

  const reactEditor = react.getByRole("textbox", {
    name: "/src/Dashboard.tsx code",
  });

  const domEditor = dom.getByRole("textbox", { name: "/main.ts code" });

  const reactSource = await readCode(reactEditor);
  const domSource = await readCode(domEditor);

  await reactPreview.getByRole("button").click();
  await domPreview.getByRole("button").click({ clickCount: 2 });
  await writeCode(reactEditor, reactSource.replace("{settings.title}", "Concurrent React"));
  await writeCode(domEditor, domSource.replace("DOM counter", "Concurrent DOM"));
  await expect(reactPreview.locator("h1")).toHaveText("Concurrent React");
  await expect(domPreview.locator("h1")).toHaveText("Concurrent DOM");
  await expect(reactPreview.getByRole("button")).toHaveText("count 1");
  await expect(domPreview.getByRole("button")).toHaveText("DOM count 2");
  expect(await workersNamed(page, "reploom-compiler")).toHaveLength(1);

  const manifest = await page.evaluate(async () =>
    (await fetch("/regression/assets/manifest.json")).json(),
  );

  const commonRuntime = manifest.projects["react-counter"].vendor[0].url;
  expect(manifest.projects["react-effect-dependencies"].vendor[0].url).toBe(commonRuntime);
  expect(manifest.projects["dom-counter"].vendor).toHaveLength(1);
  expect(manifest.projects["dom-counter"].vendor[0].url).not.toBe(commonRuntime);
  expect(requests.get(commonRuntime)).toBe(1);
  expect(external).toEqual([]);
  await info.attach("mixed-projects", {
    body: JSON.stringify({
      external,
      compilerWorkers: 1,
      reactState: 1,
      domState: 2,
      sharedReactRuntimeRequests: requests.get(commonRuntime),
    }),
    contentType: "application/json",
  });
});

test("a source-map-only edit does not reevaluate modules, restart effects or replace the frame", async ({
  page,
  context,
}, info) => {
  const { article, preview, external } = await open(page, context, "react-counter");

  const editor = article.getByRole("textbox", {
    name: "/src/Dashboard.tsx code",
  });

  const source = `import {useState, useEffect} from 'react';
globalThis.__evaluations = (globalThis.__evaluations || 0) + 1;
export default function Counter(){
  const [count,setCount] = useState(0);
  useEffect(()=>{globalThis.__effects=(globalThis.__effects||0)+1;},[]);
  return <button onClick={()=>setCount(count+1)}>count {count}</button>;
}`;

  await writeCode(editor, source);
  await expect(article).toHaveAttribute("data-phase", "ready");
  await expect(preview.getByRole("button")).toHaveText("count 0");
  await preview.getByRole("button").click();

  const before = await preview.locator("body").evaluate(() => {
    (window as any).__sameButton = document.querySelector("button");
    return {
      evaluations: (window as any).__evaluations,
      effects: (window as any).__effects,
    };
  });

  await writeCode(editor, source + "\n");
  await expect(article).toHaveAttribute("data-phase", "ready");
  await expect(preview.getByRole("button")).toHaveText("count 1");
  expect(
    await preview.locator("body").evaluate(() => ({
      evaluations: (window as any).__evaluations,
      effects: (window as any).__effects,
    })),
  ).toEqual(before);
  expect(
    await preview
      .locator("body")
      .evaluate(() => (window as any).__sameButton === document.querySelector("button")),
  ).toBe(true);
  expect(external).toEqual([]);
  await info.attach("metadata-only-edit", {
    body: JSON.stringify({
      before,
      noReevaluation: true,
      sameDOM: true,
      external,
    }),
    contentType: "application/json",
  });
});
