import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
test("Rust module factories match native ESM for generated bindings, receivers, cycles, async imports and Unicode", async () => {
  const { stdout } = await exec(
    process.execPath,
    [
      "--experimental-vm-modules",
      new URL("../fixtures/runtime/esm-differential.mjs", import.meta.url).pathname,
    ],
    { timeout: 20000 },
  );

  assert.equal(JSON.parse(stdout).passed, 37);
});
