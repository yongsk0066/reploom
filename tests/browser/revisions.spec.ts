import { test, expect, type Page } from "@playwright/test";

async function open(page: Page, project: string, recycle = false) {
  const external: string[] = [];
  const requested: string[] = [];
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    requested.push(url.pathname);
    if (url.origin === "http://127.0.0.1:4331" || ["blob:", "data:"].includes(url.protocol))
      return route.continue();
    external.push(url.href);
    return route.abort();
  });
  await page.goto(`/features/?project=${project}${recycle ? "&recycle" : ""}`);
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  expect(requested.filter((url) => /\.wasm$|compiler-worker|typecheck-worker/.test(url))).toEqual(
    [],
  );
  return { preview: page.frameLocator("#preview iframe"), external, requested };
}

test("atomic files, managed snapshots and isolated tests share the DOM revision without touching live state", async ({
  page,
}) => {
  const { preview, external } = await open(page, "dom");
  await preview.getByRole("button").click({ clickCount: 2 });
  await expect(preview.getByRole("button")).toHaveText("count 2");
  const result = await page.evaluate(() => (window as any).session.check("tests"));
  expect(result.phase).toBe("passed");
  await expect(preview.getByRole("button")).toHaveText("count 2");
  expect(
    await preview.locator("body").evaluate(() => (window as any).testSideEffect),
  ).toBeUndefined();
  await page.evaluate(async () => {
    (window as any).saved = await (window as any).session.save({ state: true });
  });
  const before = await page.evaluate(() => (window as any).session.getSnapshot().revision);
  await page.evaluate(() => {
    const session = (window as any).session;
    session.transaction([
      { type: "move", from: "/label.ts", to: "/renamed.ts" },
      {
        type: "write",
        path: "/main.ts",
        source: session
          .getSnapshot()
          .files["/main.ts"].toString()
          .replace("./label.ts", "./renamed.ts"),
      },
      {
        type: "write",
        path: "/check.ts",
        source: session
          .getSnapshot()
          .files["/check.ts"].toString()
          .replace("./label.ts", "./renamed.ts"),
      },
    ]);
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  expect(await page.evaluate(() => (window as any).session.getSnapshot().revision)).toBe(
    before + 1,
  );
  await expect(preview.getByRole("button")).toHaveText("count 2");
  await preview.getByRole("button").click();
  await expect(preview.getByRole("button")).toHaveText("count 3");
  expect((await page.evaluate(() => (window as any).session.check("tests"))).phase).toBe("passed");
  await page.evaluate(() => (window as any).session.restore((window as any).saved));
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  await expect(preview.getByRole("button")).toHaveText("count 2");
  expect(
    await page.evaluate(() => Object.keys((window as any).session.getSnapshot().files)),
  ).toContain("/label.ts");
  expect(external).toEqual([]);
});

test("mixed React exports retain state and stop propagation until the ordinary export changes", async ({
  page,
}) => {
  const { preview, external } = await open(page, "react", true);
  await preview.getByRole("button").click({ clickCount: 2 });
  await expect(preview.getByRole("button")).toHaveText("count 2");
  await page.evaluate(() => {
    const session = (window as any).session;
    session.change(
      "/Counter.tsx",
      session
        .getSnapshot()
        .files["/Counter.tsx"].toString()
        .replace("count {count}", "edited {count}"),
    );
  });
  await expect(preview.getByRole("button")).toHaveText("edited 2");
  await expect(preview.locator("output")).toHaveText("1");
  await page.evaluate(() => {
    const session = (window as any).session;
    session.change(
      "/Counter.tsx",
      session
        .getSnapshot()
        .files["/Counter.tsx"].toString()
        .replace("label='counter'", "label='changed'"),
    );
  });
  await expect(preview.locator("h1")).toHaveText("changed");
  await expect(preview.locator("output")).toHaveText("2");
  await expect(preview.getByRole("button")).toHaveText("edited 2");

  const workers = await page.evaluate(() =>
    (window as any).compilerWorkers().map((worker: any) => worker.retired),
  );

  expect(workers).toEqual([true, false]);
  await page.evaluate(async () => {
    const session = (window as any).session;
    (window as any).saved = await session.save({ state: true });
  });
  await preview.getByRole("button").click();
  await expect(preview.getByRole("button")).toHaveText("edited 3");
  await page.evaluate(() => (window as any).session.restore((window as any).saved));
  await expect(preview.getByRole("button")).toHaveText("edited 2");
  expect(external).toEqual([]);
});

test("optional tsrs type checking loads on demand, reports UTF-16 locations, reuses its Worker and cancels active checks", async ({
  page,
}) => {
  const { preview, requested, external } = await open(page, "dom");
  const first = await page.evaluate(() => (window as any).session.check("types"));
  expect(first.diagnostics).toEqual([]);
  expect(requested.some((url) => /tsrs.*\.wasm$/.test(url))).toBe(true);
  await page.evaluate(() =>
    (window as any).session.change(
      "/label.ts",
      "const emoji = '😀';\nexport const label: number = 'count';",
    ),
  );
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  const failed = await page.evaluate(() => (window as any).session.check("types"));
  expect(failed.phase).toBe("failed");
  const diagnostic = failed.diagnostics.find((item: any) => item.file === "/label.ts");
  expect(diagnostic.line).toBe(2);
  expect(await page.evaluate((item) => (window as any).session.reveal(item), diagnostic)).toBe(
    true,
  );
  await expect(page.getByRole("textbox", { name: "Feature editor" })).toBeFocused();
  expect(await page.evaluate(() => (window as any).session.getSnapshot().active)).toBe("/label.ts");
  expect(
    await page.evaluate(
      () =>
        (window as any).ownedWorkers
          .filter((worker: any) => worker.name === "reploom-typecheck")
          .filter((worker: any) => !worker.retired).length,
    ),
  ).toBe(1);
  await expect(preview.getByRole("button")).toHaveText("count 0");
  expect((await page.evaluate(() => (window as any).session.check("types"))).diagnostics).toEqual(
    failed.diagnostics,
  );
  await page.evaluate(() => {
    const session = (window as any).session;
    session.change(
      "/label.ts",
      session.getSnapshot().files["/label.ts"].toString() + "\n// next revision",
    );
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  await page.evaluate(() => {
    (window as any).holdTypes = true;
    (window as any).pendingTypes = (window as any).session.check("types").then(
      () => "completed",
      (error: Error) => error.name,
    );
  });
  await page.waitForFunction(() => (window as any).heldTypeChecks === 1);
  await page.evaluate(() =>
    (window as any).session.change("/label.ts", "export const label='count';"),
  );
  expect(await page.evaluate(() => (window as any).pendingTypes)).toBe("AbortError");
  expect(await page.evaluate(() => (window as any).session.getSnapshot().checks)).toBeUndefined();
  expect(external).toEqual([]);
});

test("a lost source base automatically resynchronizes both direct and inline delivery", async ({
  page,
}) => {
  const { preview } = await open(page, "dom");
  await preview.getByRole("button").click();
  await page.evaluate(() =>
    (window as any).session.change("/label.ts", "export const label='first';"),
  );
  await expect(preview.getByRole("button")).toHaveText("first 1");
  await page.evaluate(() => {
    (window as any).faultSource = true;
    (window as any).session.change("/label.ts", "export const label='resynced';");
  });
  await expect(preview.getByRole("button")).toHaveText("resynced 1");
  expect(await page.evaluate(() => (window as any).compilerWorkers().length)).toBe(1);
  await page.evaluate(async () => {
    const w = window as any;
    w.inline = new w.ProjectSession("dom", w.platform.services);
    await w.inline.start();
    w.inline.change("/label.ts", "export const label='inline';");
  });
  await page.waitForFunction(() => (window as any).inline.getSnapshot().snapshot?.revision === 1);
  await page.evaluate(() => {
    (window as any).faultSource = true;
    (window as any).inline.change("/label.ts", "export const label='restored inline';");
  });
  await page.waitForFunction(() => (window as any).inline.getSnapshot().snapshot?.revision === 2);
  expect(
    await page.evaluate(
      () => (window as any).inline.getSnapshot().snapshot.program.modules["/label.ts"].code,
    ),
  ).toContain("restored inline");
  await expect(preview.getByRole("button")).toHaveText("resynced 1");
  expect(await page.evaluate(() => (window as any).compilerWorkers().length)).toBe(1);
  await page.evaluate(() => (window as any).inline.dispose());
});

test("the bundled UI saves and restores explicit state, runs checks and manages files", async ({
  page,
}) => {
  await page.goto("/#dom-todos");
  const article = page.locator('[data-project="dom-todos"]');
  await expect(article).toHaveAttribute("data-phase", "ready");
  const preview = article.frameLocator("iframe");
  await preview.getByRole("textbox").fill("Saved task");
  await preview.getByRole("button", { name: "Add", exact: true }).click();
  await article.getByText("Project tools", { exact: true }).click();
  await article.getByLabel("Include explicitly registered state").check();
  const downloaded = page.waitForEvent("download");
  await article.getByRole("button", { name: "Save project", exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe("dom-todos.reploom.json");
  await preview.getByRole("textbox").fill("Transient task");
  await preview.getByRole("button", { name: "Add", exact: true }).click();
  await expect(preview.locator("li")).toHaveCount(3);
  await article.getByRole("button", { name: "Restore saved project" }).click();
  await expect(preview.locator("li")).toHaveCount(2);
  await expect(preview.locator("ul")).toContainText("Saved task");
  await article.getByRole("button", { name: "Run isolated tests" }).click();
  await expect(article.locator(".reploom-tools output")).toHaveText("passed");
  await expect(preview.locator("li")).toHaveCount(2);
  await article.getByLabel("Destination path").fill("/extra.ts");
  await article.getByRole("button", { name: "Add file", exact: true }).click();
  await expect(article.getByLabel("File", { exact: true })).toHaveValue("/extra.ts");
  await article.getByRole("button", { name: "Remove selected file" }).click();
  await expect(article.getByLabel("File", { exact: true })).toHaveValue("/main.ts");
});

test("runtime source maps navigate the current revision and reject an obsolete location", async ({
  page,
}) => {
  const { preview } = await open(page, "dom");
  await page.evaluate(() =>
    (window as any).session.change(
      "/main.ts",
      "export function mount(container){\n const button=document.createElement('button');\n button.textContent='fail';\n button.onclick=()=>{ throw new Error('located failure') };\n container.replaceChildren(button);\n}",
    ),
  );
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  await preview.getByRole("button").click();
  await expect(page.locator("body")).toHaveAttribute("data-phase", "error");

  const diagnostic = await page.evaluate(
    () => (window as any).session.getSnapshot().state.diagnostics[0],
  );

  expect(diagnostic.file).toBe("/main.ts");
  expect(diagnostic.line).toBe(4);
  expect(await page.evaluate((item) => (window as any).session.reveal(item), diagnostic)).toBe(
    true,
  );
  await page.evaluate(() => {
    const session = (window as any).session;
    session.change("/main.ts", "\n" + session.getSnapshot().files["/main.ts"].toString());
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  expect(await page.evaluate((item) => (window as any).session.reveal(item), diagnostic)).toBe(
    false,
  );
  await preview.getByRole("button").click();
  await expect(page.locator("body")).toHaveAttribute("data-phase", "error");
  expect(
    await page.evaluate(() => (window as any).session.getSnapshot().state.diagnostics[0].line),
  ).toBe(5);
});

test("compute managed state and declared tests work through the nested Worker inspection boundary", async ({
  page,
}) => {
  const { preview, external } = await open(page, "compute");
  const saved = await page.evaluate(() => (window as any).session.save({ state: true }));
  expect(saved.state["/main.ts"].count).toBe(7);
  const tests = await page.evaluate(() => (window as any).session.check("tests"));
  expect(tests.phase).toBe("passed");
  saved.state["/main.ts"].count = 12;
  await page.evaluate((archive) => (window as any).session.restore(archive), saved);
  await expect(preview.getByLabel("Compute output")).toContainText('"count": 12');
  expect(external).toEqual([]);
});
