import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";
import {
  scalarTransition,
  batchedTransition,
  characterRun,
} from "../../benchmarks/editor/lexer-transition.mjs";

import { boundaryCases, incrementalCases, recoveryCases } from "../fixtures/editor/lexer-cases.mjs";

const require = createRequire(new URL("../../packages/ui/package.json", import.meta.url));

const alias = Object.fromEntries(
  ["common", "lr", "javascript", "css", "json"].map((name) => [
    `@lezer/${name}`,
    require.resolve(`@lezer/${name}`).replace(/\.cjs$/, ".js"),
  ]),
);

const parsers = {};
for (const variant of ["before", "after"]) {
  const bundle = await build({
    entryPoints: ["benchmarks/editor/lexer.ts"],
    bundle: true,
    write: false,
    format: "esm",
    alias,
    plugins: [
      {
        name: "scalar-oracle",
        setup(build) {
          build.onLoad({ filter: /@lezer\/lr\/dist\/index.js$/ }, async ({ path }) => {
            const source = await readFile(path, "utf8");
            assert.equal(
              source.split(batchedTransition).length,
              2,
              "Pinned lexer patch is installed",
            );
            return {
              contents:
                variant === "before"
                  ? source.replace(batchedTransition, scalarTransition).replace(characterRun, "")
                  : source,
              loader: "js",
            };
          });
        },
      },
    ],
  });

  parsers[variant] = await import(
    "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
  );
}

for (const [name, generate] of Object.entries({ boundaryCases, incrementalCases, recoveryCases })) {
  test(`batched DFA scanning agrees with scalar parsing: ${name}`, () => {
    for (const { method, args } of generate())
      assert.deepEqual(parsers.after[method](...args), parsers.before[method](...args));
  });
}
