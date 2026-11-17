import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { encodeProjectFragment, decodeProjectFragment } from "../../packages/runtime/src/share.ts";

const archive = {
  schema: 1,
  project: "counter",
  projectKey: "key",
  active: "/new.ts",
  files: { "/main.ts": "import './new.ts'", "/new.ts": "export const label = '한글 # 🧵'" },
  state: { "/new.ts": { count: 2 } },
};

test("a portable link carries the selected source, panel and managed state", async () => {
  const fragment = await encodeProjectFragment({ archive, view: "preview" });
  assert.match(fragment, /^#reploom=1\.preview\.[\w-]+$/);
  const decoded = await decodeProjectFragment(fragment);
  assert.deepEqual(JSON.parse(JSON.stringify(decoded)), { archive, view: "preview" });
});
test("share transport bounds encoded and expanded input and rejects invalid envelopes", async () => {
  const prefix = "#reploom=1.code.";
  for (const hash of [
    "#anchor",
    prefix + "*",
    prefix + "A".repeat(65536),
    prefix + gzipSync(" ".repeat(5 * 1024 * 1024 + 1)).toString("base64url"),
    prefix + gzipSync(JSON.stringify({ ...archive, files: {} })).toString("base64url"),
  ])
    await assert.rejects(decodeProjectFragment(hash));
  await assert.rejects(
    encodeProjectFragment({
      view: "split",
      archive: { ...archive, files: { "/new.ts": randomBytes(70000).toString("hex") } },
    }),
    RangeError,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    decodeProjectFragment(
      await encodeProjectFragment({ archive, view: "code" }),
      controller.signal,
    ),
    { name: "AbortError" },
  );
});
