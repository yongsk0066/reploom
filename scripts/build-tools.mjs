import { cp, mkdir, chmod, rm } from "node:fs/promises";

const out = new URL("../packages/build/dist/", import.meta.url);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const name of [
  "prepare.mjs",
  "vendor.mjs",
  "cli.mjs",
  "index.d.ts",
  "typecheck.mjs",
  "typecheck-worker.mjs",
  "typecheck-files.mjs",
  "typecheck-diagnostics.mjs",
])
  await cp(new URL(`../packages/build/src/${name}`, import.meta.url), new URL(name, out));
await chmod(new URL("cli.mjs", out), 0o755);
