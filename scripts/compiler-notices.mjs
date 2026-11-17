// Resolve notices from the locked Cargo graph. Missing crate-archive notices
// are fetched from that crate's recorded upstream commit, never a moving branch.
import { execFileSync } from "node:child_process";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));

const metadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--format-version=1",
      "--filter-platform",
      "wasm32-unknown-unknown",
      "--manifest-path",
      "crates/compiler/Cargo.toml",
    ],
    { cwd: root, encoding: "utf8" },
  ),
);

const ids = new Set(metadata.resolve.nodes.map((node) => node.id));

const cache = new Map();
const groups = new Map();
const sources = [];

for (const pkg of metadata.packages
  .filter((pkg) => pkg.name !== "playground-compiler" && ids.has(pkg.id))
  .sort((a, b) => a.name.localeCompare(b.name))) {
  const dir = path.dirname(pkg.manifest_path);
  let names = (await readdir(dir, { withFileTypes: true }))
    .filter((item) => item.isFile() && /^(license|licence|copying|notice)/i.test(item.name))
    .map((item) => item.name)
    .sort();
  let notice;
  if (names.length) {
    notice = (await Promise.all(names.map((name) => readFile(path.join(dir, name), "utf8")))).join(
      "\n\n",
    );
  } else {
    const commit = pkg.source?.startsWith("git+")
      ? new URL(pkg.source.slice(4)).hash.slice(1)
      : JSON.parse(await readFile(path.join(dir, ".cargo_vcs_info.json"), "utf8")).git.sha1;

    const repo = new URL(pkg.repository);
    if (repo.hostname !== "github.com" || !/^[a-f0-9]{40}$/.test(commit))
      throw new Error(`Unsupported license source: ${pkg.name}`);
    const base = `https://raw.githubusercontent.com${repo.pathname.replace(/\.git$/, "")}/${commit}/`;
    if (!cache.has(base)) {
      let found;
      for (const name of ["LICENSE", "LICENSE-MIT", "LICENSE.md"]) {
        const url = base + name;
        const response = await fetch(url);

        if (response.ok) {
          found = { url, text: await response.text() };
          break;
        }
        if (response.status !== 404)
          throw new Error(`License fetch failed: ${response.status} ${url}`);
      }
      if (!found) throw new Error(`Missing upstream notice: ${pkg.name}`);
      cache.set(base, found);
      sources.push({
        url: found.url,
        sha256: createHash("sha256").update(found.text).digest("hex"),
      });
    }
    notice = cache.get(base).text;
  }
  notice = notice.replace(/\r\n?/g, "\n");
  const key = createHash("sha256").update(notice).digest("hex");
  if (!groups.has(key)) groups.set(key, { notice, packages: [] });
  groups.get(key).packages.push(`${pkg.name}@${pkg.version} (${pkg.license})`);
}
const out = path.join(root, "crates/compiler/artifacts");
await mkdir(out, { recursive: true });
await writeFile(
  path.join(out, "THIRD_PARTY_NOTICES.txt"),
  "Compiler dependency notices\nIncludes build-time and runtime crates from the locked WASM dependency graph.\n\n" +
    [...groups.values()]
      .map((group) => group.packages.join("\n") + "\n\n" + group.notice)
      .join("\n\n--------------------\n\n"),
);
await writeFile(path.join(out, "license-sources.json"), JSON.stringify(sources, null, 2) + "\n");
console.log(
  `Collected notices for ${[...groups.values()].reduce((n, group) => n + group.packages.length, 0)} crates`,
);
