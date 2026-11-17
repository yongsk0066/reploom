import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export async function packPackages() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const out = path.join(root, "artifacts/packages");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const name of ["runtime", "ui", "build"])
    execFileSync("pnpm", ["pack", "--pack-destination", out], {
      cwd: path.join(root, "packages", name),
      stdio: "pipe",
    });
  return (await readdir(out))
    .filter((name) => name.endsWith(".tgz"))
    .sort()
    .map((name) => path.join(out, name));
}

if (import.meta.main) console.log((await packPackages()).join("\n"));
