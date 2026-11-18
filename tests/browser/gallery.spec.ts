import { test, expect } from "@playwright/test";
import { workersNamed } from "./worker-helpers";
import { readCode, writeCode } from "./editor-helpers";

const cases = [
  ["react-counter", "/App.tsx", "Count {count}", "Total {count}"],
  ["effect-events", "/App.tsx", "Effect Events", "Edited Effect Events"],
  ["react-lazy", "/App.tsx", "Lazy modules", "Edited lazy modules"],
  ["dom-todos", "/main.ts", "Task list", "Edited task list"],
  ["dom-canvas", "/main.ts", "Canvas animation", "Edited canvas animation"],
  ["dom-assets", "/main.ts", "Declared local asset", "Edited local asset"],
  ["module-lifecycle", "/main.ts", "Module lifecycle", "Edited module lifecycle"],
  ["compute-statistics", "/main.ts", "", ""],
  ["compute-fractal", "/main.ts", "", ""],
];

for (const [id, path, before, after] of cases)
  test(`generic example ${id} runs and edits with no external services`, async ({
    page,
    context,
  }, info) => {
    const external: string[] = [];
    const requests: string[] = [];
    const errors: string[] = [];

    page.on("pageerror", (error) => errors.push(String(error)));
    context.on("request", (request) => requests.push(request.url()));
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "http://127.0.0.1:4331" || ["blob:", "data:"].includes(url.protocol))
        return route.continue();
      external.push(url.href);
      return route.abort();
    });
    await page.goto("/#" + id);

    const article = page.locator('[data-project="' + id + '"]');
    const preview = article.frameLocator("iframe");

    await expect(article).toHaveAttribute("data-phase", "ready");
    await expect(page.locator(".reploom")).toHaveCount(1);
    expect(requests.filter((url) => /\.wasm(?:\?|$)|compiler-(?:worker|client)/.test(url))).toEqual(
      [],
    );
    if (id === "react-counter") {
      await preview.getByRole("button").click();
      await preview.getByRole("textbox").fill("Grace");
    } else if (id === "effect-events") {
      await preview.getByRole("checkbox").check();
      await preview.getByRole("combobox").selectOption("Garden");
      await expect(preview.locator("output")).toContainText("Garden connected using dark theme");
    } else if (id === "react-lazy") {
      await preview.getByRole("button", { name: "Toggle panel" }).click();
      await preview.getByRole("button", { name: "Panel count 0" }).click();
    } else if (id === "dom-todos") {
      await preview.getByRole("textbox").fill("Persistent task");
      await preview.getByRole("button", { name: "Add" }).click();
      await expect(preview.locator("ul")).toContainText("Persistent task");
    } else if (id === "dom-assets") {
      await expect
        .poll(() =>
          preview.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth),
        )
        .toBe(96);
    } else if (id.startsWith("compute-")) {
      await expect(preview.locator("pre")).toContainText('"runs": 1');
    }
    const editor = article.getByRole("textbox", { name: path + " code" });
    const original = await readCode(editor);
    if (before) expect(original).toContain(before);
    const begin = performance.now();
    await writeCode(
      editor,
      before ? original.replace(before, after) : original + "\nexport const revision = 1;",
    );
    if (id === "react-counter") {
      await expect(preview.getByRole("button")).toHaveText("Total 1");
      await expect(preview.getByRole("textbox")).toHaveValue("Grace");
    } else if (id.startsWith("compute-")) {
      await expect(preview.locator("pre")).toContainText('"runs": 2');
    } else {
      await expect(preview.locator("h1")).toContainText(after);
      if (id === "effect-events") {
        await expect(preview.getByRole("checkbox")).toBeChecked();
        await expect(preview.getByRole("combobox")).toHaveValue("Garden");
      } else if (id === "react-lazy")
        await expect(preview.getByRole("button", { name: "Panel count 1" })).toBeVisible();
      else if (id === "dom-todos")
        await expect(preview.locator("ul")).toContainText("Persistent task");
    }
    await expect(article).toHaveAttribute("data-phase", "ready");
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    await info.attach("observations", {
      body: JSON.stringify({
        id,
        firstEditObservedMs: performance.now() - begin,
        requests,
        external,
        errors,
      }),
      contentType: "application/json",
    });
  });

test("switching examples retires the previous session and keeps one preview", async ({ page }) => {
  await page.goto("/");
  const first = page.locator('[data-project="react-counter"]');
  await expect(first).toHaveAttribute("data-phase", "ready");
  const input = first.getByRole("textbox", { name: "/App.tsx code" });
  await writeCode(input, (await readCode(input)).replace("Hello,", "Welcome,"));
  await expect(first.frameLocator("iframe").getByText("Welcome, Ada.")).toBeVisible();
  const [compiler] = await workersNamed(page, "reploom-compiler");
  expect(compiler).toBeTruthy();
  const closed = compiler.waitForEvent("close");
  await page.getByRole("combobox", { name: "Choose an example" }).selectOption("dom-todos");
  await closed;
  for (const id of ["dom-todos", "compute-statistics", "effect-events"]) {
    await page.getByRole("combobox", { name: "Choose an example" }).selectOption(id);
    await expect(page.locator(`[data-project="${id}"]`)).toHaveAttribute("data-phase", "ready");
    await expect(page.locator("iframe")).toHaveCount(1);
  }
  expect(await workersNamed(page, "reploom-compiler")).toHaveLength(0);
});

test("forms dispatch local submit handlers while CSP denies native form navigation", async ({
  page,
}) => {
  await page.goto("/#dom-todos");

  const article = page.locator('[data-project="dom-todos"]');
  const preview = article.frameLocator("iframe");

  await expect(article).toHaveAttribute("data-phase", "ready");

  const result = await preview.locator("body").evaluate(
    () =>
      new Promise<{ directive: string; blocked: string }>((resolve) => {
        document.addEventListener("securitypolicyviolation", (event) => {
          if (event.violatedDirective === "form-action")
            resolve({ directive: event.violatedDirective, blocked: event.blockedURI });
        });
        const form = document.createElement("form");
        form.action = "https://example.invalid/reploom-form-probe";
        document.body.append(form);
        try {
          form.submit();
        } catch {
          /* Firefox also throws when CSP blocks submission. */
        }
      }),
  );

  expect(result.directive).toBe("form-action");
  await expect(preview.locator("h1")).toHaveText("Task list");
  expect(page.url()).toContain("/#dom-todos");
});
