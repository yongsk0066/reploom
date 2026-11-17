import { test, expect } from "@playwright/test";
import { readCode, writeCode } from "./editor-helpers";

test("an editor can be destroyed from its change callback without retaining its view", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/features/?project=react");
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  await page.evaluate(() => {
    const parent = document.createElement("div");
    parent.id = "retired-editor";
    document.body.append(parent);

    const editor = (window as any).createEditor(parent, () => {
      editor.destroy();
      editor.destroy();
    });

    editor.sync(
      { "/test.ts": "const value=1;" },
      "/test.ts",
      { "aria-label": "Retired editor" },
      false,
    );
  });
  await page.getByRole("textbox", { name: "Retired editor" }).press("x");
  await expect(page.locator("#retired-editor .cm-editor")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("compiler activation on interaction prepares without editing or replacing preview state", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/regression/?editor=interaction&compiler=interaction");
  const article = page.locator('[data-project="dom-counter"]');
  await expect(article).toHaveAttribute("data-phase", "ready");
  const preview = article.frameLocator("iframe");
  await preview.getByRole("button").click();
  expect(requests.filter((url) => /compiler-worker|\.wasm$/.test(url))).toEqual([]);
  await article.getByRole("button", { name: "Edit code", exact: true }).focus();
  await expect.poll(() => requests.filter((url) => url.endsWith(".wasm")).length).toBe(1);
  await expect(page.locator(".cm-editor")).toHaveCount(0);
  await expect(article).toHaveAttribute("data-phase", "ready");
  await expect(preview.getByRole("button")).toHaveText("DOM count 1");
});

test("syntax-only language support retains JSX closing tags and indentation", async ({ page }) => {
  await page.goto("/features/?project=react");
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  const editor = page.getByRole("textbox", { name: "Feature editor" });
  await writeCode(editor, "const element = <section");
  await editor.press("ControlOrMeta+End");
  await page.keyboard.type(">");
  expect(await readCode(editor)).toBe("const element = <section></section>");
  await writeCode(editor, "function example() {");
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  expect(await readCode(editor)).toBe("function example() {\n  ");
});

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
  await article.getByRole("tab", { name: "/styles.css", exact: true }).click();
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
  await article.getByRole("tab", { name: "/App.js", exact: true }).click();
  expect(await readCode(editor)).toBe(original + "\n// 한글 편집 확인");
  await editor.press("ControlOrMeta+z");
  expect(await readCode(editor)).toBe(original);
  await article.getByRole("tab", { name: "/styles.css", exact: true }).click();
  expect(await readCode(css)).toBe(originalCSS + "\nbody { color: rgb(10, 20, 30); }");
  await css.press("Tab");
  expect(
    await css.evaluate(
      (element) => (element.getRootNode() as ShadowRoot).activeElement === element,
    ),
  ).toBe(false);
  await article.getByRole("button", { name: "Reset source" }).click();
  await article
    .getByRole("dialog")
    .getByRole("button", { name: "Restore original", exact: true })
    .click();
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

test("typing and IME composition survive a delayed editor handoff", async ({ page }) => {
  let release!: () => void;

  const download = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route(/\/editor-[^/]+\.js$/, async (route) => {
    await download;
    await route.continue();
  });
  await page.goto("/regression/?editor=interaction");
  const article = page.locator('[data-project="dom-counter"]');
  await expect(article).toHaveAttribute("data-phase", "ready");
  const preview = article.frameLocator("iframe");
  await preview.getByRole("button").click();
  await article.getByRole("button", { name: "Edit code" }).click();
  const text = article.locator("textarea");
  try {
    await expect(text).toBeFocused();
    const initial = await text.inputValue();
    await text.evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(el.value.length, el.value.length),
    );
    await page.keyboard.type("// first ");
    await text.evaluate((el: HTMLTextAreaElement) => {
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      el.setRangeText("한글", el.selectionStart, el.selectionEnd, "end");
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: "한글",
          inputType: "insertCompositionText",
          isComposing: true,
        }),
      );
    });
    release();
    await expect
      .poll(() =>
        page.evaluate(() =>
          performance.getEntriesByType("resource").some((x) => /\/editor-[^/]+\.js$/.test(x.name)),
        ),
      )
      .toBe(true);
    await expect(text).toBeFocused();
    const intended = initial + "// first 한글";
    const caret = await text.evaluate((e) => (e as HTMLTextAreaElement).selectionEnd);
    await text.evaluate((el) =>
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한글" })),
    );
    const cm = article.locator(".cm-content");
    await expect(cm).toBeFocused();
    await page.keyboard.type("!");
    expect(caret).toBe(intended.length);
    expect(await readCode(cm)).toBe(intended + "!");
    await expect(article).toHaveAttribute("data-phase", "ready");
    await expect(preview.getByRole("button")).toHaveText("DOM count 1");
  } finally {
    release();
  }
});
