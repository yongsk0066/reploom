import { readCode, writeCode } from "./editor-helpers";
import { test, expect } from "@playwright/test";

test("three React effect fixtures run and edit with all external services blocked", async ({
  page,
  context,
}, testInfo) => {
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
    return route.abort("blockedbyclient");
  });
  await page.goto("/regression/");
  for (const id of ["react-effect-dependencies", "react-stale-closure", "react-effect-events"]) {
    const article = page.locator(`[data-project="${id}"]`);
    await expect(article).toHaveAttribute("data-phase", "ready");
    await expect(article.frameLocator("iframe").locator("h1")).toContainText("general");
    await expect(article.frameLocator("iframe").locator("h1")).toBeVisible();
  }
  expect(requests.filter((url) => /\.wasm(?:\?|$)|compiler[-.]worker/.test(url))).toEqual([]);
  expect(external).toEqual([]);
  const article = page.locator('[data-project="react-effect-events"]');
  const preview = article.frameLocator("iframe");
  const editor = article.getByRole("textbox", { name: "/App.js code" });
  const original = await readCode(editor);
  await preview.getByRole("checkbox").check();
  await preview.getByRole("combobox").selectOption("travel");
  // Toastify 1.12 inserts the newest notification before the first child.
  // The initial light-theme toast may still be present when travel connects.
  const toast = preview.locator(".toastify").filter({ hasText: "Connection ready" }).first();
  await expect(toast).toBeVisible();
  await expect(toast).toHaveCSS("background-color", "rgb(0, 0, 0)");

  await writeCode(editor, original.replace("Room:", "Local compile complete"));
  await expect(preview.locator("h1")).toContainText("Local compile complete travel");
  await expect(preview.getByRole("checkbox")).toBeChecked();
  await expect(article).toHaveAttribute("data-phase", "ready");
  expect(requests.some((url) => /\.wasm(?:\?|$)/.test(url))).toBe(true);
  expect(requests.some((url) => /\/oxc\.[a-f0-9]+\.wasm$/.test(url))).toBe(true);
  expect(requests.some((url) => /babel|esbuild.*\.wasm/.test(url))).toBe(false);
  expect(
    await preview.locator("body").evaluate(() => {
      try {
        void parent.document.body;
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  expect(
    await preview.locator("body").evaluate(() => {
      try {
        localStorage.setItem("sandbox-probe", "1");
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  expect(
    await preview.locator("body").evaluate(async () => {
      try {
        await fetch("https://example.invalid/reploom-probe");
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);

  // Compile failures and compatible recovery both preserve the running state.
  await preview.getByRole("combobox").selectOption("music");
  await writeCode(editor, "export default function App( {");
  await expect(article.locator(".reploom-errors")).toBeVisible();
  await expect(article.locator(".reploom-errors")).toContainText("App.js");
  await expect(preview.locator("h1")).toContainText("Local compile complete music");
  await writeCode(editor, original.replace("Room:", "Recovered"));
  await expect(preview.locator("h1")).toContainText("Recovered music");
  await expect(preview.getByRole("checkbox")).toBeChecked();

  // Edit CSS and an imported module, keeping the App edit across file changes.
  await article.getByLabel("File", { exact: true }).selectOption("/styles.css");
  const css = article.getByRole("textbox", { name: "/styles.css code" });
  await writeCode(css, (await readCode(css)) + "\nbody { background: rgb(230, 240, 250); }");
  await expect(preview.locator("body")).toHaveCSS("background-color", "rgb(230, 240, 250)");
  await article.getByLabel("File", { exact: true }).selectOption("/notifications.js");
  const notifications = article.getByRole("textbox", { name: "/notifications.js code" });
  await writeCode(
    notifications,
    (await readCode(notifications)).replace("text: message", 'text: "Prepared notification"'),
  );
  await expect(
    preview.locator(".toastify").filter({ hasText: "Prepared notification" }).first(),
  ).toBeVisible();
  await expect(preview.locator("h1")).toContainText("Recovered");

  await article.getByLabel("File", { exact: true }).selectOption("/App.js");
  await writeCode(editor, original.replace("Room:", "Intermediate revision"));
  await writeCode(editor, original.replace("Room:", "Latest revision"));
  await expect(preview.locator("h1")).toContainText("Latest revision");
  await expect(
    page.locator('[data-project="react-effect-dependencies"]').frameLocator("iframe").locator("h1"),
  ).toContainText("Room: general");
  await expect(
    page.locator('[data-project="react-stale-closure"]').frameLocator("iframe").locator("h1"),
  ).toContainText("Room: general");

  const siblings = ["react-effect-dependencies", "react-stale-closure"].map((id) =>
    page.locator(`[data-project="${id}"]`),
  );

  // Input actions share one browser focus, so type sequentially. Both debounced
  // builds can still overlap in the shared Worker.
  for (const [index, sibling] of siblings.entries()) {
    const input = sibling.getByRole("textbox", { name: "/App.js code" });
    await writeCode(
      input,
      (await readCode(input)).replace("Room:", `Independent session ${index + 1}`),
    );
    expect(await readCode(input)).toMatch(new RegExp(`Independent session ${index + 1}`));
  }
  for (const [index, sibling] of siblings.entries()) {
    await expect(sibling.frameLocator("iframe").locator("h1")).toContainText(
      `Independent session ${index + 1}`,
    );
    await sibling.getByRole("button", { name: "Reset source" }).click();
    await expect(sibling.frameLocator("iframe").locator("h1")).toContainText("Room: general");
  }
  await expect(preview.locator("h1")).toContainText("Latest revision");

  await writeCode(editor, original + '\nthrow new Error("Runtime error probe");');
  await expect(article.locator(".reploom-errors")).toContainText("Runtime error probe");
  await article.getByRole("button", { name: "Reset source" }).click();
  await expect(preview.locator("h1")).toContainText("Room: general");
  expect(await readCode(editor)).toBe(original);
  await expect(article.locator(".reploom-errors")).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await article.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await article.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("desktop.png") });
  expect(external).toEqual([]);
  // The deliberate runtime error is reported by the sandbox and may also surface
  // in Playwright. Everything else should be clean.
  expect(errors.filter((text) => !text.includes("Runtime error probe"))).toEqual([]);
  await testInfo.attach("network-and-browser", {
    body: JSON.stringify(
      {
        browser: await page.evaluate(() => navigator.userAgent),
        external,
        requests,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

test("reset and newer edits supersede a delayed first compiler load", async ({ page, context }) => {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === "http://127.0.0.1:4331" || ["blob:", "data:"].includes(url.protocol)
      ? route.continue()
      : route.abort();
  });
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let requested!: () => void;

  const loading = new Promise<void>((resolve) => {
    requested = resolve;
  });

  await context.route("**/*.wasm", async (route) => {
    requested();
    await gate;
    await route.continue();
  });
  await page.goto("/regression/");
  const article = page.locator('[data-project="react-effect-events"]');
  await expect(article).toHaveAttribute("data-phase", "ready");
  const editor = article.getByRole("textbox", { name: "/App.js code" });
  const original = await readCode(editor);
  await writeCode(editor, original.replace("Room:", "Discarded revision"));
  await loading;
  await article.getByRole("button", { name: "Reset source" }).click();
  await expect(article.frameLocator("iframe").locator("h1")).toContainText("Room: general");
  await writeCode(editor, original.replace("Room:", "Final revision"));
  release();
  await expect(article.frameLocator("iframe").locator("h1")).toContainText(
    "Final revision general",
  );
  expect(await readCode(editor)).toBe(original.replace("Room:", "Final revision"));
});

test("a failed initial WASM download can retry while retaining the original preview state", async ({
  page,
  context,
}) => {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === "http://127.0.0.1:4331" || ["blob:", "data:"].includes(url.protocol)
      ? route.continue()
      : route.abort();
  });
  let attempts = 0;
  let unavailable = true;
  // Preparation may try before the debounced compilation. Keep the resource
  // unavailable until the reported failure, then restore it for the next edit.
  await context.route("**/*.wasm", (route) => {
    attempts++;
    return unavailable ? route.abort() : route.continue();
  });
  await page.goto("/regression/");

  const article = page.locator('[data-project="react-effect-events"]');
  const preview = article.frameLocator("iframe");

  await expect(article).toHaveAttribute("data-phase", "ready");
  const editor = article.getByRole("textbox", { name: "/App.js code" });
  const original = await readCode(editor);
  await preview.getByRole("combobox").selectOption("travel");
  await preview.getByRole("checkbox").check();
  await writeCode(editor, original.replace("Room:", "First request"));
  await expect(article).toHaveAttribute("data-phase", "error");
  await expect(preview.locator("h1")).toContainText("Room: travel");
  unavailable = false;
  await writeCode(editor, original.replace("Room:", "Retry succeeded"));
  await expect(preview.locator("h1")).toContainText("Retry succeeded travel");
  await expect(preview.getByRole("checkbox")).toBeChecked();
  await expect(article).toHaveAttribute("data-phase", "ready");
  expect(attempts).toBeGreaterThanOrEqual(2);
});
