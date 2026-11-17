// Native ESM is the behavioral oracle. Expected values are evaluated independently of the linker.
import vm from "node:vm";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createEngine } from "../../../crates/compiler/engine.mjs";
import { createProjectCompiler } from "../../../packages/runtime/src/compiler/project-compiler.ts";
import { createModuleRuntime } from "../../../packages/runtime/src/execution/module-runtime.ts";
import { createModulePolicy } from "../../../packages/runtime/src/execution/adapters/policy.ts";

const engine = createEngine(
  await WebAssembly.compile(
    fs.readFileSync(new URL("../../../crates/compiler/artifacts/compiler.wasm", import.meta.url)),
  ),
);

const config = {
  key: "differential",
  entry: "/main.js",
  runtime: "dom",
  styles: [],
  imports: {},
  dependencyFiles: {},
};

const normalize = (value) => JSON.parse(JSON.stringify(value));
const cases = [];
for (let seed = 1; seed <= 32; seed++) {
  const name = seed % 2 ? "값" : "value";
  const n = (seed * 1664525 + 1013904223) >>> 0;
  const k = n % 997;

  const base = `export let ${name}=${k}; export function bump(){return ++${name}}; export function receiver(){return this===undefined}; export default ${seed};`;

  const bodies = [
    `bump(); const o={${name}}; export const result=[${name},o.${name},receiver(),receiver?.(),(() => ${name})()];`,
    `function shadow(${name}) {try {throw ${name}+1} catch(${name}) {return ${name}}} export const result=[shadow(5),${name},({m(){return receiver()}}).m()];`,
    `const {x=${name},y:alias=def}={}; export const result=[x,alias,receiver\`x\`,(0,receiver)()];`,
    `const fn=async()=>{await Promise.resolve();bump();return ${name}}; export const result=[await fn(),${name},typeof arguments,(() => typeof arguments)()];`,
    `function* g(){yield ${name};bump();yield ${name}}; export const result=[...g(),def];`,
    `class Box {constructor(){this.x=${name}} m(){return [this.x,${name},receiver()]}} bump(); export const result=new Box().m();`,
    `const lazy=await import('./base.js');bump();export const result=[lazy.${name},${name},lazy.receiver(),lazy===await import('./base.js')];`,
    `const {renamed}=await import('./reexport.js');export const result=[renamed,${name},def];`,
  ];

  cases.push({
    name: "generated-" + seed,
    files: {
      "/base.js": base,
      "/reexport.js": `export {${name} as renamed} from './base.js';export * as ns from './base.js';`,
      "/main.js":
        `import def,{${name},bump,receiver} from './base.js';\n` +
        bodies[(seed - 1) % bodies.length],
    },
  });
}
for (const [name, files] of Object.entries({
  namespaces: {
    "/base.js": "export let value=1;export function bump(){value++}",
    "/other.js": "export const lazy=await import('./base.js');",
    "/main.js":
      "import {lazy} from './other.js';const same=await import('./base.js');same.bump();export const result=[lazy===same,same===await import('./base.js'),lazy.value]",
  },
  cycles: {
    "/a.js":
      "import {read} from './b.js';export let a=3;export function get(){return a};export const out=read();",
    "/b.js": "import {get} from './a.js';export function read(){return get()+1}",
    "/main.js": "import {out} from './a.js';export const result=out",
  },
  stars: {
    "/a.js": "export const x=1;export default 9",
    "/b.js": "export * from './a.js';export const y=2",
    "/main.js":
      "import * as ns from './b.js';export const result=[Object.keys(ns).sort(),ns.x,ns.y]",
  },
  defaults: {
    "/a.js": "export default function(){return 3}",
    "/b.js": "export default class {value=7}",
    "/main.js":
      "import a from './a.js';import B from './b.js';export const result=[a(),new B().value]",
  },
  unicode: {
    "/a.js": 'export const 한글="😀\\u0000\\ud800";',
    "/main.js":
      'import {한글} from "./a.js";export const result=[한글,한글.length,JSON.stringify(한글)]',
  },
}))
  cases.push({ name, files });

async function native(files) {
  const context = vm.createContext({});
  const modules = new Map();

  const get = (id) => {
    if (!modules.has(id))
      modules.set(
        id,
        new vm.SourceTextModule(files[id], {
          context,
          identifier: id,
          importModuleDynamically: async (spec, ref) => {
            const module = get(new URL(spec, "https://project.invalid" + ref.identifier).pathname);
            if (module.status === "unlinked") await module.link(link);
            if (module.status === "linked") await module.evaluate();
            return module;
          },
        }),
      );
    return modules.get(id);
  };

  const link = (spec, ref) =>
    get(new URL(spec, "https://project.invalid" + ref.identifier).pathname);

  const entry = get("/main.js");
  await entry.link(link);
  await entry.evaluate();
  return normalize(entry.namespace.result);
}

async function local(files) {
  const context = vm.createContext({});
  const compiler = createProjectCompiler(engine, config);

  const runtime = createModuleRuntime(createModulePolicy({}), ({ code }) =>
    vm.runInContext("(" + code + ")", context),
  );

  try {
    const result = await runtime.apply(compiler.compile(files), () => {});
    return normalize(result.entry.result);
  } finally {
    await runtime.dispose();
    compiler.dispose();
  }
}

const passed = [];
for (const row of cases) {
  const expected = await native(row.files);
  const actual = await local(row.files);

  assert.deepEqual(actual, expected, row.name);
  passed.push(row.name);
}
console.log(JSON.stringify({ passed: passed.length, cases: passed }));
