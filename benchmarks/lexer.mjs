import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { chromium, firefox, webkit } from "@playwright/test";
import {
  scalarTransition,
  batchedTransition,
  characterRun,
} from "@reploom/tests/fixtures/editor/lexer-transition.mjs";
import {
  boundaryCases,
  incrementalCases,
  recoveryCases,
} from "@reploom/tests/fixtures/editor/lexer-cases.mjs";

const require = createRequire(new URL("../packages/ui/package.json", import.meta.url));

const alias = Object.fromEntries(
  ["common", "lr", "javascript", "css", "json"].map((name) => [
    `@lezer/${name}`,
    require.resolve(`@lezer/${name}`).replace(/\.cjs$/, ".js"),
  ]),
);

const bundles = {};
for (const variant of ["before", "after"]) {
  const bundle = await build({
    entryPoints: ["tests/fixtures/editor/lexer.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "lexer",
    alias,
    plugins: [
      {
        name: "lexer-transition",
        setup(build) {
          build.onLoad({ filter: /@lezer\/lr\/dist\/index.js$/ }, async ({ path }) => {
            let source = await readFile(path, "utf8");
            if (source.includes(batchedTransition))
              source = source
                .replace(batchedTransition, scalarTransition)
                .replace(characterRun, "");
            assert.equal(source.split(scalarTransition).length, 2);
            if (variant === "after")
              source = source
                .replace(scalarTransition, batchedTransition)
                .replace(
                  "// Tokenizer data is stored",
                  characterRun + "// Tokenizer data is stored",
                );
            return { contents: source, loader: "js" };
          });
        },
      },
    ],
  });

  bundles[variant] = bundle.outputFiles[0].text;
}

const server = createServer((req, res) => {
  const variant = req.url.slice(1).split(".")[0];
  res.setHeader("content-type", "text/html");
  res.end(`<script>${bundles[variant]}</script>`);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const cases = {
  string: ["js", 'export const text="' + "x".repeat(900000) + '";'],
  comment: ["js", "/*" + "a".repeat(900000) + "*/ const a=1;"],
  identifier: ["js", "const " + "long".repeat(50000) + "=1;"],
  number: ["json", "[" + "7".repeat(200000) + "]"],
  ordinary: [
    "tsx",
    'export function App({value}:{value:number}) {return <div title="한글😀">{[1,2,3].map(x=><b>{x+value}</b>)}</div>}',
  ],
  declarations: [
    "js",
    Array.from({ length: 10000 }, (_, i) => `const value${i} = ${i};`).join("\n"),
  ],
  css: ["css", '.a {content:"' + "x".repeat(300000) + '";}'],
};

const results = {};
try {
  for (const [name, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await launcher.launch();
    const pages = {};
    results[name] = { version: browser.version(), samples: [] };
    try {
      for (const variant of ["before", "after"]) {
        const page = (pages[variant] = await browser.newPage());
        await page.goto(`${origin}/${variant}`);
      }
      const conformance = {};
      for (const [group, generate] of Object.entries({
        boundaryCases,
        incrementalCases,
        recoveryCases,
      })) {
        const commands = generate();
        const answers = {};
        for (const variant of ["before", "after"]) {
          answers[variant] = await pages[variant].evaluate(
            (commands) => commands.map(({ method, args }) => lexer[method](...args)),
            commands,
          );
        }
        assert.deepEqual(answers.after, answers.before, `${name}: ${group}`);
        conformance[group] = commands.length;
      }
      results[name].conformance = conformance;
      for (let round = 0; round < 3; round++)
        for (const [name, [kind, source]] of Object.entries(cases)) {
          for (const variant of round % 2 ? ["after", "before"] : ["before", "after"]) {
            const observation = await pages[variant].evaluate(
              ([kind, source]) => lexer.measure(kind, source, source.length < 1000 ? 1000 : 20),
              [kind, source],
            );

            results[browser.browserType().name()].samples.push({
              name,
              variant,
              round,
              ...observation,
            });
            console.log(browser.browserType().name(), name, variant, round, observation.perParseMs);
          }
        }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  const output = process.argv[2] ?? "artifacts/lexer.json";
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        scope:
          "Three alternating batches per engine, 20 parses per batch after three warmups. Same grammar, input and browser; only generic DFA self-edge scanning differs. No editor, Worker, compiler or paint included.",
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
