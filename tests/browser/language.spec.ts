import { test, expect } from "@playwright/test";
import { readCode, writeCode } from "./editor-helpers";

test("completed Worker syntax publishes while host idle callbacks are withheld", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let id = 0;
    window.requestIdleCallback = () => ++id;
    window.cancelIdleCallback = () => {};
  });
  await page.goto("/features/?project=react&language");
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  const editor = page.getByRole("textbox", { name: "Feature editor" });
  await expect.poll(() => editor.locator("span").count()).toBeGreaterThan(2);
  const preview = page.frameLocator("iframe");
  await preview.getByRole("button").click();
  const source = await readCode(editor);
  await writeCode(editor, source.replace("<main>", "<main data-syntax='published'>"));
  await expect(preview.locator("main")).toHaveAttribute("data-syntax", "published");
  await expect(preview.getByRole("button")).toHaveText("count 1");
  await expect.poll(() => editor.locator("span").count()).toBeGreaterThan(2);
  await page.evaluate(() => (window as any).editor.destroy());
  await expect(page.locator(".cm-editor")).toHaveCount(0);
});

test("language Worker preserves highlighting and state, resynchronizes patches, recovers and retires", async ({
  page,
}) => {
  await page.goto("/features/?project=react&language");
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  const editor = page.getByRole("textbox", { name: "Feature editor" });
  const preview = page.frameLocator("iframe");
  const button = preview.getByRole("button");
  await button.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).ownedWorkers
          .filter((w) => w.name === "reploom-language")
          .reduce((n, w) => n + w.languageReplies.length, 0),
      ),
    )
    .toBeGreaterThan(0);
  await expect(editor.locator("span").first()).toBeVisible();
  const source = await readCode(editor);
  await page.evaluate(() => {
    (window as any).faultLanguage = true;
  });
  await editor.press("ControlOrMeta+End");
  await page.keyboard.type("\n// 한글", { delay: 5 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).ownedWorkers
            .filter((w) => w.name === "reploom-language")
            .flatMap((w) => w.languageRequests)
            .filter((r) => r.source > 0).length,
      ),
    )
    .toBeGreaterThan(1);
  await expect(preview.getByRole("button")).toHaveText("count 1");

  const requests = await page.evaluate(() =>
    (window as any).ownedWorkers
      .filter((w) => w.name === "reploom-language")
      .flatMap((w) => w.languageRequests),
  );

  expect(requests.some((r) => r.base > 0 && r.source === 0 && r.edits < 20)).toBe(true);
  await page.evaluate(() =>
    (window as any).ownedWorkers
      .filter((w) => w.name === "reploom-language" && !w.retired)
      .at(-1)
      .dispatchEvent(new Event("error")),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).ownedWorkers.filter((w) => w.name === "reploom-language").length,
      ),
    )
    .toBeGreaterThan(1);
  await writeCode(editor, source.replace("<main>", "<main data-language='recovered'>"));
  await expect(preview.locator("main")).toHaveAttribute("data-language", "recovered");
  await expect(button).toHaveText("count 1");
  await page.evaluate(() => (window as any).editor.destroy());
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).ownedWorkers
          .filter((w) => w.name === "reploom-language")
          .every((w) => w.retired),
      ),
    )
    .toBe(true);
  await expect(page.locator(".cm-editor")).toHaveCount(0);
});

test("idle language analysis releases its Worker and reseeds on the next edit", async ({
  page,
}) => {
  await page.goto("/features/?project=dom&language&languageIdle=150");
  const editor = page.getByRole("textbox", { name: "Feature editor" });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).ownedWorkers.some(
          (w) => w.name === "reploom-language" && w.retired && w.languageReplies.length,
        ),
      ),
    )
    .toBe(true);
  await editor.press("ControlOrMeta+End");
  await page.keyboard.type("\n// resumed");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).ownedWorkers.filter((w) => w.name === "reploom-language").length,
      ),
    )
    .toBeGreaterThan(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).ownedWorkers.filter((w) => w.name === "reploom-language").at(-1)
            .languageReplies.length,
      ),
    )
    .toBeGreaterThan(0);

  const first = await page.evaluate(
    () =>
      (window as any).ownedWorkers.filter((w) => w.name === "reploom-language").at(-1)
        .languageRequests[0],
  );

  expect(first.base).toBe(0);
  expect(first.source).toBeGreaterThan(0);
  await expect(editor.locator("span").first()).toBeVisible();
});
