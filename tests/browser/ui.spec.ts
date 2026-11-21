import { test, expect } from "@playwright/test";
import { readCode, writeCode } from "./editor-helpers";

test("the shared shadow surface isolates page rules and keeps accessible names in its tree", async ({
  page,
}) => {
  await page.goto("/regression/");
  const article = page.locator('[data-project="react-effect-events"]');
  await expect(article).toHaveAttribute("data-phase", "ready");
  await page.addStyleTag({
    content: `header { position: fixed !important; inset: 0 !important; }
    .reploom { color: red !important; } button, h2 { font-size: 60px !important; padding: 80px !important; }`,
  });
  const tab = article.getByRole("tab", { name: "/App.js", exact: true });
  await expect(tab).toHaveCSS("font-size", "13px");
  expect((await tab.boundingBox())!.height).toBeLessThanOrEqual(40);

  const result = await article.evaluate((element) => {
    const root = element.getRootNode() as ShadowRoot;
    const others = [...document.querySelectorAll(".reploom-host")].map((host) => host.shadowRoot!);

    const missing = [
      ...root.querySelectorAll("[aria-labelledby], [aria-describedby], [aria-controls]"),
    ].flatMap((node) =>
      ["aria-labelledby", "aria-describedby", "aria-controls"].flatMap((key) =>
        (node.getAttribute(key)?.split(/\s+/) ?? []).filter((id) => !root.getElementById(id)),
      ),
    );

    return {
      shadow: root.mode,
      delegates: root.delegatesFocus,
      missing,
      shared: others.every((other) =>
        other.adoptedStyleSheets.includes(root.adoptedStyleSheets[0]),
      ),
    };
  });

  expect(result).toEqual({ shadow: "open", delegates: false, missing: [], shared: true });
});

test("view changes and expansion keep the mounted preview and editor without loading a compiler", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/regression/");
  const article = page.locator('[data-project="dom-counter"]');
  await expect(article).toHaveAttribute("data-phase", "ready");
  const frame = article.frameLocator("iframe");
  await frame.getByRole("button").click();
  await article.locator("iframe").evaluate((element) => {
    element.dataset.identity = "original";
  });
  await article.getByRole("button", { name: "Code", exact: true }).click();
  await expect(article.locator("iframe")).toBeHidden();
  await article.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(article.locator(".cm-content")).toBeHidden();
  await expect(frame.getByRole("button")).toHaveText("DOM count 1");
  await article.getByRole("button", { name: "Both", exact: true }).click();
  await article.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(article.locator("iframe")).toHaveCSS("height", "600px");
  await article.getByRole("button", { name: "Collapse", exact: true }).click();
  await expect(article.locator("iframe")).toHaveAttribute("data-identity", "original");
  await expect(frame.getByRole("button")).toHaveText("DOM count 1");
  expect(requests.filter((url) => /compiler-worker|\.wasm$/.test(url))).toEqual([]);
});

