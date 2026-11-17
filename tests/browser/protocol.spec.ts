import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readCode, writeCode } from "./editor-helpers";
import { PROTOCOL } from "../../packages/runtime/src/shared/protocol";

async function observe(context: BrowserContext) {
  const external: string[] = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4331" || ["blob:", "data:"].includes(url.protocol))
      return route.continue();
    external.push(url.href);
    return route.abort();
  });
  await context.addInitScript((protocol: number) => {
    const state = ((window as any).__wire = {
      posts: [],
      replies: [],
      compiles: [],
      workerReplies: [],
      artifacts: [],
      corruptNext: false,
      blobs: 0,
      blobURLs: new Set<string>(),
    });

    const blob = URL.createObjectURL;
    URL.createObjectURL = function (value) {
      state.blobs++;
      const url = blob.call(this, value);
      state.blobURLs.add(url);
      return url;
    };
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = function (url) {
      state.blobURLs.delete(url);
      revoke.call(this, url);
    };
    const onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage")!;
    Object.defineProperty(MessagePort.prototype, "onmessage", {
      ...onmessage,
      set(handler) {
        onmessage.set!.call(
          this,
          handler &&
            function (this: MessagePort, event: MessageEvent) {
              if (event.data?.type === "artifact") {
                const patch = event.data.patch;
                state.artifacts.push({
                  base: patch.baseRevision,
                  revision: patch.revision,
                  changed: Object.keys(patch.changed),
                });
                if (state.corruptNext && patch.baseRevision !== null) {
                  state.corruptNext = false;
                  patch.baseRevision += 1000;
                }
              }
              handler.call(this, event);
            },
        );
      },
    });

    const observePort = (port: MessagePort) => {
      if ((port as any).__observed) return;
      (port as any).__observed = true;
      port.addEventListener("message", (event) => {
        if (event.data?.protocol === protocol) state.replies.push(event.data);
      });
    };

    const Channel = window.MessageChannel;
    window.MessageChannel = class extends Channel {
      constructor() {
        super();
        // Observe before the application's handler closes the port on disposed.
        // WebKit may skip later listeners when that handler tears down the frame.
        observePort(this.port1);
      }
    };
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (data, ...rest: any[]) {
      if (data?.type === "disposed") data = { ...data, remainingBlobURLs: state.blobURLs.size };
      if (data?.protocol === protocol) {
        observePort(this);
        if (state.corruptNext && data.type === "apply" && data.patch.baseRevision !== null) {
          state.corruptNext = false;
          data = {
            ...data,
            patch: {
              ...data.patch,
              baseRevision: data.patch.baseRevision + 1000,
            },
          };
        }
        state.posts.push({
          type: data.type,
          initializes: data.type === "initialize" || !!data.initialize,
          generation: data.generation,
          base: data.patch?.baseRevision,
          revision: data.patch?.revision,
          changed: Object.keys(data.patch?.changed || {}),
          vendorBytes:
            data.vendor?.reduce(
              (total: number, part: string | Blob) =>
                total +
                (typeof part === "string" ? new TextEncoder().encode(part).byteLength : part.size),
              0,
            ) || 0,
          vendorBlobs: data.vendor?.filter((part: unknown) => part instanceof Blob).length || 0,
          moduleChars: Object.values(data.patch?.changed || {}).reduce(
            (n: number, item: any) => n + (item.code?.length || item.data?.length || 0),
            0,
          ),
        });
      }
      return post.call(this, data, ...(rest as [any]));
    };
    const compile = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (data, ...rest: any[]) {
      if (data?.type === "compile") {
        if (!(this as any).__observed) {
          (this as any).__observed = true;
          this.addEventListener(
            "message",
            (event) => "id" in event.data && state.workerReplies.push(event.data),
          );
        }
        state.compiles.push({
          revision: data.revision,
          base: data.baseRevision,
          changes: Object.keys(data.changes),
          seedKeys: Object.keys(data.seed || {}),
        });
      }
      return compile.call(this, data, ...(rest as [any]));
    };
  }, PROTOCOL);
  return external;
}

async function open(page: Page) {
  await page.goto("/regression/");
  for (const id of [
    "react-effect-dependencies",
    "react-stale-closure",
    "react-effect-events",
    "react-counter",
    "dom-counter",
  ])
    await expect(page.locator(`[data-project="${id}"]`)).toHaveAttribute("data-phase", "ready");

  const article = page.locator('[data-project="react-effect-events"]');
  const preview = article.frameLocator("iframe");

  return {
    article,
    preview,
    editor: article.getByRole("textbox", { name: "/App.js code" }),
  };
}

