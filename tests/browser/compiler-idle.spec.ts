import { workersNamed } from "./worker-helpers";
import { test, expect } from "@playwright/test";
import { readCode, writeCode } from "./editor-helpers";

test("one idle compiler retires and reseeds React, DOM and useEffectEvent without retiring previews", async ({
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

  const projects = [
    { id: "react-effect-events", path: "/App.js", from: "Room:", to: "idle resume" },
    {
      id: "react-counter",
      path: "/src/Dashboard.tsx",
      from: "{settings.title}",
      to: "resumed {settings.title}",
    },
    {
      id: "dom-counter",
      path: "/main.ts",
      from: "DOM counter",
      to: "resumed DOM",
    },
  ];

  const sources: string[] = [];
  for (const project of projects) {
    const article = page.locator(`[data-project="${project.id}"]`);
    await expect(article).toHaveAttribute("data-phase", "ready");
    const preview = article.frameLocator("iframe");
    if (project.id === "react-effect-events") {
      await preview.locator("select").selectOption("travel");
      await preview.locator('input[type="checkbox"]').check();
    } else {
      await preview.getByRole("button").click({ clickCount: 2 });
      await preview.getByRole("textbox").fill("idle memory");
    }
    await preview.locator("body").evaluate(() => {
      (window as any).__idleFrame = true;
      (window as any).__idleInput = document.querySelector("input");
    });

    const editor = article.getByRole("textbox", {
      name: `${project.path} code`,
    });

    const source = (await readCode(editor)) + "\n// warm before idle\n";
    sources.push(source);
    await writeCode(editor, source);
    await expect(article).toHaveAttribute("data-phase", "ready");
  }
  const compilers = () => workersNamed(page, "reploom-compiler");
  await expect.poll(async () => (await compilers()).length).toBe(1);
  await (await compilers())[0].waitForEvent("close", { timeout: 40_000 });
  expect(await compilers()).toHaveLength(0);
  for (const [index, project] of projects.entries()) {
    const article = page.locator(`[data-project="${project.id}"]`);
    const preview = article.frameLocator("iframe");
    await writeCode(
      article.getByRole("textbox", { name: `${project.path} code` }),
      sources[index].replace(project.from, project.to),
    );
    await expect(article).toHaveAttribute("data-phase", "ready");
    await expect(preview.locator("h1")).toContainText("resum");
    expect(await preview.locator("body").evaluate(() => (window as any).__idleFrame)).toBe(true);
    if (project.id === "react-effect-events") {
      await expect(preview.locator("select")).toHaveValue("travel");
      await expect(preview.locator('input[type="checkbox"]')).toBeChecked();
    } else {
      await expect(preview.getByRole("button")).toContainText("count 2");
      await expect(preview.getByRole("textbox")).toHaveValue("idle memory");
    }
    if (project.id !== "dom-counter")
      expect(
        await preview
          .locator("body")
          .evaluate(() => (window as any).__idleInput === document.querySelector("input")),
      ).toBe(true);
  }
  expect(await compilers()).toHaveLength(1);
  expect(external).toEqual([]);
});
