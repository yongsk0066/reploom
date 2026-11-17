import { readCode, writeCode } from "./editor-helpers";
import { test, expect, type Page } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === "http://127.0.0.1:4331" || ["blob:", "data:"].includes(url.protocol)
      ? route.continue()
      : route.abort();
  });
});

async function open(page: Page) {
  await page.goto("/regression/");
  const article = page.locator('[data-project="react-effect-events"]');
  await expect(article).toHaveAttribute("data-phase", "ready");
  await expect(article.locator(".cm-content")).toBeVisible();
  return {
    article,
    preview: article.frameLocator("iframe"),
    editor: article.getByRole("textbox", { name: "/App.js code" }),
  };
}

const counter = `import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
export default function App() {
  const [count, setCount] = useState(0);
  const marker = useRef(Math.random());
  const memo = useMemo(() => 'memo A', []);
  const callback = useCallback(() => 'callback A', []);
  useEffect(() => {
    globalThis.__effectRuns = (globalThis.__effectRuns || 0) + 1;
    globalThis.__activeEffects = (globalThis.__activeEffects || 0) + 1;
    return () => { globalThis.__activeEffects--; };
  }, []);
  return <><h1>Counter A</h1>
    <button onClick={() => setCount(n => n + 1)}>count {count}</button>
    <output>{marker.current}</output><input aria-label="Note" defaultValue="" />
    <p>{memo} / {callback()}</p></>;
}`;

test("Fast Refresh preserves React state, refs and DOM; CSS avoids effects; incompatible hooks remount", async ({
  page,
}) => {
  const { article, preview, editor } = await open(page);
  await writeCode(editor, counter);
  await expect(preview.locator("h1")).toHaveText("Counter A");
  await preview.getByRole("button").click({ clickCount: 2 });
  await expect(preview.getByRole("button")).toHaveText("count 2");
  await preview.getByRole("textbox", { name: "Note" }).fill("Retained DOM input");
  const ref = await preview.locator("output").textContent();

  const runs = await preview.locator("body").evaluate(() => {
    const w = window as any;
    w.__originalInput = document.querySelector("input");
    w.__frameMarker = "same document";
    return w.__effectRuns;
  });

  const edited = counter
    .replace("Counter A", "Counter B")
    .replace("n + 1", "n + 2")
    .replace("memo A", "memo B")
    .replace("callback A", "callback B");

  await writeCode(editor, edited);
  await expect(preview.locator("h1")).toHaveText("Counter B");
  await expect(preview.getByRole("button")).toHaveText("count 2");
  await expect(preview.locator("p")).toHaveText("memo B / callback B");
  await expect(preview.locator("output")).toHaveText(ref!);
  await expect(preview.getByRole("textbox")).toHaveValue("Retained DOM input");
  expect(
    await preview
      .locator("body")
      .evaluate(() => (window as any).__originalInput === document.querySelector("input")),
  ).toBe(true);
  expect(await preview.locator("body").evaluate(() => (window as any).__frameMarker)).toBe(
    "same document",
  );
  await expect
    .poll(() => preview.locator("body").evaluate(() => (window as any).__effectRuns))
    .toBeGreaterThan(runs);
  expect(await preview.locator("body").evaluate(() => (window as any).__activeEffects)).toBe(1);
  const afterRefresh = await preview.locator("body").evaluate(() => (window as any).__effectRuns);
  await preview.getByRole("button").click();
  await expect(preview.getByRole("button")).toHaveText("count 4");
  expect(await preview.locator("body").evaluate(() => (window as any).__effectRuns)).toBe(
    afterRefresh,
  );

  const beforeCSS = await preview.locator("body").evaluate(() => (window as any).__effectRuns);
  await article.getByRole("tab", { name: "/styles.css", exact: true }).click();
  const css = article.getByRole("textbox", { name: "/styles.css code" });
  await writeCode(css, (await readCode(css)) + "\nbody { background: rgb(210, 230, 240); }");
  await expect(preview.locator("body")).toHaveCSS("background-color", "rgb(210, 230, 240)");
  await expect(article.locator(".reploom-status")).toContainText("Styles updated");
  expect(await preview.locator("body").evaluate(() => (window as any).__effectRuns)).toBe(
    beforeCSS,
  );
  await expect(preview.getByRole("button")).toHaveText("count 4");
  await expect(preview.locator("output")).toHaveText(ref!);

  await article.getByRole("tab", { name: "/App.js", exact: true }).click();

  const extraHook = edited.replace(
    "const marker =",
    "const [extra] = useState(1);\n  const marker =",
  );

  await writeCode(editor, extraHook);
  await expect(preview.getByRole("button")).toHaveText("count 0");
  await expect(article.locator(".reploom-status")).toContainText("Component remounted");
  expect(await preview.locator("body").evaluate(() => (window as any).__frameMarker)).toBe(
    "same document",
  );
  await preview.getByRole("button").click();
  await expect(preview.getByRole("button")).toHaveText("count 2");
  await writeCode(editor, edited); // Removing a hook also remounts safely.
  await expect(preview.getByRole("button")).toHaveText("count 0");
  await preview.getByRole("button").click();
  await writeCode(editor, edited + "\n// @refresh reset");
  await expect(preview.getByRole("button")).toHaveText("count 0");
  await preview.getByRole("button").click();
  await article.getByRole("button", { name: "Run again" }).click();
  await expect(preview.getByRole("button")).toHaveText("count 0");
  expect(
    await preview.locator("body").evaluate(() => (window as any).__frameMarker),
  ).toBeUndefined();
  expect(await readCode(editor)).toBe(edited + "\n// @refresh reset");
});

