import { workersNamed } from "./worker-helpers";
import { test, expect, type Page, type BrowserContext, type Locator } from "@playwright/test";
import { readCode, writeCode } from "./editor-helpers";

// Shared CI runners verify progress and ordering. Absolute latency ceilings run
// separately on a controlled host; every run still records its observed times.
function latencyBelow(actual: number, limit: number) {
  if (process.env.REPLOOM_PERFORMANCE_GATES === "1") expect(actual).toBeLessThan(limit);
}

async function open(page: Page, context: BrowserContext) {
  const external: string[] = [];
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin === "http://127.0.0.1:4331" || ["blob:", "data:"].includes(u.protocol))
      return route.continue();
    external.push(u.href);
    return route.abort();
  });
  await page.goto("/regression/");
  for (const id of ["react-effect-events", "react-counter", "dom-counter", "compute-primes"])
    await expect(page.locator(`[data-project="${id}"]`)).toHaveAttribute("data-phase", "ready");
  return external;
}

function project(page: Page, id: string, path: string) {
  const article = page.locator(`[data-project="${id}"]`);
  return {
    article,
    editor: article.getByRole("textbox", { name: `${path} code` }),
    preview: article.frameLocator("iframe"),
  };
}

async function probe(page: Page, active: boolean) {
  return page.evaluate((active) => {
    const win = window as any;
    if (active) {
      win.__response = { active: true, frames: 0, maxGap: 0, ticks: 0 };
      let previous: number | undefined;
      requestAnimationFrame(function frame(t) {
        const p = win.__response;
        if (!p.active) return;
        if (previous !== undefined) p.maxGap = Math.max(p.maxGap, t - previous);
        previous = t;
        p.frames++;
        requestAnimationFrame(frame);
      });

      const tick = () => {
        if (win.__response.active) {
          win.__response.ticks++;
          setTimeout(tick, 10);
        }
      };

      tick();
    } else win.__response.active = false;
    return { ...win.__response };
  }, active);
}

async function typeSpace(page: Page, editor: Locator) {
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  const start = performance.now();
  await page.keyboard.type(" ");
  const ms = performance.now() - start;
  latencyBelow(ms, 350);
  return ms;
}

test("Window budgets stop loops and microtask starvation, recover state and do not charge suspended time", async ({
  page,
  context,
}, info) => {
  const external = await open(page, context);

  const react = project(page, "react-effect-events", "/App.js");
  const dom = project(page, "dom-counter", "/main.ts");

  const reactSource = await readCode(react.editor);
  const domSource = await readCode(dom.editor);

  await react.preview.getByRole("combobox").selectOption("travel");
  await react.preview.getByRole("checkbox").check();
  await dom.preview.getByRole("button").click({ clickCount: 2 });
  await dom.preview.getByRole("textbox").fill("Persistent input");
  await react.preview.locator("body").evaluate(() => {
    (window as any).__sameRealm = true;
  });
  await probe(page, true);
  await writeCode(react.editor, "while (true) {}\n" + reactSource);
  await expect(react.article.locator(".reploom-errors")).toContainText(
    "Synchronous execution budget of 32ms",
  );
  const inputMs = await typeSpace(page, react.editor);
  await writeCode(react.editor, reactSource.replace("Room:", "Budget recovery"));
  await expect(react.preview.locator("h1")).toContainText("Budget recovery");
  await expect(react.preview.getByRole("combobox")).toHaveValue("travel");
  await expect(react.preview.getByRole("checkbox")).toBeChecked();
  expect(await react.preview.locator("body").evaluate(() => (window as any).__sameRealm)).toBe(
    true,
  );

  const runawayHandler = domSource.replace("count++;", "while (true) {}");
  expect(runawayHandler).not.toBe(domSource);
  await writeCode(dom.editor, runawayHandler);
  await expect(dom.article).toHaveAttribute("data-phase", "ready");
  await dom.preview.getByRole("button").click();
  await expect(dom.article.locator(".reploom-errors")).toContainText(
    "Synchronous execution budget of",
  );
  await writeCode(
    dom.editor,
    "globalThis.__microtaskStarted = true; try { for (;;) await Promise.resolve(); } catch { for (;;) await Promise.resolve(); }\n" +
      domSource,
  );
  await expect
    .poll(() => dom.preview.locator("body").evaluate(() => (window as any).__microtaskStarted))
    .toBe(true);
  await expect(dom.article.locator(".reploom-errors")).toContainText(
    "Synchronous execution budget of",
  );
  await writeCode(
    dom.editor,
    "await new Promise(resolve => setTimeout(resolve, 100));\n" + domSource,
  );
  await expect(dom.article).toHaveAttribute("data-phase", "ready");
  await expect(dom.preview.getByRole("button")).toHaveText("DOM count 2");
  await expect(dom.preview.getByRole("textbox")).toHaveValue("Persistent input");
  await dom.preview.getByRole("button").click();
  await expect(dom.preview.getByRole("button")).toHaveText("DOM count 3");
  const responsiveness = await probe(page, false);
  expect(responsiveness.frames).toBeGreaterThan(5);
  latencyBelow(responsiveness.maxGap, 250);
  expect(external).toEqual([]);
  await info.attach("window-budget", {
    body: JSON.stringify({
      inputMs,
      responsiveness,
      reactState: { room: "travel", dark: true },
      domState: 3,
      sameReactRealm: true,
      external,
    }),
    contentType: "application/json",
  });
});

