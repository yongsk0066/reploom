import { readFile } from "node:fs/promises";
import { defineProject } from "@yongsk0066/reploom";

const declarations = [
  {
    id: "react-counter",
    title: "State, forms and JSON",
    runtime: "react",
    entry: "/App.tsx",
    files: ["App.tsx", "settings.json", "style.css"],
    dependencies: { clsx: { version: "2.1.1" } },
  },
  {
    id: "effect-events",
    title: "React Effect Events",
    runtime: "react",
    entry: "/App.tsx",
    files: ["App.tsx"],
  },
  {
    id: "react-lazy",
    title: "Lazy modules and Suspense",
    runtime: "react",
    entry: "/App.tsx",
    files: ["App.tsx", "Panel.tsx"],
  },
  {
    id: "dom-todos",
    title: "DOM forms and state",
    runtime: "dom",
    entry: "/main.ts",
    files: ["main.ts", "style.css", "check.ts"],
    checks: ["/check.ts"],
  },
  {
    id: "dom-canvas",
    title: "Canvas and animation cleanup",
    runtime: "dom",
    entry: "/main.ts",
    files: ["main.ts"],
  },
  {
    id: "dom-assets",
    title: "Declared local assets",
    runtime: "dom",
    entry: "/main.ts",
    files: ["main.ts"],
    resources: { assets: { "/icon.svg": { url: "/dom-assets/icon.svg", type: "image/svg+xml" } } },
  },
  {
    id: "module-lifecycle",
    title: "Module cleanup and hot data",
    runtime: "dom",
    entry: "/main.ts",
    files: ["main.ts", "ticker.ts"],
  },
  {
    id: "compute-statistics",
    title: "Worker data aggregation",
    runtime: "compute",
    entry: "/main.ts",
    files: ["main.ts", "data.json"],
  },
  {
    id: "compute-fractal",
    title: "Worker fractal computation",
    runtime: "compute",
    entry: "/main.ts",
    files: ["main.ts"],
  },
];

export const projects = await Promise.all(
  declarations.map(async (declaration) =>
    defineProject({
      ...declaration,
      files: Object.fromEntries(
        await Promise.all(
          declaration.files.map(async (file) => [
            "/" + file,
            await readFile(new URL(`./${declaration.id}/${file}`, import.meta.url), "utf8"),
          ]),
        ),
      ),
    }),
  ),
);
