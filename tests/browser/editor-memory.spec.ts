import { test, expect } from "@playwright/test";
import { readCode, writeCode } from "./editor-helpers";

test("large document replacements keep undo, redo, Unicode, highlighting and React state", async ({
  page,
  context,
}) => {
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
  const preview = article.frameLocator("iframe");

  await expect(article).toHaveAttribute("data-phase", "ready");
  const editor = article.getByRole("textbox", { name: "/App.js code" });
  const original = await readCode(editor);
  await preview.getByRole("combobox").selectOption("travel");
  await preview.getByRole("checkbox").check();
  const rows = `const rows = [${Array.from({ length: 3000 }, (_, i) => `{id:${i},label:"Item ${i}"}`).join(",")}];\n`;
  const first = rows + original.replace("Room:", "Large file 😀");
  const second = first.replace("Large file 😀", "Large file 😃");
  await writeCode(editor, first);
  await expect(preview.locator("h1")).toContainText("Large file 😀 travel");
  // A full paste changes one surrogate pair and normalizes platform newlines.
  await writeCode(editor, second.replaceAll("\n", "\r\n"));
  await expect(preview.locator("h1")).toContainText("Large file 😃 travel");
  expect(await readCode(editor)).toBe(second);
  await editor.press("ControlOrMeta+z");
  await expect(preview.locator("h1")).toContainText("Large file 😀 travel");
  expect(await readCode(editor)).toBe(first);
  await editor.press("ControlOrMeta+Shift+Z");
  await expect(preview.locator("h1")).toContainText("Large file 😃 travel");
  expect(await readCode(editor)).toBe(second);
  await editor.press("ControlOrMeta+End");
  await page.keyboard.type("\n// ordinary typing");
  expect(await readCode(editor)).toBe(second + "\n// ordinary typing");
  await writeCode(editor, original);
  await expect(preview.locator("h1")).toContainText("Room: travel");
  // Undo must restore the whole large document after shrinking back to a demo.
  await editor.press("ControlOrMeta+z");
  await expect(preview.locator("h1")).toContainText("Large file 😃 travel");
  expect(await readCode(editor)).toBe(second + "\n// ordinary typing");
  await expect(preview.getByRole("checkbox")).toBeChecked();
  await expect(article.locator(".cm-content .cm-line span").first()).toBeVisible();
  expect(external).toEqual([]);
});
