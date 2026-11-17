import { test, expect } from "@playwright/test";

test("explicit compiler preparation shares its task and preserves the displayed revision", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/features/?project=react");
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  expect(requests.filter((url) => /\.wasm$|compiler-worker/.test(url))).toEqual([]);
  const button = page.frameLocator("iframe").getByRole("button");
  await button.click();

  const same = await page.evaluate(async () => {
    const session = (window as any).session;
    const before = session.getSnapshot();
    const first = session.prepare();
    const second = session.prepare();
    await Promise.all([first, second]);
    return { task: first === second, snapshot: before === session.getSnapshot() };
  });

  expect(same).toEqual({ task: true, snapshot: true });
  expect(requests.filter((url) => url.endsWith(".wasm"))).toHaveLength(1);
  await page.evaluate(() => {
    const session = (window as any).session;
    session.change(
      "/Counter.tsx",
      session.getSnapshot().files["/Counter.tsx"].toString() + "\nexport const prepared=true;",
    );
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  await expect(button).toHaveText("count 1");
  await button.click();
  await expect(button).toHaveText("count 2");
  expect(requests.filter((url) => url.endsWith(".wasm"))).toHaveLength(1);
});

test("prepared compiler identity is checked before WASM loading", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route("**/features/assets/manifest.json", async (route) => {
    const response = await route.fetch();
    const manifest = await response.json();
    manifest.compiler.sha256 = "0".repeat(64);
    await route.fulfill({ response, json: manifest });
  });
  await page.goto("/features/?project=react");
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  const button = page.frameLocator("iframe").getByRole("button");
  await button.click();
  await page.evaluate(() => {
    const session = (window as any).session;
    session.change(
      "/Counter.tsx",
      session.getSnapshot().files["/Counter.tsx"].toString() + "\n// edit",
    );
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "error");
  expect(
    await page.evaluate(() => JSON.stringify((window as any).session.getSnapshot().state)),
  ).toContain("Prepared compiler identity mismatch");
  await expect(button).toHaveText("count 1");
  expect(requests.filter((url) => /\.wasm$|oxc-loader/.test(url))).toEqual([]);
});

test("embedded compiler rejects altered WASM bytes and retries without a loader request", async ({
  page,
}) => {
  const requests: string[] = [];
  let corrupt = true;
  page.on("request", (request) => requests.push(request.url()));
  await page.route("**/*.wasm", async (route) => {
    if (!corrupt) return route.continue();
    const response = await route.fetch();
    // An empty custom section keeps the module valid while changing its digest.
    const bytes = Buffer.concat([await response.body(), Buffer.from([0, 1, 0])]);
    await route.fulfill({ response, body: bytes });
  });
  await page.goto("/features/?project=react");
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  const button = page.frameLocator("iframe").getByRole("button");
  await button.click();

  const edit = () =>
    page.evaluate(() => {
      const session = (window as any).session;
      session.change(
        "/Counter.tsx",
        session.getSnapshot().files["/Counter.tsx"].toString() + "\n// edit",
      );
    });

  await edit();
  await expect(page.locator("body")).toHaveAttribute("data-phase", "error");
  expect(
    await page.evaluate(() => JSON.stringify((window as any).session.getSnapshot().state)),
  ).toContain("Oxc WASM integrity mismatch");
  await expect(button).toHaveText("count 1");
  corrupt = false;
  await edit();
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  await expect(button).toHaveText("count 1");
  await button.click();
  await expect(button).toHaveText("count 2");
  expect(requests.filter((url) => /oxc-loader/.test(url))).toEqual([]);
});
