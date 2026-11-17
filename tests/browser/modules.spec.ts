import { test, expect } from "@playwright/test";
import { writeCode } from "./editor-helpers";

test("module refresh preserves child/parent state and isolates evaluation, effects and resource lifetime", async ({
  page,
  context,
}, testInfo) => {
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

  const edit = async (path: string, code: string) => {
    await article.getByRole("tab", { name: path, exact: true }).click();
    await writeCode(article.getByRole("textbox", { name: `${path} code` }), code);
  };

  const child = `import { useState, useEffect } from 'react';
globalThis.__childLoads = (globalThis.__childLoads || 0) + 1;
globalThis.__resources = (globalThis.__resources || 0) + 1;
import.meta.hot.dispose(() => { globalThis.__resources--; });
export function Child() {
  const [count, setCount] = useState(0);
  useEffect(() => { globalThis.__childEffects = (globalThis.__childEffects || 0) + 1; }, []);
  return <button onClick={() => setCount(n => n + 1)}>child A {count}</button>;
}`;

  const utility = `globalThis.__utilityLoads = (globalThis.__utilityLoads || 0) + 1;
export const token = {};
export const label = 'utility A';`;

  const app = `import { useState, useEffect } from 'react';
import { Child } from './connection.js'; import { token, label } from './notifications.js';
globalThis.__appLoads = (globalThis.__appLoads || 0) + 1;
globalThis.__token = token;
export default function App() {
  const [count, setCount] = useState(0);
  useEffect(() => { globalThis.__parentEffects = (globalThis.__parentEffects || 0) + 1; }, []);
  return <><button onClick={() => setCount(n => n + 1)}>parent {count}</button><Child/><p>{label}</p></>;
}`;

  await edit("/connection.js", child);
  await edit("/notifications.js", utility);
  await edit("/App.js", app);
  await expect(preview.getByRole("button", { name: "parent 0", exact: true })).toBeVisible();
  await expect(article).toHaveAttribute("data-phase", "ready");
  await preview.getByRole("button", { name: /^parent/ }).click({ clickCount: 2 });
  await preview.getByRole("button", { name: /^child/ }).click({ clickCount: 3 });
  await expect(preview.getByRole("button", { name: /^parent/ })).toHaveText("parent 2");
  await expect(preview.getByRole("button", { name: /^child/ })).toHaveText("child A 3");

  const inspect = () =>
    preview.locator("body").evaluate(() => {
      const w = window as any;
      return {
        app: w.__appLoads,
        child: w.__childLoads,
        utility: w.__utilityLoads,
        parentEffects: w.__parentEffects,
        childEffects: w.__childEffects,
        resources: w.__resources,
      };
    });

  const before = await inspect();
  await preview.locator("body").evaluate(() => {
    (window as any).__previousToken = (window as any).__token;
  });
  await edit("/connection.js", child.replace("child A", "child B"));
  await expect(preview.getByRole("button", { name: /^child/ })).toHaveText("child B 3");
  await expect(article).toHaveAttribute("data-phase", "ready");
  const childEdit = await inspect();
  expect(childEdit.app).toBe(before.app);
  expect(childEdit.utility).toBe(before.utility);
  expect(childEdit.child).toBe(before.child + 1);
  expect(childEdit.parentEffects).toBe(before.parentEffects);
  expect(childEdit.childEffects).toBeGreaterThan(before.childEffects);
  expect(childEdit.resources).toBe(1);
  expect(
    await preview
      .locator("body")
      .evaluate(() => (window as any).__token === (window as any).__previousToken),
  ).toBe(true);
  await preview.getByRole("button", { name: /^parent/ }).click();
  await expect(preview.getByRole("button", { name: /^parent/ })).toHaveText("parent 3");
  expect((await inspect()).parentEffects).toBe(before.parentEffects);

  await edit("/styles.css", "body { background: rgb(230, 240, 230); }");
  await expect(preview.locator("body")).toHaveCSS("background-color", "rgb(230, 240, 230)");
  expect(await inspect()).toEqual(childEdit);

  await edit("/notifications.js", utility.replace("utility A", "utility B"));
  await expect(preview.locator("p")).toHaveText("utility B");
  await expect(preview.getByRole("button", { name: /^parent/ })).toHaveText("parent 3");
  await expect(preview.getByRole("button", { name: /^child/ })).toHaveText("child B 3");
  const utilityEdit = await inspect();
  expect(utilityEdit.app).toBe(childEdit.app + 1);
  expect(utilityEdit.utility).toBe(childEdit.utility + 1);
  expect(utilityEdit.child).toBe(childEdit.child);
  expect(utilityEdit.childEffects).toBe(childEdit.childEffects);
  expect(utilityEdit.parentEffects).toBeGreaterThan(childEdit.parentEffects);
  expect(utilityEdit.resources).toBe(1);
  expect(external).toEqual([]);
  await testInfo.attach("module-lifetimes", {
    body: JSON.stringify({ before, childEdit, utilityEdit, external }, null, 2),
    contentType: "application/json",
  });
});
