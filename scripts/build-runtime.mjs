import "./verify-compiler.mjs";
import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await rm(new URL("../packages/runtime/dist/", import.meta.url), { recursive: true, force: true });
await rm(new URL("../packages/runtime/compiler/", import.meta.url), {
  recursive: true,
  force: true,
});
execFileSync("pnpm", ["exec", "tsc", "-p", "packages/runtime/tsconfig.json"], {
  cwd: root,
  stdio: "inherit",
});
const compiler = new URL("../packages/runtime/compiler/", import.meta.url);
await mkdir(compiler, { recursive: true });
for (const file of [
  "compiler.wasm",
  "manifest.json",
  "THIRD_PARTY_NOTICES.txt",
  "license-sources.json",
])
  await cp(
    new URL(`../crates/compiler/artifacts/${file}`, import.meta.url),
    new URL(file, compiler),
  );
await cp(
  new URL("../crates/compiler/engine.mjs", import.meta.url),
  new URL("engine.mjs", compiler),
);
