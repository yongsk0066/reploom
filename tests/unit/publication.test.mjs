import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const script = fileURLToPath(new URL("../../scripts/audit-publication.mjs", import.meta.url));

async function audit(t, files) {
  const directory = await mkdtemp(join(tmpdir(), "reploom-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", directory]);
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), bytes);
  }
  execFileSync("git", ["add", "."], { cwd: directory });
  return spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
}

test("publication audit preserves public attribution and portable paths", async (t) => {
  const result = await audit(t, {
    LICENSE: "Copyright Example Authors <authors@example.org>",
    "manifest.json": '{"source":"src/compiler.rs","origin":"https://example.org/source"}',
    "compiler.wasm": Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 tracked files/);
});

test("publication audit examines compressed data and binary strings", async (t) => {
  const privatePath = ["", "Users", "contributor", "workspace", "source.rs"].join("/");

  const result = await audit(t, {
    "compiler.wasm": Buffer.concat([Buffer.from([0, 97, 115, 109]), Buffer.from(privatePath)]),
    "profile.json.gz": gzipSync(JSON.stringify({ path: privatePath })),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /compiler.wasm: home directory/);
  assert.match(result.stderr, /profile.json.gz: home directory/);
  assert.equal(result.stderr.includes(privatePath), false);
});

test("publication audit rejects force-added development output", async (t) => {
  const result = await audit(t, { ".local/notes.md": "Local note", "artifacts/result.json": "{}" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /development-only directory/);
});

test("publication audit reports credential locations without printing their values", async (t) => {
  const token = ["ghp", "x".repeat(36)].join("_");
  const key = ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ");
  const result = await audit(t, { "config.txt": token, "key.txt": key });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /config.txt: credential/);
  assert.match(result.stderr, /key.txt: private key/);
  assert.equal(result.stderr.includes(token), false);
  assert.equal(result.stderr.includes(key), false);
});
