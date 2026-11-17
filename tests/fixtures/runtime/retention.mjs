import { reactConfig, reactPolicy } from "../project-fixtures.mjs";
// A real Refresh signature is essential: a hook-free App or a no-op signature
// cannot reproduce the closure chain that retained every replaced module.
import { compileFunction } from "node:vm";
import { compilerEngine as oxc } from "../compiler/engine.mjs";
import React from "react";
import RefreshRuntime from "react-refresh/runtime";
import * as JSXDevRuntime from "react/jsx-dev-runtime";
import { createProjectCompiler } from "../../../packages/runtime/src/compiler/project-compiler.ts";
import { createModuleRuntime } from "../../../packages/runtime/src/execution/module-runtime.ts";

const compiler = createProjectCompiler(oxc, reactConfig);

const apps = [];
const factories = [];
const programs = [];

const runtime = createModuleRuntime(
  reactPolicy({ React, JSXDevRuntime, RefreshRuntime }),
  ({ id, code }) => {
    const factory = compileFunction(`return (${code}\n)`)();
    if (id === "/App.js") factories.push(new WeakRef(factory));
    return factory;
  },
);

async function edit(revision) {
  const program = compiler.compile({
    "/App.js": `import {useState} from 'react'; import {value} from './stable.js';
export default function App(){const [n,set]=useState(value); return <h1>${revision} {n}</h1>;}`,
    // An unchanged namespace used to retain the first evaluation's entire
    // graph and its replaced App, even though only its live binding is needed.
    "/stable.js": "export {value} from './value.js';",
    "/value.js": "export const value = 0;",
  });

  programs.push(new WeakRef(program));
  const { entry, registrations } = await runtime.apply(program, () => {});
  apps.push(new WeakRef(entry.default));
  for (const [type, id] of registrations) RefreshRuntime.register(type, id);
  RefreshRuntime.performReactRefresh();
}

async function collectUntil(settled) {
  // Dereferencing also keeps targets alive until the next job; wait before every collection.
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    await globalThis.gc({ type: "major", execution: "async" });
    if (settled()) return;
  }
}

const live = (refs) => refs.filter((ref) => ref.deref()).length;
for (let i = 0; i < 160; i++) await edit(i);
await collectUntil(() => live(apps) === 1 && live(factories) === 1 && live(programs) === 1);

const result = {
  revisions: apps.length,
  liveApps: apps.filter((ref) => ref.deref()).length,
  liveFactories: factories.filter((ref) => ref.deref()).length,
  livePrograms: programs.filter((ref) => ref.deref()).length,
};

await runtime.dispose();
compiler.dispose();
await collectUntil(() => live(programs) === 0);
console.log(
  JSON.stringify({
    ...result,
    disposedPrograms: programs.filter((ref) => ref.deref()).length,
  }),
);
