import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const privateDirectories =
  /^(?:\.local|provenance|artifacts|test-results|playwright-report|coverage|docs\/drafts)\//;

const rules = [
  ["home directory", /\/(?:Users|home)\/[\w.-]+\//],
  ["temporary user directory", /\/(?:private\/)?var\/folders\/[\w/-]+/],
  ["Windows user directory", /[A-Z]:\\Users\\[\w.-]+\\/i],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["credential", /\b(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_]{20,}/],
  ["article source directory", /src\/content\/blog\//],
];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const failures = [];
let scanned = 0;
let compressed = 0;
for (const file of files) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  scanned++;
  if (privateDirectories.test(file)) failures.push(`${file}: development-only directory`);
  if (file.endsWith(".gz")) {
    bytes = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
    compressed++;
  }
  const text = bytes.toString("utf8");
  for (const [name, pattern] of rules) if (pattern.test(text)) failures.push(`${file}: ${name}`);
}
if (failures.length) throw new Error(`Publication audit failed:\n${failures.join("\n")}`);
console.log(
  `Publication audit passed: ${scanned} tracked files, ${compressed} compressed files expanded; binary content included.`,
);
