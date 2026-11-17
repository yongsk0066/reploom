import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Refresh and unchanged imports release replaced module evaluations and their graphs", () => {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      ["--expose-gc", fileURLToPath(new URL("../fixtures/runtime/retention.mjs", import.meta.url))],
      { encoding: "utf8", timeout: 20_000 },
    ),
  );

  assert.equal(result.revisions, 160);
  assert.equal(result.liveApps, 1, JSON.stringify(result));
  assert.equal(result.liveFactories, 1, JSON.stringify(result));
  assert.equal(result.livePrograms, 1, JSON.stringify(result));
  assert.equal(result.disposedPrograms, 0, JSON.stringify(result));
});
