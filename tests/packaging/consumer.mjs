import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, cp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packPackages } from "../../scripts/pack.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const consumer = await mkdtemp(path.join(os.tmpdir(), "reploom-consumer-"));
try {
  const packages = await packPackages();

  const dependencies = Object.fromEntries(
    await Promise.all(
      ["runtime", "ui", "build"].map(async (name) => {
        const pkg = JSON.parse(
          await readFile(path.join(root, "packages", name, "package.json"), "utf8"),
        );

        const file = packages.find(
          (file) =>
            path.basename(file) ===
            pkg.name.replace("@", "").replace("/", "-") + "-" + pkg.version + ".tgz",
        );

        if (!file) throw new Error(`Missing packed package: ${pkg.name}`);
        return [pkg.name, `file:${file}`];
      }),
    ),
  );

  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify(
      { name: "reploom-isolated-consumer", private: true, type: "module", dependencies },
      null,
      2,
    ),
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: consumer,
    stdio: "pipe",
  });
  await cp(path.join(root, "tests/consumer"), consumer, { recursive: true });
  execFileSync("node", ["build.mjs"], { cwd: consumer, stdio: "inherit" });
  await cp(path.join(consumer, "dist"), path.join(root, "artifacts/browser-site/headless"), {
    recursive: true,
  });
  console.log(
    "Packed consumer passed: Node import, independent headless builds, nested asset bases, isolated CodeMirror/language Worker exports; fixtures ready for browser tests",
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