test("long computation keeps the editor and React/DOM responsive, reuses its Worker and skips metadata-only execution", async ({
  page,
  context,
}, info) => {
  const external = await open(page, context);

  const compute = project(page, "compute-primes", "/main.ts");
  const react = project(page, "react-counter", "/src/Dashboard.tsx");
  const dom = project(page, "dom-counter", "/main.ts");

  await expect(compute.preview.getByLabel("Compute output")).toContainText('"primes": 22044');
  await expect(compute.preview.getByLabel("Compute output")).toContainText(
    '"documentAvailable": false',
  );
  expect(
    await compute.preview
      .locator("body")
      .evaluate(() => typeof (globalThis as any).__PLAYGROUND_VENDOR__.dependencies.clsx),
  ).toBe("undefined");
  const worker = (await workersNamed(page, "reploom-compute"))[0]!;
  expect(worker).toBeTruthy();
  await react.preview.getByRole("button").click({ clickCount: 2 });
  await react.preview.getByRole("textbox").fill("React Note");
  const marker = await react.preview.getByLabel("Stable reference").textContent();
  const reactSource = await readCode(react.editor);
  await react.preview.locator("body").evaluate(() => {
    (window as any).__input = document.querySelector("input");
  });
  await dom.preview.getByRole("button").click({ clickCount: 2 });
  await dom.preview.getByRole("textbox").fill("DOM Note");
  await react.editor.evaluate((element) => {
    element.addEventListener(
      "beforeinput",
      () => {
        (window as any).__computeInputAt = performance.timeOrigin + performance.now();
      },
      { once: true },
    );
  });
  const long = `export function run({state,report}) { report({phase:'RUNNING'}); const start=performance.now(); let n=0; while(performance.now()-start<800) n++; const end=performance.now(); state.runs=Number(state.runs||0)+1; return {phase:'DONE',runs:state.runs,elapsed:end-start,startedAt:performance.timeOrigin+start,finishedAt:performance.timeOrigin+end,document:typeof document,origin:location.origin,secure:isSecureContext,uuid:typeof crypto.randomUUID}; }`;
  await writeCode(compute.editor, long);
  await expect(compute.preview.getByLabel("Compute output")).toContainText("RUNNING");
  await probe(page, true);
  const inputMs = await typeSpace(page, react.editor);
  await writeCode(react.editor, reactSource.replace("{settings.title}", "Edit alongside Worker"));
  await expect(react.preview.locator("h1")).toHaveText("Edit alongside Worker");
  await dom.preview.getByRole("button").click();
  await expect(dom.preview.getByRole("button")).toHaveText("DOM count 3");
  await expect(compute.article).toHaveAttribute("data-phase", "ready");

  const result = JSON.parse(
    (await compute.preview.getByLabel("Compute output").textContent()) || "{}",
  );

  expect(result.elapsed).toBeGreaterThanOrEqual(800);
  expect(result.runs).toBe(2);
  expect(result.document).toBe("undefined");
  expect(result.origin).toBe("null");
  const inputAt = await page.evaluate(() => (window as any).__computeInputAt);
  expect(inputAt).toBeGreaterThanOrEqual(result.startedAt);
  expect(inputAt).toBeLessThan(result.finishedAt);
  const responsiveness = await probe(page, false);
  expect(responsiveness.frames).toBeGreaterThan(10);
  expect(responsiveness.ticks).toBeGreaterThan(10);
  latencyBelow(responsiveness.maxGap, 200);
  expect(await workersNamed(page, "reploom-compute")).toEqual([worker]);
  await writeCode(compute.editor, long + "\n");
  await expect(compute.article).toHaveAttribute("data-phase", "ready");
  await expect(compute.preview.getByLabel("Compute output")).toContainText('"runs": 2');
  await expect(react.preview.getByRole("button")).toHaveText("count 2");
  await expect(react.preview.getByRole("textbox")).toHaveValue("React Note");
  await expect(react.preview.getByLabel("Stable reference")).toHaveText(marker!);
  expect(
    await react.preview
      .locator("body")
      .evaluate(() => (window as any).__input === document.querySelector("input")),
  ).toBe(true);
  await expect(dom.preview.getByRole("textbox")).toHaveValue("DOM Note");
  expect(external).toEqual([]);
  await info.attach("compute-responsive", {
    body: JSON.stringify({
      inputMs,
      inputAt,
      result,
      responsiveness,
      workerReused: true,
      metadataSkipped: true,
      external,
    }),
    contentType: "application/json",
  });
});

