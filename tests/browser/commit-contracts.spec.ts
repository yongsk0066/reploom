import { test, expect } from "@playwright/test";

async function open(page, project = "dom", extra = "") {
  await page.goto(`/features/?project=${project}${extra}`);
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  return page.frames().find((frame) => frame.parentFrame())!;
}

for (const project of ["dom", "react"]) {
  test(`${project} preserves input during async replacement and saves the displayed state`, async ({
    page,
  }) => {
    const frame = await open(page, project);
    const button = frame.getByRole("button");
    await button.click();
    const file = project === "dom" ? "/main.ts" : "/Counter.tsx";
    await page.evaluate((file) => {
      const session = (window as any).session;
      session.change(
        file,
        session.getSnapshot().files[file].toString() +
          "\nawait new Promise(resolve=>{globalThis.__release=resolve;globalThis.__staged=true});",
      );
    }, file);
    await frame.waitForFunction(() => (globalThis as any).__staged);
    await button.click();
    await expect(button).toHaveText("count 2");
    await frame.evaluate(() => (globalThis as any).__release());
    await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
    await expect(button).toHaveText("count 2");
    const archive = await page.evaluate(() => (window as any).session.save({ state: true }));
    expect(archive.state[file].count).toBe(2);
    await button.click();
    await expect(button).toHaveText("count 3");
    await page.evaluate((archive) => (window as any).session.restore(archive), archive);
    await expect(page.locator("body")).toHaveAttribute("data-phase", "starting");
    // The restored source deliberately waits, so release the new realm before checking its state.
    await expect
      .poll(() => page.frames().some((candidate) => candidate.parentFrame() && candidate !== frame))
      .toBe(true);

    const restored = page
      .frames()
      .find((candidate) => candidate.parentFrame() && candidate !== frame)!;

    await restored.waitForFunction(() => (globalThis as any).__staged);
    await restored.evaluate(() => (globalThis as any).__release());
    await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
    await expect(restored.getByRole("button")).toHaveText("count 2");
  });
}

