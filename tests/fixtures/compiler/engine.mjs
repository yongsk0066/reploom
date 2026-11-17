import { readFile } from "node:fs/promises";
import { createEngine } from "../../../crates/compiler/engine.mjs";

const module = await WebAssembly.compile(
  await readFile(new URL("../../../crates/compiler/artifacts/compiler.wasm", import.meta.url)),
);

export const compilerEngine = createEngine(module);