const unguarded = `export function run({report}) {report({phase:'UNGUARDED'}); const url=URL.createObjectURL(new Blob(['while(true){}'],{type:'text/javascript'}));try {importScripts(url)}finally {URL.revokeObjectURL(url)} }`;
test("compute budget, hard watchdog, Stop and newer edits terminate runaway workers and recover", async ({
  page,
  context,
}, info) => {
  const external = await open(page, context);

  const compute = project(page, "compute-primes", "/main.ts");
  const react = project(page, "react-counter", "/src/Dashboard.tsx");

  const recover = `export function run({state}) {state.runs=Number(state.runs||0)+1;return {recovered:42,runs:state.runs};}`;
  await writeCode(compute.editor, "export function run(){while(true){}}");
  await expect(compute.article.locator(".reploom-errors")).toContainText(
    "Computation exceeded the 2000ms time limit",
  );
  await writeCode(
    compute.editor,
    "export async function run({report}){report({phase:'MICROTASK_LOOP'});for(;;)await Promise.resolve()}",
  );
  await expect(compute.preview.getByLabel("Compute output")).toContainText("MICROTASK_LOOP");
  await expect(compute.article.locator(".reploom-errors")).toContainText(
    "Computation exceeded the 2000ms time limit",
  );
  await writeCode(compute.editor, unguarded);
  await expect(compute.preview.getByLabel("Compute output")).toContainText("UNGUARDED");
  await probe(page, true);
  const inputMs = await typeSpace(page, react.editor);
  const start = performance.now();
  await expect(compute.article.locator(".reploom-errors")).toContainText(
    "Computation exceeded the 2000ms time limit",
  );
  const watchdogMs = performance.now() - start;
  const responsiveness = await probe(page, false);
  latencyBelow(watchdogMs, 3000);
  expect(responsiveness.frames).toBeGreaterThan(20);
  latencyBelow(responsiveness.maxGap, 200);
  await expect.poll(async () => (await workersNamed(page, "reploom-compute")).length).toBe(0);
  await writeCode(compute.editor, recover);
  await expect(compute.preview.getByLabel("Compute output")).toContainText('"recovered": 42');
  await expect(compute.preview.getByLabel("Compute output")).toContainText('"runs": 1');

  await writeCode(compute.editor, unguarded.replace("UNGUARDED", "STOP_LOOP"));
  await expect(compute.preview.getByLabel("Compute output")).toContainText("STOP_LOOP");
  const stoppedAt = performance.now();
  await compute.preview.getByRole("button", { name: "Stop computation" }).click();
  await expect(compute.article).toHaveAttribute("data-phase", "ready");
  const stopMs = performance.now() - stoppedAt;
  latencyBelow(stopMs, 500);
  await expect.poll(async () => (await workersNamed(page, "reploom-compute")).length).toBe(0);

  await writeCode(compute.editor, unguarded.replace("UNGUARDED", "SUPERSEDE_LOOP"));
  await expect(compute.preview.getByLabel("Compute output")).toContainText("SUPERSEDE_LOOP");
  const newerAt = performance.now();
  await writeCode(compute.editor, recover.replace("42", "99"));
  await expect(compute.preview.getByLabel("Compute output")).toContainText('"recovered": 99');
  const supersededMs = performance.now() - newerAt;
  latencyBelow(supersededMs, 1500);
  await expect(compute.preview.getByLabel("Compute output")).toContainText('"runs": 1');
  expect(external).toEqual([]);
  await info.attach("compute-recovery", {
    body: JSON.stringify({
      inputMs,
      watchdogMs,
      stopMs,
      supersededMs,
      responsiveness,
      external,
    }),
    contentType: "application/json",
  });
});

