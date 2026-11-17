import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { previousSiblingIndex } from "./sibling-index.mjs";

const uiRequire = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
const languageRequire = createRequire(uiRequire.resolve("@codemirror/language"));

const { TreeBuffer, NodeType, NodeSet } = await import(
  pathToFileURL(languageRequire.resolve("@lezer/common").replace(/\.cjs$/, ".js"))
);

let seed = 19890617;

function random(max) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % max;
}

let comparisons = 0;
for (let trial = 0; trial < 5000; trial++) {
  let remaining = 1 + random(2000);
  let position = 0;
  const data = [];
  const lists = [];

  function children(depth, parentStart) {
    const siblings = [];
    const count = 1 + random(8);
    for (let i = 0; i < count && remaining > 0; i++) {
      remaining--;
      const index = data.length;
      siblings.push(index);
      data.push(0, position, 0, 0);
      position += random(3);
      if (depth < 8 && random(3)) children(depth + 1, index + 4);
      position += random(3);
      data[index + 2] = position;
      data[index + 3] = data.length;
    }
    lists.push({ parentStart, siblings });
  }

  children(0, 0);
  const buffer = new TreeBuffer(new Uint16Array(data), position, new NodeSet([NodeType.none]));
  for (const { parentStart, siblings } of lists) {
    for (let i = 1; i < siblings.length; i++) {
      const expected = buffer.findChild(parentStart, siblings[i], -1, 0, 4);
      assert.equal(expected, siblings[i - 1]);
      assert.equal(previousSiblingIndex(buffer, parentStart, siblings[i]), expected);
      comparisons++;
    }
  }
}
console.log(
  JSON.stringify(
    {
      seed: 19890617,
      trees: 5000,
      comparisons,
      result: "passed",
      allocation: globalThis.editorSiblingIndexStats,
    },
    null,
    2,
  ),
);
