import test from "node:test";
import assert from "node:assert/strict";
import remapping from "@jridgewell/remapping";
import {
  GenMapping,
  maybeAddSegment,
  setSourceContent,
  setIgnore,
  toEncodedMap,
} from "@jridgewell/gen-mapping";
import { composeModuleMap } from "../reference/module-source-map.ts";

test("streamed two-stage maps match the reference remapper for gaps, names, ignored sources and nonmonotonic original positions", () => {
  let seed = 9387;
  const random = (n) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
  for (let trial = 0; trial < 200; trial++) {
    const first = new GenMapping({ sourceRoot: "/src" });
    for (const source of ["one.ts", "two.ts"])
      setSourceContent(first, source, "// 한글 😀\nexport const value = 1;\n");
    setIgnore(first, "two.ts", true);
    for (let line = 0; line < 8; line++)
      for (let column = 0; column < 40; column += 5) {
        if (random(4) === 0) maybeAddSegment(first, line, column);
        else
          maybeAddSegment(
            first,
            line,
            column,
            random(2) ? "one.ts" : "two.ts",
            random(3),
            random(35),
            random(3) ? undefined : "inner-name",
          );
      }
    const second = new GenMapping({ file: "linked.js" });
    for (let line = 0; line < 10; line++)
      for (let column = 0; column < 50; column += 3) {
        if (random(4) === 0) maybeAddSegment(second, line, column);
        else
          maybeAddSegment(
            second,
            line,
            column,
            "transformed.js",
            random(10),
            random(45),
            random(3) ? undefined : "outer-name",
          );
      }

    const a = toEncodedMap(second);
    const b = toEncodedMap(first);

    assert.equal(
      JSON.stringify(composeModuleMap(a, b)),
      JSON.stringify(remapping([a, b], () => null)),
      `map pair ${trial}`,
    );
  }
  const empty = { version: 3, sources: [], names: [], mappings: "" };
  assert.equal(
    JSON.stringify(composeModuleMap(empty, empty)),
    JSON.stringify(remapping([empty, empty], () => null)),
  );

  const ignoredEmptySource = {
    version: 3,
    sources: [""],
    names: [],
    mappings: "AAAA",
    sourcesContent: ["content"],
    ignoreList: [0],
  };

  const identity = {
    version: 3,
    sources: ["intermediate.js"],
    names: [],
    mappings: "AAAA",
  };

  assert.equal(
    JSON.stringify(composeModuleMap(identity, ignoredEmptySource)),
    JSON.stringify(remapping([identity, ignoredEmptySource], () => null)),
  );
});

test("ordered composition matches the reference across buffer boundaries, empty lines and duplicate columns", () => {
  for (const duplicates of [false, true]) {
    const first = new GenMapping({ sourceRoot: "/unicode/한글" });
    setSourceContent(first, "😀.ts", "// preserved original");
    setIgnore(first, "😀.ts", true);
    const second = new GenMapping({ file: "result.js" });
    for (let line = 0; line < 2000; line++) {
      if (line % 7 === 0) continue;
      for (let column = 0; column < 40; column += 4) {
        if (column === 12) maybeAddSegment(first, line, column);
        else
          maybeAddSegment(
            first,
            line,
            column,
            "😀.ts",
            2000 - line,
            column,
            column % 8 ? "한글" : undefined,
          );
        if (duplicates && column === 20)
          maybeAddSegment(first, line, column, "😀.ts", line, 99, "second");
        maybeAddSegment(second, line + 2, column, "intermediate.js", line, column);
        maybeAddSegment(second, line + 2, column + 1, "intermediate.js", line, column + 1);
      }
    }

    const a = toEncodedMap(second);
    const b = toEncodedMap(first);

    assert.equal(
      JSON.stringify(composeModuleMap(a, b)),
      JSON.stringify(remapping([a, b], () => null)),
    );
  }
});