test("file tabs support roving keys and reset confirmation preserves edits on cancel", async ({
  page,
}) => {
  await page.goto("/regression/");
  const article = page.locator('[data-project="react-effect-events"]');
  await expect(article).toHaveAttribute("data-phase", "ready");
  await article.evaluate((element) => {
    const host = (element.getRootNode() as ShadowRoot).host as HTMLElement;
    host.style.width = "320px";
    host.style.marginLeft = "120px";
  });
  const first = article.getByRole("tab", { name: "/App.js", exact: true });
  await first.focus();
  await first.press("End");
  await expect(article.getByRole("tab").last()).toBeFocused();
  await expect
    .poll(() =>
      article
        .getByRole("tab")
        .last()
        .evaluate((tab) => {
          const box = tab.getBoundingClientRect();
          const strip = tab.parentElement!.getBoundingClientRect();
          return box.left >= strip.left && box.right <= strip.right + 1;
        }),
    )
    .toBe(true);
  await article.getByRole("tab").last().press("Home");
  await expect(first).toBeFocused();
  await first.press("Tab");
  const editor = article.getByRole("textbox", { name: "/App.js code" });
  await expect(editor).toBeFocused();
  const original = await readCode(editor);
  const edited = original + "\n// retained edit";
  await writeCode(editor, edited);
  await expect(article).toHaveAttribute("data-phase", "ready");
  const reset = article.getByRole("button", { name: "Reset source" });
  await reset.focus();
  await reset.press("Enter");
  const dialog = article.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(reset).toBeFocused();
  expect(await readCode(editor)).toBe(edited);
  await reset.click();
  await dialog.getByRole("button", { name: "Restore original", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => readCode(editor)).toBe(original);
});

test("layout follows the component width and diagnostics reveal a hidden editor", async ({
  page,
}) => {
  await page.goto("/regression/");
  const article = page.locator('[data-project="dom-counter"]');
  await expect(article).toHaveAttribute("data-phase", "ready");
  await article.evaluate((element) => {
    ((element.getRootNode() as ShadowRoot).host as HTMLElement).style.width = "350px";
  });
  await expect(article.locator(".reploom-preview")).toBeHidden();
  await article.getByRole("button", { name: "Both", exact: true }).click();
  const editorBox = (await article.locator(".reploom-editor").boundingBox())!;
  const previewBox = (await article.locator(".reploom-preview").boundingBox())!;
  expect(previewBox.y).toBeGreaterThanOrEqual(editorBox.y + editorBox.height);
  expect(previewBox.x).toBe(editorBox.x);
  const editor = article.getByRole("textbox");
  await writeCode(editor, "export function mount( {");
  await expect(article).toHaveAttribute("data-phase", "error");
  await article.locator(".reploom-errors button").first().click();
  await expect(article).toHaveAttribute("data-view", "split");
  await expect(editor).toBeFocused();
  await article.getByRole("button", { name: "Preview", exact: true }).click();
  await article.locator(".reploom-errors button").first().click();
  await expect(article).toHaveAttribute("data-view", "code");
  await expect(editor).toBeFocused();
});

test("diagonal wheel gestures keep one axis and release to the page at the editor boundary", async ({
  page,
}) => {
  await page.goto("/regression/");
  const article = page.locator('[data-project="dom-counter"]');
  await expect(article).toHaveAttribute("data-phase", "ready");
  const editor = article.getByRole("textbox");
  await writeCode(
    editor,
    (await readCode(editor)) + "\n/*\n" + ("x".repeat(200) + "\n").repeat(100) + "*/",
  );
  await expect(article).toHaveAttribute("data-phase", "ready");
  const scroller = article.locator(".cm-scroller");
  await scroller.scrollIntoViewIfNeeded();
  await scroller.evaluate((element) => {
    element.scrollLeft = 80;
    element.scrollTop = 200;
  });

  const position = () =>
    scroller.evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop }));

  await scroller.hover();
  await scroller.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            element.scrollLeft = 80;
            resolve();
          }),
        );
      }),
  );
  const initial = await position();
  await page.mouse.wheel(30, 100);
  await expect.poll(async () => (await position()).y).toBeGreaterThan(200);
  expect((await position()).x).toBe(initial.x);
  await page.waitForTimeout(200);
  const before = await position();
  await page.mouse.wheel(100, 30);
  await expect.poll(async () => (await position()).x).toBeGreaterThan(before.x);
  expect((await position()).y).toBe(before.y);
  await page.waitForTimeout(200);

  const result = await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    const before = scrollY;
    element.dispatchEvent(
      new WheelEvent("wheel", { deltaX: 5, deltaY: 100, bubbles: true, cancelable: true }),
    );

    const zoom = new WheelEvent("wheel", {
      deltaY: 10,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    element.dispatchEvent(zoom);
    return { pageMoved: scrollY > before, zoomCancelled: zoom.defaultPrevented };
  });

  expect(result).toEqual({ pageMoved: true, zoomCancelled: false });
});

