import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compilerInputs } from "./compiler-inputs.mjs";

const base = fileURLToPath(new URL("../crates/compiler/", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(base, "artifacts/manifest.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (
  JSON.stringify(await compilerInputs(base)) !==
  JSON.stringify(Object.keys(manifest.sources).sort())
)
  throw new Error("Compiler source inventory changed. Run pnpm compiler:build.");
for (const [file, hash] of Object.entries({
  ...manifest.sources,
  "artifacts/compiler.wasm": manifest.sha256,
})) {
  if (digest(await readFile(path.join(base, file))) !== hash)
    throw new Error(`Compiler artifact is stale: ${file}. Run pnpm compiler:build.`);
}
console.log(`Verified compiler ABI ${manifest.hostABI}, ${manifest.bytes} bytes`);