test("custom hook signatures and module/render errors recover without publishing a partial update", async ({
  page,
}) => {
  const { article, preview, editor } = await open(page);

  const hook = `import { useState } from 'react';
export function useCounter() { const [count, setCount] = useState(0); return [count, setCount]; }`;

  await article.getByRole("tab", { name: "/connection.js", exact: true }).click();
  const chat = article.getByRole("textbox", { name: "/connection.js code" });
  await writeCode(chat, hook);
  await article.getByRole("tab", { name: "/App.js", exact: true }).click();

  const app = `import { useCounter } from './connection.js';
export default function App() { const [count, setCount] = useCounter(); return <button onClick={() => setCount(n => n + 1)}>custom {count}</button>; }`;

  await writeCode(editor, app);
  await expect(preview.getByRole("button")).toHaveText("custom 0");
  await preview.getByRole("button").click();
  await expect(preview.getByRole("button")).toHaveText("custom 1");

  await writeCode(editor, app.replace("custom", "updated"));
  await expect(preview.getByRole("button")).toHaveText("updated 1");
  await article.getByRole("tab", { name: "/connection.js", exact: true }).click();
  await writeCode(chat, hook.replace("const [count", "const [extra] = useState(2); const [count"));
  await expect(preview.getByRole("button")).toHaveText("updated 0");
  await preview.getByRole("button").click();
  await expect(preview.getByRole("button")).toHaveText("updated 1");

  await article.getByRole("tab", { name: "/App.js", exact: true }).click();
  const updated = app.replace("custom", "updated");
  await writeCode(editor, updated + '\nthrow new Error("module failed");');
  await expect(article.locator(".reploom-errors")).toContainText("module failed");
  await expect(preview.getByRole("button")).toHaveText("updated 1");
  await writeCode(editor, updated.replace("updated", "recovered"));
  await expect(preview.getByRole("button")).toHaveText("recovered 1");
  await expect(article.locator(".reploom-errors")).toBeHidden();

  await writeCode(
    editor,
    updated.replace("return <button", 'throw new Error("render failed"); return <button'),
  );
  await expect(article.locator(".reploom-errors")).toContainText("render failed");
  await writeCode(editor, updated.replace("updated", "render recovered"));
  await expect(preview.getByRole("button")).toHaveText("render recovered 0");
  await expect(article.locator(".reploom-errors")).toBeHidden();
  await expect(article).toHaveAttribute("data-phase", "ready");

  // Class components are a deliberate remount fallback, not state-preserving.
  const classApp = `import React from 'react'; export default class App extends React.Component {
    state = { count: 0 };
    render() { return <button onClick={() => this.setState({count: this.state.count + 1})}>class A {this.state.count}</button>; }
  }`;

  await writeCode(editor, classApp);
  await expect(preview.getByRole("button")).toHaveText("class A 0");
  await preview.getByRole("button").click();
  await expect(preview.getByRole("button")).toHaveText("class A 1");
  await writeCode(editor, classApp.replace(">class A ", ">class B "));
  await expect(preview.getByRole("button")).toHaveText("class B 0");
});

test("repeated hook edits release obsolete App functions while preserving state", async ({
  page,
}, testInfo) => {
  const { article, preview, editor } = await open(page);

  const source = (revision: number) => `import {useState} from 'react';
globalThis.__appVersions ??= [];
export default function App(){const [n,set]=useState(0); return <><h1>revision ${revision}</h1><button onClick={()=>set(n+1)}>count {n}</button></>;}
globalThis.__appVersions.push(new WeakRef(App));`;

  await writeCode(editor, source(0));
  await expect(preview.locator("h1")).toHaveText("revision 0");
  await preview.getByRole("button").click();
  for (let revision = 1; revision <= 32; revision++) {
    await writeCode(editor, source(revision));
    await expect(preview.locator("h1")).toHaveText(`revision ${revision}`);
    await expect(article).toHaveAttribute("data-phase", "ready");
  }
  await expect(preview.getByRole("button")).toHaveText("count 1");
  // React may keep the initial element type and the two Fiber versions. Older
  // evaluations must be collectible; neither undo history nor code cache needs
  // to own their live component closures. The fixture stores only WeakRefs.
  let live = 33;
  await expect
    .poll(async () => {
      await page.requestGC();
      live = await preview
        .locator("body")
        .evaluate(
          () =>
            (globalThis as any).__appVersions.filter((ref: WeakRef<object>) => ref.deref()).length,
        );
      return live;
    })
    .toBeLessThanOrEqual(4);
  await testInfo.attach("retention", {
    body: JSON.stringify({ revisions: 33, liveApps: live, state: "count 1" }),
    contentType: "application/json",
  });
});
