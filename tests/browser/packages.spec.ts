import { test, expect } from "@playwright/test";
import { workersNamed } from "./worker-helpers";

test("packed editor resolves its language Worker outside workspace patch configuration", async ({
  page,
}) => {
  await page.goto("/headless/editor/");
  const inspect = () => page.evaluate(() => (window as any).inspectEditor());
  await expect.poll(async () => (await inspect()).workers[0]?.replies).toBe(1);
  const input = page.locator(".cm-content");
  await expect(input.locator(".cm-line span").first()).toBeVisible();
  await input.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" // packed");
  await expect.poll(async () => (await inspect()).source).toContain("// packed");
  await expect.poll(async () => (await inspect()).workers[0]?.replies).toBeGreaterThan(1);
  await page.evaluate(() => (window as any).disposeEditor());
  await expect(page.locator(".cm-editor")).toHaveCount(0);
  expect((await inspect()).workers.every((worker: any) => worker.terminated)).toBe(true);
});

test("packed headless consumers use independent asset roots and dispose one platform without affecting the other", async ({
  page,
  context,
}) => {
  const external: string[] = [];
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(String(error)));
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4331" || ["blob:", "data:"].includes(url.protocol))
      return route.continue();
    external.push(url.href);
    return route.abort();
  });
  await page.goto("/headless/");

  const one = page.locator("#one").frameLocator("iframe");
  const two = page.locator("#two").frameLocator("iframe");

  await expect(one.getByRole("button")).toHaveText("Count 0");
  await expect(two.getByRole("button")).toHaveText("Count 0");
  await one.getByRole("button").click();
  await two.getByRole("button").click({ clickCount: 2 });
  await page.locator("#edit-one").click();
  await expect(one.locator("h2")).toHaveText("Updated one");
  await expect(one.getByRole("button")).toHaveText("Count 1");
  await page.locator("#edit-two").click();
  await expect(two.locator("h2")).toHaveText("Updated two");
  await expect(two.getByRole("button")).toHaveText("Count 2");
  expect(await workersNamed(page, "reploom-compiler")).toHaveLength(2);
  await page.locator("#dispose-one").click();
  await expect(page.locator("#one")).toHaveAttribute("data-disposed", "true");
  await expect(page.locator("#one iframe")).toHaveCount(0);
  expect(await workersNamed(page, "reploom-compiler")).toHaveLength(1);
  await two.getByRole("button").click();
  await expect(two.getByRole("button")).toHaveText("Count 3");
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});