test("a state conflict rejects staged writes and preserves committed input across required realm recovery", async ({
  page,
}) => {
  const frame = await open(page);
  await page.evaluate(() => {
    const session = (window as any).session;
    (window as any).baseSource =
      session.getSnapshot().files["/main.ts"].toString() + "\nimport.meta.hot.dispose(()=>{});";
    session.change("/main.ts", (window as any).baseSource);
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  await frame.getByRole("button").click();
  await page.evaluate(() =>
    (window as any).session.change(
      "/main.ts",
      (window as any).baseSource +
        "\ncount.value=100; await new Promise(resolve=>{globalThis.__release=resolve;globalThis.__staged=true});",
    ),
  );
  await frame.waitForFunction(() => (globalThis as any).__staged);
  await frame.getByRole("button").click();
  await frame.evaluate(() => (globalThis as any).__release());
  await expect(page.locator("body")).toHaveAttribute("data-phase", "error");
  await expect(frame.getByRole("button")).toHaveText("count 2");
  expect(
    await page.evaluate(() =>
      (window as any).session
        .getSnapshot()
        .state.diagnostics.map((error) => error.text)
        .join("\n"),
    ),
  ).toContain("Managed state changed");
  await page.evaluate(() =>
    (window as any).session.change(
      "/main.ts",
      (window as any).baseSource + "\nexport const recovered=true;",
    ),
  );
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  const recovered = page.frames().find((frame) => frame.parentFrame())!;
  expect(recovered).not.toBe(frame);
  await expect(recovered.getByRole("button")).toHaveText("count 2");
  await recovered.getByRole("button").click();
  await expect(recovered.getByRole("button")).toHaveText("count 3");
});

test("a selective named binding updates without reevaluating its importer and still runs dependency side effects", async ({
  page,
}) => {
  const frame = await open(page);
  await page.evaluate(() => {
    const session = (window as any).session;
    session.transaction([
      {
        type: "write",
        path: "/main.ts",
        source:
          "import {read} from './reader.ts'; export function mount(root,{signal}){const button=document.createElement('button'); const render=()=>button.textContent=read();render();button.addEventListener('click',render,{signal});root.replaceChildren(button);}",
      },
      {
        type: "write",
        path: "/reader.ts",
        source:
          "import {label} from './label.ts';globalThis.readers=(globalThis.readers||0)+1;export const read=()=>label;",
      },
      {
        type: "write",
        path: "/label.ts",
        source:
          "globalThis.labels=(globalThis.labels||0)+1;export const label='before';import.meta.hot.acceptExports(['label']);",
      },
    ]);
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  const button = frame.getByRole("button");
  await expect(button).toHaveText("before");
  await page.evaluate(() =>
    (window as any).session.change(
      "/label.ts",
      "globalThis.labels++;export const label='after';import.meta.hot.acceptExports(['label']);",
    ),
  );
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  await button.click();
  await expect(button).toHaveText("after");
  expect(
    await frame.evaluate(() => [(globalThis as any).readers, (globalThis as any).labels]),
  ).toEqual([1, 2]);
});

test("cancelling a stalled type-check download releases its consumer and permits retry", async ({
  page,
}) => {
  let blocked = false;
  await page.route(/tsrs[^/]*\.wasm$/, async (route) => {
    if (!blocked) {
      blocked = true;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.abort().catch(() => {});
    } else await route.continue();
  });
  await open(page);
  await page.evaluate(() => {
    (window as any).pending = (window as any).session.check("types").catch((error) => error.name);
  });
  await expect.poll(() => blocked).toBe(true);
  await page.evaluate(() =>
    (window as any).session.change("/label.ts", "export const label: string='changed';"),
  );
  expect(await page.evaluate(() => (window as any).pending)).toBe("AbortError");
  const next = await page.evaluate(() => (window as any).session.check("types"));
  expect(next.diagnostics).toEqual([]);
});

test("a compute evaluation failure restores committed managed state into the replacement Worker", async ({
  page,
}) => {
  await open(page, "compute");
  const frame = page.frames().find((frame) => frame.parentFrame())!;

  const source =
    "const cell=import.meta.state('value',10); export function run(){return ++cell.value}";

  await page.evaluate((source) => (window as any).session.change("/main.ts", source), source);
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  await expect(frame.getByLabel("Compute output")).toHaveText("11");
  await page.evaluate(
    (source) =>
      (window as any).session.change(
        "/main.ts",
        source + "; cell.value=999; throw Error('reject candidate');",
      ),
    source,
  );
  await expect(page.locator("body")).toHaveAttribute("data-phase", "error");
  await page.evaluate(
    (source) =>
      (window as any).session.change("/main.ts", source + "; export const recovered=true;"),
    source,
  );
  await expect(page.locator("body")).toHaveAttribute("data-phase", "ready");
  await expect(frame.getByLabel("Compute output")).toHaveText("12");
});

test("type-check initialization is reused and its idle realm is eventually terminated", async ({
  page,
}) => {
  await open(page, "dom", "&typeIdle=100");

  const results = await page.evaluate(async () => [
    (await (window as any).session.check("types")).diagnostics,
    (await (window as any).session.check("types")).diagnostics,
  ]);

  expect(results).toEqual([[], []]);
  expect(
    await page.evaluate(
      () =>
        (window as any).ownedWorkers.filter((worker) => worker.name === "reploom-typecheck").length,
    ),
  ).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).ownedWorkers
          .filter((worker) => worker.name === "reploom-typecheck")
          .every((worker) => worker.retired),
      ),
    )
    .toBe(true);
});

test("type-check checkpoints preserve diagnostics across memory-pressure Worker retirement", async ({
  page,
}) => {
  await open(page, "dom", "&typeMemory=1");

  const results = await page.evaluate(async () => {
    const host = window as any;

    const files = Object.fromEntries(
      Object.entries(host.session.getSnapshot().files).map(([path, source]) => [
        path,
        String(source),
      ]),
    );

    files["/types.ts"] = Array.from(
      { length: 2600 },
      (_, i) => `export const item${i}: {value:number} = {value:${i}};`,
    ).join("\n");
    const results = [];
    for (const value of ["1", "'bad'", "2"]) {
      files["/extra.ts"] = `export const value: number = ${value};`;
      results.push(
        await host.platform.services.validation.types(files, new AbortController().signal),
      );
    }
    const workers = host.ownedWorkers.filter((worker) => worker.name === "reploom-typecheck");
    return {
      results,
      workers: workers.length,
      retired: workers.filter((worker) => worker.retired).length,
      initializations: workers.flatMap((worker) => worker.initializations),
      metadata: workers.flatMap((worker) =>
        worker.replies.map((reply) => ({
          bytes: reply.buildInfoBytes,
          checkpoint: reply.checkpoint,
        })),
      ),
    };
  });

  expect(results.results[0]).toEqual([]);
  expect(results.results[1]).toHaveLength(1);
  expect(results.results[1][0].text).toContain("TS2322");
  expect(results.results[2]).toEqual([]);
  expect(results.workers).toBe(3);
  expect(results.retired).toBe(3);
  expect(results.initializations.map((item) => item.module)).toEqual([false, true, true]);
  expect(results.initializations[0].wasmBytes).toBeGreaterThan(0);
  expect(results.initializations.slice(1).map((item) => item.wasmBytes)).toEqual([0, 0]);
  for (const metadata of results.metadata) {
    expect(metadata.bytes).toBeGreaterThan(0);
    expect(metadata.bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(metadata.checkpoint).toBe(true);
  }
});