test("a newer compiled edit restarts automatically when an older execution retires resources and fails", async ({
  page,
  context,
}, info) => {
  const external = await observe(context);
  const { article, preview, editor } = await open(page);
  const fixture = `import.meta.hot.dispose(() => {}); export default function App(){return <h1>resource-original</h1>;}`;
  await writeCode(editor, fixture);
  await expect(preview.locator("h1")).toHaveText("resource-original");
  const frame = await (await article.locator("iframe").elementHandle())!.contentFrame();
  await frame!.evaluate(() => {
    (globalThis as any).__realm = "before-failure";
  });
  await writeCode(
    editor,
    fixture +
      `\nglobalThis.__waiting = true; await new Promise(r => setTimeout(r, 1800)); throw new Error('older-resource-failure');`,
  );
  await expect.poll(() => frame!.evaluate(() => (globalThis as any).__waiting)).toBe(true);
  await writeCode(editor, fixture.replace("resource-original", "resource-recovered"));
  await expect(preview.locator("h1")).toHaveText("resource-recovered");
  await expect(article).toHaveAttribute("data-phase", "ready");
  const nextFrame = await (await article.locator("iframe").elementHandle())!.contentFrame();
  expect(await nextFrame!.evaluate(() => (globalThis as any).__realm)).toBeUndefined();
  const wire = await page.evaluate(() => (window as any).__wire);
  const initializeCount = (await page.locator("[data-project]").count()) + 1;
  expect(wire.posts.filter((p: any) => p.initializes)).toHaveLength(initializeCount);
  expect(wire.replies.some((p: any) => p.type === "settled" && p.requiresRestart)).toBe(true);
  expect(external).toEqual([]);
  await info.attach("stale-execution-restart", {
    body: JSON.stringify({
      initializeCount,
      external,
      replies: wire.replies
        .filter((p: any) => p.type === "settled")
        .map((p: any) => ({
          revision: p.revision,
          outcome: p.outcome,
          requiresRestart: p.requiresRestart,
        })),
    }),
    contentType: "application/json",
  });
});

test("retiring a pending lazy module releases resources without recreating the frame", async ({
  page,
  context,
}, info) => {
  const external = await observe(context);
  const { article, preview, editor } = await open(page);
  await writeCode(editor, `export default function App(){return <h1>lazy-base</h1>;}`);
  await expect(preview.locator("h1")).toHaveText("lazy-base");
  await article.getByLabel("File", { exact: true }).selectOption("/notifications.js");
  await writeCode(
    article.getByRole("textbox", { name: "/notifications.js code" }),
    `globalThis.__lazyTest.active++; import.meta.hot.dispose(() => globalThis.__lazyTest.active--); await new Promise(() => {}); export const value=1;`,
  );
  await article.getByLabel("File", { exact: true }).selectOption("/App.js");
  await writeCode(
    editor,
    `globalThis.__lazyTest = { active: 0 }; globalThis.__lazyTest.pending = import('./notifications.js').catch(() => 'retired'); export default function App(){return <h1>lazy-active</h1>;}`,
  );
  await expect(preview.locator("h1")).toHaveText("lazy-active");
  await expect
    .poll(() => preview.locator("body").evaluate(() => (window as any).__lazyTest.active))
    .toBe(1);
  await writeCode(editor, `export default function App(){return <h1>lazy-retired</h1>;}`);
  await expect(preview.locator("h1")).toHaveText("lazy-retired");
  await expect(article).toHaveAttribute("data-phase", "ready");

  const result = await preview.locator("body").evaluate(async () => ({
    active: (window as any).__lazyTest.active,
    pending: await (window as any).__lazyTest.pending,
  }));

  expect(result).toEqual({ active: 0, pending: "retired" });
  expect(external).toEqual([]);
  await info.attach("pending-lazy-retirement", {
    body: JSON.stringify({ result, external }),
    contentType: "application/json",
  });
});

