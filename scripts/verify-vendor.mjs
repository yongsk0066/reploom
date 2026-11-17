import { mkdtemp, cp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "reploom-vendor-"));

try {
  for (const manifest of ["oxc-parser.json", "oxc-sourcemap.json"]) {
    const source = JSON.parse(await readFile(path.join(root, "vendor", manifest), "utf8"));
    const relative = path.join("vendor", source.crate);
    const destination = path.join(temporary, relative);
    await cp(path.join(root, relative), destination, { recursive: true });
    for (const patch of [...source.patches].reverse()) {
      execFileSync(
        "git",
        ["apply", "--reverse", "--whitespace=nowarn", path.join(root, "vendor", patch.file)],
        { cwd: temporary },
      );
    }

    const actual = (await readdir(destination, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path
          .relative(destination, path.join(entry.parentPath, entry.name))
          .split(path.sep)
          .join("/"),
      )
      .sort();

    if (JSON.stringify(actual) !== JSON.stringify(Object.keys(source.upstreamFiles).sort())) {
      throw Error(`Vendored inventory differs from ${manifest}`);
    }
    for (const [file, expected] of Object.entries(source.upstreamFiles)) {
      const bytes = await readFile(path.join(destination, file));
      if (createHash("sha256").update(bytes).digest("hex") !== expected) {
        throw Error(`Unrecorded vendor change: ${source.crate}/${file}`);
      }
    }
    console.log(
      `Verified ${source.crate}: upstream source + ${source.patches.length} local patches`,
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
