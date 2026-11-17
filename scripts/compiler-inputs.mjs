import { readdir } from "node:fs/promises";
import path from "node:path";

export async function compilerInputs(base) {
  const files = [
    "Cargo.toml",
    "Cargo.lock",
    "../../scripts/build-playground-compiler.mjs",
    "../../scripts/compiler-inputs.mjs",
  ];

  async function collect(directory) {
    for (const item of await readdir(path.join(base, directory), { withFileTypes: true })) {
      const file = path.posix.join(directory, item.name);
      if (item.isDirectory()) await collect(file);
      else if (item.isFile()) files.push(file);
    }
  }

  await collect("src");
  await collect("../../vendor");
  return files.sort();
}