test("acknowledged deltas resynchronize without losing state; vendor initializes once and teardown acknowledges cleanup", async ({
  page,
  context,
}, info) => {
  const external = await observe(context);
  const { article, preview, editor } = await open(page);
  const original = await readCode(editor);
  await preview.getByRole("checkbox").check();
  await preview.getByRole("combobox").selectOption("travel");
  await preview.locator("body").evaluate(() => {
    (window as any).__realm = "retained";
  });
  await writeCode(editor, original.replace("Room:", "delta-one"));
  await expect(preview.locator("h1")).toContainText("delta-one travel");
  await expect(article).toHaveAttribute("data-phase", "ready");
  await preview.locator("body").evaluate(() => {
    (window as any).__wire.corruptNext = true;
  });
  await writeCode(editor, original.replace("Room:", "delta-two"));
  await expect(preview.locator("h1")).toContainText("delta-two travel");
  await expect(preview.getByRole("checkbox")).toBeChecked();
  expect(await preview.locator("body").evaluate(() => (window as any).__realm)).toBe("retained");
  await expect(article).toHaveAttribute("data-phase", "ready");
  const wire = await page.evaluate(() => (window as any).__wire);
  expect(wire.posts.filter((p: any) => p.initializes)).toHaveLength(
    await page.locator("[data-project]").count(),
  );
  expect(
    wire.posts.filter((p: any) => p.type === "initialize").every((p: any) => p.vendorBlobs > 0),
  ).toBe(true);
  expect(
    wire.posts
      .filter((p: any) => p.type === "apply-reference")
      .every((p: any) => p.vendorBytes === 0),
  ).toBe(true);
  const artifacts = await preview.locator("body").evaluate(() => (window as any).__wire.artifacts);
  expect(artifacts.some((p: any) => p.changed.length === 1 && p.changed[0] === "/App.js")).toBe(
    true,
  );
  expect(
    wire.posts
      .filter((p: any) => p.type === "apply-reference")
      .every((p: any) => p.moduleChars === 0),
  ).toBe(true);
  expect(wire.replies.some((p: any) => p.type === "resync")).toBe(true);
  expect(artifacts.filter((p: any) => p.base === null).length).toBe(2); // initial direct delivery and the deliberately corrupted delta
  expect(wire.compiles[0].seedKeys.sort()).toEqual(["files", "output"]);
  expect(wire.workerReplies.filter((p: any) => p.ok).at(-1).reference.transformed).toEqual([
    "/App.js",
  ]);
  // WebKit keeps executable source leases for error provenance; inline-capable
  // engines avoid them. All leases must be released by the disposal ACK below.
  expect(
    await preview.locator("body").evaluate(() => (window as any).__wire.blobURLs.size),
  ).toBeLessThan(40);
  expect(
    await preview.locator("body").evaluate(() => document.querySelectorAll("script").length),
  ).toBe(1);

  await article.getByLabel("File", { exact: true }).selectOption("/connection.js");
  const chat = article.getByRole("textbox", { name: "/connection.js code" });
  await writeCode(
    chat,
    (await readCode(chat)) +
      `\nglobalThis.__cleanupInstalled = true; import.meta.hot.dispose(() => { throw new Error('cleanup-ack-marker'); });`,
  );
  await expect
    .poll(() => preview.locator("body").evaluate(() => (window as any).__cleanupInstalled))
    .toBe(true);
  await expect(article).toHaveAttribute("data-phase", "ready");
  await article.getByRole("button", { name: "Run again" }).click();
  await expect(preview.locator("h1")).toContainText("delta-two general");
  await expect(article).toHaveAttribute("data-phase", "ready");
  expect(await preview.locator("body").evaluate(() => (window as any).__realm)).toBeUndefined();
  const after = await page.evaluate(() => (window as any).__wire);
  await expect(article.locator(".reploom-console")).toContainText("cleanup-ack-marker");
  expect(
    after.replies.some(
      (p: any) =>
        p.type === "disposed" &&
        p.diagnostics.some((d: any) => d.text.includes("cleanup-ack-marker")),
    ),
  ).toBe(true);
  expect(
    after.replies
      .filter((reply: any) => reply.type === "disposed")
      .every((reply: any) => reply.remainingBlobURLs === 0),
  ).toBe(true);
  expect(after.posts.filter((p: any) => p.initializes)).toHaveLength(
    (await page.locator("[data-project]").count()) + 1,
  );
  expect(external).toEqual([]);
  await info.attach("wire-contract", {
    body: JSON.stringify({
      external,
      posts: after.posts,
      compiles: after.compiles,
      replies: after.replies.filter((p: any) => ["resync", "disposed"].includes(p.type)),
    }),
    contentType: "application/json",
  });
});

