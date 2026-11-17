import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { documentChange } from "../../packages/ui/src/codemirror/document-change.ts";

const require = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
const { Text } = await import(require.resolve("@codemirror/state"));

test("document replacement preserves arbitrary UTF-16 text without flattening either tree", () => {
  let seed = 1031;
  const random = (n) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
  const alphabet = ["a", "\n", "\r", "😀", "한", "\ud800", "\udc00"];

  const make = () =>
    Array.from({ length: random(80) }, () => alphabet[random(alphabet.length)]).join("");

  for (let i = 0; i < 3000; i++) {
    const source = make();
    const from = random(source.length + 1);
    const to = from + random(source.length - from + 1);
    const replacement = source.slice(0, from) + make() + source.slice(to);
    const before = Text.of(source.split("\n"));
    const after = Text.of(replacement.split("\n"));
    before.toString = after.toString = () => {
      throw Error("Document was flattened");
    };
    const change = documentChange(before, after);
    assert.equal(
      before.replace(change.from, change.to, change.insert).eq(after),
      true,
      `case ${i}`,
    );
  }
});

test("whole-document changes retain the unchanged middle-edit prefix and suffix", () => {
  const source = "const value = 1;\n".repeat(4000);
  const before = Text.of(source.split("\n"));
  const offset = Math.floor(source.length / 2);
  const after = Text.of((source.slice(0, offset) + "X" + source.slice(offset + 1)).split("\n"));
  const change = documentChange(before, after);
  assert.equal(change.from, offset);
  assert.equal(change.to, offset + 1);
  assert.equal(change.insert.toString(), "X");
});