test("controls reflow with larger user text inside a narrow embed", async ({ page }) => {
  await page.goto("/regression/");
  const article = page.locator('[data-project="dom-counter"]');
  await expect(article).toHaveAttribute("data-phase", "ready");
  await article.evaluate((element) => {
    ((element.getRootNode() as ShadowRoot).host as HTMLElement).style.width = "320px";
    document.documentElement.style.fontSize = "32px";
  });
  await expect(article.getByRole("tab").first()).toHaveCSS("font-size", "26px");
  expect(await article.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  const tab = (await article.getByRole("tab").first().boundingBox())!;
  const editor = (await article.locator(".reploom-code-editor").boundingBox())!;
  expect(tab.y + tab.height).toBeLessThanOrEqual(editor.y);
  await article.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(article.locator("iframe")).toBeVisible();
  await article.getByRole("button", { name: "Reset source" }).click();
  await expect(article.getByRole("dialog")).toBeVisible();
  await article.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(article.getByRole("dialog")).toBeHidden();
});

test("display settings preserve the editor, undo history and live preview", async ({ page }) => {
  await page.goto("/regression/?editor=interaction");
  const article = page.locator('[data-project="dom-counter"]');
  await expect(article).toHaveAttribute("data-phase", "ready");
  const preview = article.frameLocator("iframe");
  await preview.getByRole("button").click();
  const settings = article.getByRole("button", { name: "Display settings", exact: true });
  const dialog = article.getByRole("dialog");
  await settings.click();
  await dialog.getByLabel("Line numbers").selectOption("always");
  await dialog.getByLabel("Wrap long lines").selectOption("on");
  await dialog.getByLabel("Code text size").selectOption("larger");
  await dialog.getByLabel("Color theme").selectOption("dark");
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await expect(article.locator(".reploom-source-preview")).toHaveCSS("white-space", "pre-wrap");
  await expect(article.locator(".reploom-source-line[data-line='2']")).toBeVisible();
  await expect(article.locator(".cm-editor")).toHaveCount(0);
  await expect(article).toHaveCSS("color-scheme", "dark");
  await article.getByRole("button", { name: "Edit code", exact: true }).click();
  const editor = article.getByRole("textbox", { name: "/main.ts code" });
  const original = await readCode(editor);
  await writeCode(editor, original.replace("DOM counter", "Display changes"));
  await expect(preview.locator("h1")).toHaveText("Display changes");
  await editor.evaluate((el) => (el.dataset.identity = "same"));
  await article.locator("iframe").evaluate((el) => (el.dataset.identity = "same"));
  await settings.click();
  await dialog.getByLabel("Line numbers").selectOption("off");
  await dialog.getByLabel("Color theme").selectOption("light");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(article.locator(".cm-lineNumbers")).toHaveCount(0);
  await expect(editor).toHaveAttribute("data-identity", "same");
  await expect(editor).toHaveCSS("font-size", "16px");
  await expect(article.locator("iframe")).toHaveAttribute("data-identity", "same");
  await editor.press("ControlOrMeta+z");
  await expect(preview.locator("h1")).toHaveText("DOM counter");
  await expect(preview.getByRole("button")).toHaveText("DOM count 1");
  await page.reload();
  await expect(article).toHaveAttribute("data-theme", "light");
  await settings.click();
  await expect(dialog.getByLabel("Line numbers")).toHaveValue("off");
  await dialog.getByRole("button", { name: "Reset display settings" }).click();
  await expect(dialog.getByLabel("Line numbers")).toHaveValue("editing");
});

test("a check result reveals its source and annotates the current line", async ({ page }) => {
  await page.goto("/#dom-todos");
  const article = page.locator('[data-project="dom-todos"]');
  await expect(article).toHaveAttribute("data-phase", "ready");
  await article.getByRole("tab", { name: "/check.ts", exact: true }).click();
  const editor = article.getByRole("textbox", { name: "/check.ts code" });
  await writeCode(editor, "export const bad: number = 'text';\nexport function test() {}");
  await article.getByRole("tab", { name: "/main.ts", exact: true }).click();
  await article.getByRole("button", { name: "Preview", exact: true }).click();
  await article.getByRole("button", { name: "Check types", exact: true }).click();
  await article
    .locator(".reploom-tools")
    .getByRole("button", { name: "/check.ts:1", exact: true })
    .click();
  await expect(article).toHaveAttribute("data-view", "code");
  await expect(editor).toBeFocused();
  await expect(editor.locator(".reploom-error-line").first()).toContainText("bad");
  await writeCode(
    editor,
    "export function test({assert}) {\n  assert(false, 'isolated diagnostic');\n}",
  );
  await article.getByRole("tab", { name: "/main.ts", exact: true }).click();
  await article.getByRole("button", { name: "Preview", exact: true }).click();
  await article.getByRole("button", { name: "Run isolated tests", exact: true }).click();
  await article
    .locator(".reploom-tools")
    .getByRole("button", { name: "/check.ts:2", exact: true })
    .click();
  await expect(editor).toBeFocused();
  await expect(editor.locator(".reploom-error-line").first()).toContainText("isolated diagnostic");
});

test("console discloses dropped messages, formats arrays and clears them", async ({ page }) => {
  await page.goto("/#dom-todos");
  const article = page.locator('[data-project="dom-todos"]');
  await expect(article).toHaveAttribute("data-phase", "ready");
  const editor = article.getByRole("textbox", { name: "/main.ts code" });
  await writeCode(
    editor,
    'export function mount(root) {root.textContent="Logs"; for(let i=0;i<120;i++)console.log([i, "ok"]);}',
  );
  const logs = article.locator(".reploom-console");
  await logs.locator("summary").click();
  await expect(logs).toContainText("90 earlier or excess messages omitted.");
  await expect(logs.locator("pre")).toContainText("[99, ok]");
  await logs.getByRole("button", { name: "Clear console" }).click();
  await expect(logs).toHaveCount(0);
});