test("only the newest queued revision compiles after WASM loading while all file patches survive", async ({
  page,
  context,
}, info) => {
  const external = await observe(context);
  let release!: () => void;
  let started!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });

  await context.route("**/*.wasm", async (route) => {
    started();
    await gate;
    await route.continue();
  });
  const { article, preview, editor } = await open(page);
  const original = await readCode(editor);
  for (let i = 1; i <= 5; i++) {
    await writeCode(editor, original.replace("Room:", `queued-${i}`));
    await page.waitForFunction((n) => (window as any).__wire.compiles.length === n, i);
    if (i === 1) await loading;
  }
  // A different file's patch must not be lost when the latest request supersedes App.
  await article.getByLabel("File", { exact: true }).selectOption("/styles.css");
  const css = article.getByRole("textbox", { name: "/styles.css code" });
  await writeCode(css, (await readCode(css)) + "\nbody { background: rgb(200, 220, 230); }");
  await page.waitForFunction(() => (window as any).__wire.compiles.length === 6);
  release();
  await expect(preview.locator("h1")).toContainText("queued-5 general");
  await expect(preview.locator("body")).toHaveCSS("background-color", "rgb(200, 220, 230)");
  await expect(article).toHaveAttribute("data-phase", "ready");
  const wire = await page.evaluate(() => (window as any).__wire);
  expect(wire.compiles).toHaveLength(6);
  expect(wire.workerReplies).toHaveLength(1);
  expect(wire.workerReplies[0].reference.transformed.sort()).toEqual(["/App.js", "/styles.css"]);
  expect(external).toEqual([]);
  await info.attach("compile-coalescing", {
    body: JSON.stringify({
      external,
      submitted: wire.compiles,
      completed: wire.workerReplies.map((r: any) => ({
        ok: r.ok,
        revision: r.patch?.revision,
        transformed: r.reference?.transformed,
      })),
    }),
    contentType: "application/json",
  });
});

test("runtime regressions preserve state across reentrant import and keep committed resources after cleanup and accept errors", async ({
  page,
  context,
}, info) => {
  const external = await observe(context);
  const { article, preview } = await open(page);

  const edit = async (path: string, source: string) => {
    await article.getByLabel("File", { exact: true }).selectOption(path);
    await writeCode(article.getByRole("textbox", { name: `${path} code` }), source);
  };

  await edit(
    "/connection.js",
    `export async function load() { await Promise.resolve(); return import('./notifications.js'); }`,
  );
  await edit("/notifications.js", `export const value = 42;`);

  const app = `import { useState } from 'react'; import { load } from './connection.js';
    globalThis.__moduleThis = this;
    export default function App(){ const [count,set]=useState(0); return <><h1>before</h1><button onClick={()=>set(n=>n+1)}>count {count}</button></>; }`;

  await edit("/App.js", app);
  await expect(preview.getByRole("button")).toHaveText("count 0");
  await preview.getByRole("button").click({ clickCount: 2 });
  await expect(preview.getByRole("button")).toHaveText("count 2");
  await edit(
    "/App.js",
    app
      .replace("globalThis.__moduleThis", "const {value}=await load(); globalThis.__moduleThis")
      .replace("<h1>before</h1>", "<h1>loaded {value}</h1>"),
  );
  await expect(preview.locator("h1")).toHaveText("loaded 42");
  await expect(preview.getByRole("button")).toHaveText("count 2");
  expect(
    await preview.locator("body").evaluate(() => (window as any).__moduleThis === undefined),
  ).toBe(true);

  const resource = `const s=globalThis.__resources ||= {active:0, first:0, second:0}; s.active++;
    export const value=1;
    import.meta.hot.dispose(()=>{s.first++; throw new Error('cleanup-first');});
    import.meta.hot.dispose(()=>{s.second++; s.active--;});
    import.meta.hot.accept(()=>{throw new Error('accept-after-commit');});`;

  await edit("/connection.js", resource);
  await edit(
    "/App.js",
    app
      .replace("import { load }", "import { value }")
      .replace("<h1>before</h1>", "<h1>resource {value}</h1>"),
  );
  await expect(preview.locator("h1")).toHaveText("resource 1");
  await expect(article).toHaveAttribute("data-phase", "ready");
  const before = await preview.locator("body").evaluate(() => ({ ...(window as any).__resources }));
  await edit("/connection.js", resource.replace("value=1", "value=2"));
  await expect(article.locator(".reploom-errors")).toContainText("cleanup-first");
  await expect(article.locator(".reploom-errors")).toContainText("accept-after-commit");
  await preview.getByRole("button").click();
  await expect(preview.locator("h1")).toHaveText("resource 2");
  const after = await preview.locator("body").evaluate(() => ({ ...(window as any).__resources }));
  expect(after.active).toBe(1);
  expect(after.first - before.first).toBe(1);
  expect(after.second - before.second).toBe(1);
  expect(external).toEqual([]);
  await info.attach("runtime-error-contracts", {
    body: JSON.stringify({ external, before, after }),
    contentType: "application/json",
  });
});