test("compute completion aborts run resources, delivers final coalesced progress and tears down the Worker on reset", async ({
  page,
  context,
}, info) => {
  const external = await open(page, context);
  const compute = project(page, "compute-primes", "/main.ts");

  const source = `export function run({state,signal,report}) {const previous=state.cleanups||0;signal.addEventListener('abort',()=>{state.cleanups=previous+1},{once:true});for(let i=0;i<10000;i++)report({latest:i,previous});}`;
  await writeCode(compute.editor, source);
  await expect(compute.article).toHaveAttribute("data-phase", "ready");
  await expect(compute.preview.getByLabel("Compute output")).toContainText('"latest": 9999');
  await writeCode(compute.editor, source.replace("10000", "10001"));
  await expect(compute.preview.getByLabel("Compute output")).toContainText('"latest": 10000');
  await expect(compute.preview.getByLabel("Compute output")).toContainText('"previous": 1');
  const worker = (await workersNamed(page, "reploom-compute"))[0];
  await compute.article.getByRole("button", { name: "Reset source" }).click();
  await expect(compute.article).toHaveAttribute("data-phase", "ready");
  await expect(compute.preview.getByLabel("Compute output")).toContainText('"runs": 1');
  expect(page.workers()).not.toContain(worker);
  expect(await workersNamed(page, "reploom-compute")).toHaveLength(1);
  await writeCode(
    compute.editor,
    "export function run(){setTimeout(()=>{while(true){}},50);return {scheduled:true};}",
  );
  await expect(compute.preview.getByLabel("Compute output")).toContainText('"scheduled": true');
  await probe(page, true);
  await expect(compute.article.locator(".reploom-errors")).toContainText(
    "Worker became unresponsive after completion and was terminated",
  );
  const idleResponsiveness = await probe(page, false);
  expect(idleResponsiveness.frames).toBeGreaterThan(20);
  latencyBelow(idleResponsiveness.maxGap, 200);
  await expect.poll(async () => (await workersNamed(page, "reploom-compute")).length).toBe(0);
  await writeCode(
    compute.editor,
    "export function run({state}){state.runs=(state.runs||0)+1;return {idleRecovered:true,runs:state.runs};}",
  );
  await expect(compute.preview.getByLabel("Compute output")).toContainText('"idleRecovered": true');
  await expect(compute.preview.getByLabel("Compute output")).toContainText('"runs": 1');
  expect(external).toEqual([]);
  await info.attach("compute-lifecycle", {
    body: JSON.stringify({
      cleanupObserved: true,
      finalProgress: 10000,
      oldWorkerTerminated: true,
      idleRunawayTerminated: true,
      idleResponsiveness,
      external,
    }),
    contentType: "application/json",
  });
});

test("repeating unmanaged runaway callbacks retire their realm and recover in a fresh one", async ({
  page,
  context,
}, info) => {
  const external = await open(page, context);
  const dom = project(page, "dom-counter", "/main.ts");
  const original = await readCode(dom.editor);
  await dom.preview.getByRole("button").click({ clickCount: 2 });
  await probe(page, true);
  await writeCode(dom.editor, "setInterval(() => { while (true) {} }, 10);\n" + original);
  await expect(dom.article.locator("iframe")).toHaveCount(0);
  await expect(dom.article).toHaveAttribute("data-phase", "error");
  const inputMs = await typeSpace(page, dom.editor);
  await writeCode(dom.editor, original);
  await expect(dom.article).toHaveAttribute("data-phase", "ready");
  await expect(dom.preview.getByRole("button")).toHaveText("DOM count 0");
  await dom.preview.getByRole("button").click();
  await expect(dom.preview.getByRole("button")).toHaveText("DOM count 1");
  const responsiveness = await probe(page, false);
  latencyBelow(responsiveness.maxGap, 250);
  expect(external).toEqual([]);
  await info.attach("repeating-budget", {
    body: JSON.stringify({
      inputMs,
      responsiveness,
      freshRealm: true,
      stateReset: true,
      external,
    }),
    contentType: "application/json",
  });
});
