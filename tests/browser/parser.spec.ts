import { test, expect } from "@playwright/test";
import { computedKeys, nestedGenerics } from "../fixtures/compiler/parser-cases.mjs";

for (const project of ["react", "dom"]) {
  test(`${project} preserves state through escaped helper names and cover grammar edits`, async ({
    page,
  }) => {
    const external: string[] = [];
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "http://127.0.0.1:4331" || ["blob:", "data:"].includes(url.protocol))
        return route.continue();
      external.push(url.href);
      return route.abort();
    });
    await page.goto(`/features/?project=${project}`);
    const frame = page.frameLocator("iframe");
    const button = frame.getByRole("button");
    await expect(button).toHaveText("count 0");
    await button.click();
    const file = project === "react" ? "/Counter.tsx" : "/main.ts";

    const original = await page.evaluate(
      (file) => (window as any).session.getSnapshot().files[file].toString(),
      file,
    );

    const checks = String.raw`
const __pla\u0079ground_register = 1, __pla\u0079ground_signature = 2;
if (typeof __pla\u0079ground_module !== 'undefined') throw Error('captured context');
const coverProbe = ({x=1}, [y,...rest]=[2]) => x+y+rest.length;
if (coverProbe({}) !== 3) throw Error('cover grammar changed');
`;

    for (const suffix of [checks, checks + "\nconst anotherEdit = true;"]) {
      await page.evaluate(({ file, source }) => (window as any).session.change(file, source), {
        file,
        source: original + suffix,
      });
      await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
      await expect(button).toHaveText("count 1");
    }
    await button.click();
    await expect(button).toHaveText("count 2");
    expect(external).toEqual([]);
  });

  test(`${project} preserves input and compiler ownership through a type recursion diagnostic`, async ({
    page,
  }) => {
    const external: string[] = [];
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "http://127.0.0.1:4331" || ["blob:", "data:"].includes(url.protocol))
        return route.continue();
      external.push(url.href);
      return route.abort();
    });
    await page.goto(`/features/?project=${project}`);
    await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
    const frame = page.frames().find((candidate) => candidate.parentFrame())!;
    const button = frame.getByRole("button");
    await button.click();
    const file = project === "react" ? "/Counter.tsx" : "/main.ts";

    const original = await page.evaluate(
      (file) => (window as any).session.getSnapshot().files[file].toString(),
      file,
    );

    const compiled = original + `\nfunction probe(a,x){${computedKeys(24)}}`;
    await page.evaluate(({ file, source }) => (window as any).session.change(file, source), {
      file,
      source: compiled,
    });
    await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
    await expect(button).toHaveText("count 1");
    await page.evaluate(({ file, source }) => (window as any).session.change(file, source), {
      file,
      source: compiled + "\n" + nestedGenerics(140),
    });
    await expect(page.locator("body")).toHaveAttribute("data-phase", "error");

    const diagnostics = await page.evaluate(
      () => (window as any).session.getSnapshot().state.diagnostics,
    );

    expect(
      diagnostics.some((item) => item.file === file && item.text.includes("nesting budget (32)")),
    ).toBe(true);
    await button.click();
    await expect(button).toHaveText("count 2");
    await page.evaluate(({ file, source }) => (window as any).session.change(file, source), {
      file,
      source: compiled + "\nconst recovered=true;",
    });
    await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
    await expect(button).toHaveText("count 2");
    expect(page.frames().find((candidate) => candidate.parentFrame())).toBe(frame);
    expect(
      await page.evaluate(() => (window as any).compilerWorkers().map((worker) => worker.retired)),
    ).toEqual([false]);
    await button.click();
    await expect(button).toHaveText("count 3");
    expect(external).toEqual([]);
  });
}
