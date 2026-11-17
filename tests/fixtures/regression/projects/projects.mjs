import { readFile } from "node:fs/promises";
import { defineProject } from "@yongsk0066/reploom";

const root = new URL("./", import.meta.url);
async function files(directory, paths) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([virtual, source]) => [
        virtual,
        await readFile(new URL(`${directory}/${source}`, root), "utf8"),
      ]),
    ),
  );
}
const effects = [
  { id: "react-effect-dependencies", title: "Effect dependency updates" },
  { id: "react-stale-closure", title: "Stale effect closure" },
  { id: "react-effect-events", title: "Effect Events and fresh state" },
];
const effectProjects = await Promise.all(
  effects.map(async ({ id, title }) =>
    defineProject({
      id,
      title,
      runtime: "react",
      entry: "/App.js",
      files: await files(id, {
        "/App.js": "App.jsx",
        "/connection.js": "connection.js",
        "/notifications.js": "notifications.js",
        "/styles.css": "styles.css",
      }),
      styles: ["/styles.css"],
      dependencies: {
        "toastify-js": { version: "1.12.0" },
        "toastify-js/src/toastify.css": { version: "1.12.0", kind: "css" },
      },
    }),
  ),
);
export const projects = [
  ...effectProjects,
  defineProject({
    id: "react-counter",
    title: "React with TypeScript and packages",
    runtime: "react",
    entry: "/src/Dashboard.tsx",
    dependencies: { clsx: { version: "2.1.1" } },
    files: await files("react-counter", {
      "/src/Dashboard.tsx": "Dashboard.tsx",
      "/src/counter.ts": "counter.ts",
      "/src/settings.json": "settings.json",
      "/src/dashboard.css": "dashboard.css",
    }),
  }),
  defineProject({
    id: "dom-counter",
    title: "DOM lifecycle and state",
    runtime: "dom",
    entry: "/main.ts",
    files: await files("dom-counter", {
      "/main.ts": "main.ts",
      "/format.ts": "format.ts",
      "/theme.css": "theme.css",
    }),
  }),
  defineProject({
    id: "compute-primes",
    title: "Worker prime calculation",
    runtime: "compute",
    dependencies: { clsx: { version: "2.1.1" } },
    entry: "/main.ts",
    execution: { timeoutMs: 2000 },
    files: await files("compute-primes", {
      "/main.ts": "main.ts",
      "/primes.ts": "primes.ts",
      "/settings.json": "settings.json",
    }),
  }),
];
