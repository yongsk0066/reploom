import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const files = (await readdir("artifacts/packages")).filter((file) => file.endsWith(".tgz"));
assert.equal(files.length, 3);
for (const directory of ["runtime", "ui", "build"]) {
  const pkg = JSON.parse(await readFile(`packages/${directory}/package.json`, "utf8"));
  assert.equal(pkg.version, process.env.RELEASE_VERSION);
  assert.equal(pkg.publishConfig.registry, "https://npm.pkg.github.com");

  const archive = files.find(
    (file) => file === pkg.name.replace("@", "").replace("/", "-") + "-" + pkg.version + ".tgz",
  );

  assert.ok(archive, `Missing ${pkg.name}`);

  const packed = JSON.parse(
    execFileSync("tar", ["-xOzf", `artifacts/packages/${archive}`, "package/package.json"], {
      encoding: "utf8",
    }),
  );

  assert.equal(packed.name, pkg.name);
  assert.equal(packed.version, pkg.version);
  assert.equal(packed.publishConfig.registry, pkg.publishConfig.registry);
}
console.log("Verified three matching private-registry release artifacts");
