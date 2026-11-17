import { test, expect } from "@playwright/test";
import { readCode, writeCode } from "./editor-helpers";

test("status synchronization preserves selection and avoids scroll layout reads", async ({
  page,
}) => {
  await page.goto("/features/?project=react");
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  const editor = page.getByRole("textbox").first();
  await editor.press("ControlOrMeta+Home");
  await editor.press("ArrowRight");

  const result = await page.evaluate(() => {
    const host = window as any;
    const scroller = document.querySelector(".cm-scroller")!;
    const selection = getSelection()!;
    const anchor = selection.anchorNode;
    const offset = selection.anchorOffset;
    let reads = 0;
    for (const key of ["scrollTop", "scrollLeft"]) {
      let prototype = scroller;
      while (!Object.getOwnPropertyDescriptor(prototype, key))
        prototype = Object.getPrototypeOf(prototype);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
      Object.defineProperty(scroller, key, {
        configurable: true,
        get() {
          reads++;
          return descriptor.get!.call(this);
        },
        set(value) {
          descriptor.set!.call(this, value);
        },
      });
    }
    try {
      const view = host.session.getSnapshot();
      const attrs = { "aria-label": `${view.active} code`, "aria-invalid": "true" };
      host.editor.sync(view.files, view.active, attrs, false);
      reads = 0;
      for (let i = 0; i < 100; i++) host.editor.sync(view.files, view.active, attrs, false);
      const statusReads = reads;
      host.editor.sync(view.files, view.active, {}, false);
      return {
        statusReads,
        selectionPreserved: selection.anchorNode === anchor && selection.anchorOffset === offset,
        removedAttribute: !document.querySelector(".cm-content")!.hasAttribute("aria-invalid"),
      };
    } finally {
      for (const key of ["scrollTop", "scrollLeft"]) delete (scroller as any)[key];
    }
  });

  expect(result).toEqual({ statusReads: 0, selectionPreserved: true, removedAttribute: true });
});

test("highlighted editor preserves per-file edits and undo, accepts Korean text, and lets Tab leave", async ({
  page,
  context,
}, info) => {
  const external: string[] = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4331" || ["blob:", "data:"].includes(url.protocol))
      return route.continue();
    external.push(url.href);
    return route.abort();
  });
  await page.goto("/regression/");
  const article = page.locator('[data-project="react-effect-events"]');
  const editor = article.getByRole("textbox", { name: "/App.js code" });
  const original = await readCode(editor);

  const colors = () =>
    article
      .locator(".cm-line span")
      .evaluateAll((spans) => [...new Set(spans.map((s) => getComputedStyle(s).color))]);

  await expect.poll(async () => (await colors()).length).toBeGreaterThan(2);
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await page.keyboard.insertText("// 한글 편집 확인");
  await expect(article).toHaveAttribute("data-phase", "ready");
  await article.getByLabel("File", { exact: true }).selectOption("/styles.css");
  const css = article.getByRole("textbox", { name: "/styles.css code" });
  const originalCSS = await readCode(css);
  await css.press("ControlOrMeta+End");
  await css.press("Enter");
  await page.keyboard.insertText("body { color: rgb(10, 20, 30); }");
  await expect(article.frameLocator("iframe").locator("body")).toHaveCSS(
    "color",
    "rgb(10, 20, 30)",
  );
  await expect.poll(async () => (await colors()).length).toBeGreaterThan(1);
  await article.getByLabel("File", { exact: true }).selectOption("/App.js");
  expect(await readCode(editor)).toBe(original + "\n// 한글 편집 확인");
  await editor.press("ControlOrMeta+z");
  expect(await readCode(editor)).toBe(original);
  await article.getByLabel("File", { exact: true }).selectOption("/styles.css");
  expect(await readCode(css)).toBe(originalCSS + "\nbody { color: rgb(10, 20, 30); }");
  await css.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.classList.contains("cm-content"))).toBe(
    false,
  );
  await article.getByRole("button", { name: "Reset source" }).click();
  expect(await readCode(editor)).toBe(original);
  await editor.press("ControlOrMeta+z");
  expect(await readCode(editor)).toBe(original);
  await editor.press("ControlOrMeta+Home");
  await article.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("highlighting.png") });
  expect(external).toEqual([]);
});

test("explicit editor activation defers CodeMirror and preserves the running preview", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/regression/?editor=interaction");
  const article = page.locator('[data-project="dom-counter"]');
  const preview = article.frameLocator("iframe");
  await expect(article).toHaveAttribute("data-phase", "ready");
  await expect(page.locator(".cm-editor")).toHaveCount(0);
  expect(
    requests.filter((url) =>
      /\/editor(?:-session)?-[^/]+\.js(?:\?|$)|compiler-worker|\.wasm(?:\?|$)/.test(url),
    ),
  ).toEqual([]);
  await preview.getByRole("button").click();
  await preview.locator("body").evaluate(() => {
    (window as any).__editorActivationRealm = true;
  });
  const original = await article.locator(".reploom-source-preview").innerText();
  await article.getByRole("button", { name: "Edit code", exact: true }).click();
  const editor = article.getByRole("textbox", { name: "/main.ts code" });
  expect(await readCode(editor)).toBe(original);
  await expect(page.locator(".cm-editor")).toHaveCount(1);
  await expect(preview.getByRole("button")).toHaveText("DOM count 1");
  expect(requests.filter((url) => /compiler-worker|\.wasm(?:\?|$)/.test(url))).toEqual([]);
  await writeCode(editor, original.replace("DOM counter", "Activated editor"));
  await expect(preview.locator("h1")).toHaveText("Activated editor");
  await expect(preview.getByRole("button")).toHaveText("DOM count 1");
  expect(
    await preview.locator("body").evaluate(() => (window as any).__editorActivationRealm),
  ).toBe(true);
});
